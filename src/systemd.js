// The D-Bus client of the routines: reads the user's systemd timers and their services over a
// connection of its own to the session bus, and keeps the watched ones up to date. Shared by the
// extension (which watches) and the preferences (which read once). Never writes: no unit is
// created, edited, enabled, disabled, or stopped.

import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

const BUS_NAME = 'org.freedesktop.systemd1';
const MANAGER_PATH = '/org/freedesktop/systemd1';
const MANAGER = BUS_NAME + '.Manager';
const PROPERTIES = 'org.freedesktop.DBus.Properties';
const CALL_TIMEOUT_MS = 5000;
const THROTTLE_MS = 1000;
const POLL_SECONDS = 30;

/** An async step nobody awaits: an unexpected failure is logged, never an unhandled rejection. */
function reportFailure(promise) {
    promise.catch(error => console.error('Greenlight: routines: ' + error));
}

/** The message of a D-Bus error, without GDBus's `GDBus.Error:<name>: ` prefix. */
export function errorMessage(error) {
    const copy = new GLib.Error(error.domain ?? Gio.IOErrorEnum, error.code ?? 0,
        error.message ?? String(error));
    try {
        Gio.DBusError.strip_remote_error(copy);
    } catch {
        // Not a remote error: the message stays as it is.
    }
    return copy.message || String(error);
}

/** Opens a connection of its own to the session bus, which the caller closes. */
function openConnection(cancellable) {
    const address = Gio.dbus_address_get_for_bus_sync(Gio.BusType.SESSION, null);
    return new Promise((resolve, reject) => {
        Gio.DBusConnection.new_for_address(
            address,
            Gio.DBusConnectionFlags.AUTHENTICATION_CLIENT | Gio.DBusConnectionFlags.MESSAGE_BUS_CONNECTION,
            null,
            cancellable,
            (_source, result) => {
                try {
                    resolve(Gio.DBusConnection.new_for_address_finish(result));
                } catch (error) {
                    reject(error);
                }
            }
        );
    });
}

function closeConnection(connection) {
    connection.close(null, (source, result) => {
        try {
            source.close_finish(result);
        } catch {
            // Already closed.
        }
    });
}

/** One asynchronous call to systemd, with the timeout of the spec unless another is given. */
function call(connection, path, interfaceName, member, parameters, replyType, cancellable,
    timeout = CALL_TIMEOUT_MS) {
    return new Promise((resolve, reject) => {
        connection.call(
            BUS_NAME, path, interfaceName, member, parameters, new GLib.VariantType(replyType),
            Gio.DBusCallFlags.NO_AUTO_START, timeout, cancellable,
            (source, result) => {
                try {
                    resolve(source.call_finish(result));
                } catch (error) {
                    reject(error);
                }
            }
        );
    });
}

/** `GetAll` of one interface, as its `a{sv}` dictionary. */
async function getAll(connection, path, interfaceName, cancellable) {
    const reply = await call(connection, path, PROPERTIES, 'GetAll',
        new GLib.Variant('(s)', [interfaceName]), '(a{sv})', cancellable);
    return reply.get_child_value(0);
}

// A property of an a{sv} dictionary. A uint64 goes through its printed text: deepUnpack() warns
// for 2^64 - 1, which systemd uses for an unset deadline.
const text = (dictionary, name) => dictionary.lookup_value(name, null)?.get_string()[0] ?? '';
const integer = (dictionary, name) => dictionary.lookup_value(name, null)?.get_int32() ?? 0;
const flag = (dictionary, name) => dictionary.lookup_value(name, null)?.get_boolean() ?? false;
const microseconds = (dictionary, name) => {
    const value = dictionary.lookup_value(name, null);
    return value ? Number(value.print(false)) : 0;
};

/** Reads the timer and its service. A service systemd does not load comes back as null. */
async function readUnit(connection, entry, cancellable, hooks) {
    const [unit, description, , , , , timerPath] = entry;
    hooks?.path(timerPath);
    const [timerProperties, timerUnit] = await Promise.all([
        getAll(connection, timerPath, BUS_NAME + '.Timer', cancellable),
        getAll(connection, timerPath, BUS_NAME + '.Unit', cancellable),
    ]);
    const serviceName = text(timerProperties, 'Unit');
    if (!serviceName.endsWith('.service'))
        return null;
    const timer = {
        unit: serviceName,
        nextRealtime: microseconds(timerProperties, 'NextElapseUSecRealtime'),
        nextMonotonic: microseconds(timerProperties, 'NextElapseUSecMonotonic'),
        result: text(timerProperties, 'Result'),
        activeState: text(timerUnit, 'ActiveState'),
        stateChange: microseconds(timerUnit, 'StateChangeTimestamp'),
        stateChangeMonotonic: microseconds(timerUnit, 'StateChangeTimestampMonotonic'),
    };

    hooks?.unit(serviceName);

    let servicePath = null;
    try {
        servicePath = (await call(connection, MANAGER_PATH, MANAGER, 'GetUnit',
            new GLib.Variant('(s)', [serviceName]), '(o)', cancellable)).deepUnpack()[0];
    } catch (error) {
        // systemd answering that it has no such unit is the only way a service is not loaded: a
        // timeout or a closed connection is a failed read, which keeps the last state.
        if (!Gio.DBusError.is_remote_error(error))
            throw error;
    }
    let service = null;
    if (servicePath !== null) {
        hooks?.path(servicePath);
        const [serviceProperties, serviceUnit] = await Promise.all([
            getAll(connection, servicePath, BUS_NAME + '.Service', cancellable),
            getAll(connection, servicePath, BUS_NAME + '.Unit', cancellable),
        ]);
        service = {
            result: text(serviceProperties, 'Result'),
            execMainCode: integer(serviceProperties, 'ExecMainCode'),
            execMainStatus: integer(serviceProperties, 'ExecMainStatus'),
            execMainStart: microseconds(serviceProperties, 'ExecMainStartTimestamp'),
            activeState: text(serviceUnit, 'ActiveState'),
            subState: text(serviceUnit, 'SubState'),
            inactiveExit: microseconds(serviceUnit, 'InactiveExitTimestamp'),
            stateChange: microseconds(serviceUnit, 'StateChangeTimestamp'),
            stateChangeMonotonic: microseconds(serviceUnit, 'StateChangeTimestampMonotonic'),
            conditionResult: flag(serviceUnit, 'ConditionResult'),
            conditionTimestamp: microseconds(serviceUnit, 'ConditionTimestamp'),
        };
    }
    return {raw: {unit, description, timer, service}, timerPath, servicePath};
}

/**
 * Reads the timers that match `patterns` (`['*.timer']` for all of them) that activate a
 * service. Returns one entry per timer, `{unit, raw, timerPath, servicePath}` when it read or
 * `{unit, error, timerPath}` when its own read failed; rejects when the timer list itself cannot
 * be read. `hooks` (optional) hears each object path (`path`) and service unit name (`unit`) as
 * soon as it is known, before its properties are read, so a listener can exist before the read.
 */
export async function readTimers(connection, patterns, cancellable, hooks = null) {
    const reply = await call(connection, MANAGER_PATH, MANAGER, 'ListUnitsByPatterns',
        new GLib.Variant('(asas)', [[], patterns]), '(a(ssssssouso))', cancellable);
    const entries = reply.get_child_value(0).deepUnpack();
    const results = await Promise.all(entries.map(async entry => {
        const unit = entry[0];
        try {
            const read = await readUnit(connection, entry, cancellable, hooks);
            return read && {unit, ...read};
        } catch (error) {
            if (cancellable?.is_cancelled())
                throw error;
            return {unit, error: errorMessage(error), timerPath: entry[6]};
        }
    }));
    return results.filter(Boolean);
}

/**
 * Reads every timer once, over a connection of its own, without `Subscribe()`: the preferences'
 * list. Rejects when systemd cannot be read.
 */
export async function readAllTimers(cancellable) {
    const connection = await openConnection(cancellable);
    try {
        return await readTimers(connection, ['*.timer'], cancellable);
    } finally {
        closeConnection(connection);
    }
}

/**
 * Keeps the watched routines up to date. `onChange` runs after every change of what it holds:
 * `routines` (unit to `{raw, stale}`), `firstRead`, `error` (the cause of the last failed read),
 * and `noOwner` (systemd's bus name has no owner). The connection to the session bus, the
 * `Subscribe()`, and every listener exist only while at least one routine is watched.
 */
export class RoutineWatcher {
    constructor(onChange) {
        this._onChange = onChange;
        this._watched = [];
        // Never reset: a late reply compares it with the value it started with.
        this._generation = 0;
        this._ownerEpoch = 0;
        this._reset();
    }

    _reset() {
        this.routines = new Map();
        this.firstRead = false;
        this.error = null;
        this.noOwner = false;
        this._connection = null;
        this._session = null;
        this._readCancellable = null;
        this._reading = false;
        this._queued = false;
        this._throttleId = 0;
        this._pollId = 0;
        this._nameWatchId = 0;
        this._managerSignals = [];
        this._pathSignals = new Map();
        this._relevant = new Set();
        // Per watched timer, the object paths of its timer and service that it listens to.
        this._unitPaths = new Map();
    }

    get watched() {
        return this._watched;
    }

    /** Sets the watched timer units. The first one opens the connection, the last one closes it. */
    setWatched(units) {
        const same = units.length === this._watched.length &&
            units.every(unit => this._watched.includes(unit));
        if (same)
            return;
        this._watched = [...units];
        if (units.length === 0) {
            this._close();
            this._onChange();
            return;
        }
        if (!this._session) {
            reportFailure(this._open());
            return;
        }
        // The list changed: a read in flight answers for the old one.
        for (const unit of [...this.routines.keys()]) {
            if (!units.includes(unit))
                this.routines.delete(unit);
        }
        for (const unit of [...this._unitPaths.keys()]) {
            if (!units.includes(unit))
                this._unitPaths.delete(unit);
        }
        for (const unit of units)
            this._relevant.add(unit);
        this._syncSubscriptions();
        this._invalidate();
        if (this._connection && !this.noOwner)
            reportFailure(this._read());
        this._onChange();
    }

    /** Reads again, as when the menu opens; a connection that failed to open is tried again. */
    refresh() {
        if (this._watched.length > 0 && !this._session)
            reportFailure(this._open());
        else if (this._connection && !this.noOwner)
            this._request();
    }

    destroy() {
        this._watched = [];
        this._close();
    }

    async _open() {
        const session = {cancellable: new Gio.Cancellable()};
        this._session = session;
        let connection;
        try {
            connection = await openConnection(session.cancellable);
        } catch (error) {
            if (this._session !== session)
                return;
            // No connection: the next menu opening, or a new watched list, tries again.
            this._session = null;
            this.firstRead = true;
            this.error = errorMessage(error);
            this._onChange();
            return;
        }
        if (this._session !== session) {
            closeConnection(connection);
            return;
        }
        this._connection = connection;
        session.closedId = connection.connect('closed', (_connection, remotePeerVanished, error) => {
            if (this._session !== session || this._connection !== connection)
                return;
            // Not closed by Greenlight: nothing more can be read.
            this._invalidate();
            this._markStale();
            this.error = error ? errorMessage(error) : 'The session bus closed';
            this.firstRead = true;
            this._onChange();
        });
        const manager = (signal, callback) => connection.signal_subscribe(
            BUS_NAME, MANAGER, signal, MANAGER_PATH, null, Gio.DBusSignalFlags.NONE,
            (_c, _sender, _path, _interface, _signal, parameters) => {
                if (this._session === session)
                    callback(parameters);
            });
        const unitSignal = parameters => {
            if (this._relevant.has(parameters.get_child_value(0).get_string()[0]))
                this._request();
        };
        this._managerSignals = [
            manager('UnitNew', unitSignal),
            manager('UnitRemoved', unitSignal),
            // A reload makes every unit path and property suspect.
            manager('Reloading', () => this._request()),
        ];
        this._nameWatchId = Gio.bus_watch_name_on_connection(
            connection, BUS_NAME, Gio.BusNameWatcherFlags.NONE,
            () => reportFailure(this._onOwner(session, true)),
            () => reportFailure(this._onOwner(session, false)));
    }

    async _onOwner(session, present) {
        if (this._session !== session)
            return;
        this._invalidate();
        const epoch = ++this._ownerEpoch;
        if (!present) {
            this.noOwner = true;
            this._stopPolling();
            this._markStale();
            this._onChange();
            return;
        }
        this.noOwner = false;
        let subscribed = true;
        try {
            await call(this._connection, MANAGER_PATH, MANAGER, 'Subscribe', null, '()', session.cancellable);
        } catch {
            subscribed = false;
        }
        // Another owner came, or the watcher closed, while Subscribe() ran: that one answers for itself.
        if (this._session !== session || this._ownerEpoch !== epoch)
            return;
        if (subscribed) {
            this._stopPolling();
        } else {
            // Without a subscription nothing announces a change: poll, and keep the rows fresh.
            this._startPolling();
        }
        // Reads from here on are covered by the subscription: read the state it starts from.
        reportFailure(this._read());
        this._onChange();
    }

    /** Everything in flight answers for a state that no longer holds. */
    _invalidate() {
        this._generation++;
        this._readCancellable?.cancel();
        this._readCancellable = null;
        this._reading = false;
        this._queued = false;
    }

    _markStale() {
        for (const routine of this.routines.values())
            routine.stale = true;
    }

    _startPolling() {
        if (this._pollId)
            return;
        this._pollId = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, POLL_SECONDS, () => {
            this._request();
            return GLib.SOURCE_CONTINUE;
        });
    }

    _stopPolling() {
        if (this._pollId)
            GLib.Source.remove(this._pollId);
        this._pollId = 0;
    }

    /** Reads at most once per second: a request in the window reads at its end. */
    _request() {
        if (!this._connection || this.noOwner)
            return;
        if (this._throttleId || this._reading) {
            this._queued = true;
            return;
        }
        reportFailure(this._read());
    }

    _startThrottle() {
        if (this._throttleId)
            GLib.Source.remove(this._throttleId);
        this._throttleId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, THROTTLE_MS, () => {
            this._throttleId = 0;
            if (this._queued && !this._reading)
                reportFailure(this._read());
            return GLib.SOURCE_REMOVE;
        });
    }

    async _read() {
        this._startThrottle();
        this._queued = false;
        this._readCancellable?.cancel();
        const cancellable = new Gio.Cancellable();
        this._readCancellable = cancellable;
        this._reading = true;
        const generation = this._generation;
        const patterns = [...this._watched];
        let results = null;
        let failure = null;
        try {
            // Each object path gets its listener before its properties are read, so a change
            // between the read and the end of the snapshot still reaches the watcher.
            results = await readTimers(this._connection, patterns, cancellable, {
                path: path => this._listen(path),
                unit: unit => this._relevant.add(unit),
            });
        } catch (error) {
            if (cancellable.is_cancelled() || this._generation !== generation)
                return;
            failure = errorMessage(error);
        }
        // A reply that arrives after the owner or the watched list changed is dropped.
        if (cancellable.is_cancelled() || this._generation !== generation)
            return;
        this._reading = false;
        this._readCancellable = null;
        this.firstRead = true;
        if (failure !== null) {
            this._markStale();
            this.error = failure;
        } else {
            this._apply(results, patterns);
        }
        this._syncSubscriptions();
        this._onChange();
        if (this._queued && !this._throttleId)
            this._request();
    }

    /** Takes a read's results: a timer that is gone leaves, one that failed to read turns stale. */
    _apply(results, patterns) {
        this.error = null;
        const answered = new Set();
        for (const result of results) {
            if (!patterns.includes(result.unit))
                continue;
            answered.add(result.unit);
            if (result.error !== undefined) {
                const previous = this.routines.get(result.unit);
                if (previous)
                    previous.stale = true;
                this.error ??= result.error;
                // The unit may recover: it keeps the listeners it had.
                const paths = this._unitPaths.get(result.unit) ?? new Set();
                paths.add(result.timerPath);
                this._unitPaths.set(result.unit, paths);
            } else {
                this.routines.set(result.unit, {raw: result.raw, stale: false});
                this._unitPaths.set(result.unit,
                    new Set([result.timerPath, result.servicePath].filter(Boolean)));
            }
        }
        for (const unit of [...this.routines.keys()]) {
            if (!answered.has(unit))
                this.routines.delete(unit);
        }
        for (const unit of [...this._unitPaths.keys()]) {
            if (!answered.has(unit))
                this._unitPaths.delete(unit);
        }
        this._relevant = new Set(patterns);
        for (const routine of this.routines.values())
            this._relevant.add(routine.raw.timer.unit);
    }

    /** Listens to the property changes of one object path, once. */
    _listen(path) {
        if (this._pathSignals.has(path))
            return;
        this._pathSignals.set(path, this._connection.signal_subscribe(
            BUS_NAME, PROPERTIES, 'PropertiesChanged', path, null, Gio.DBusSignalFlags.NONE,
            () => this._request()));
    }

    /** Drops the listeners of paths that no watched timer or service of a read has any more. */
    _syncSubscriptions() {
        if (!this._connection)
            return;
        const wanted = new Set([...this._unitPaths.values()].flatMap(paths => [...paths]));
        for (const [path, id] of [...this._pathSignals]) {
            if (!wanted.has(path)) {
                this._connection.signal_unsubscribe(id);
                this._pathSignals.delete(path);
            }
        }
    }

    /** Releases everything: listeners, timers, the subscription, and the connection. */
    _close() {
        const connection = this._connection;
        const session = this._session;
        this._invalidate();
        this._ownerEpoch++;
        this._stopPolling();
        if (this._throttleId)
            GLib.Source.remove(this._throttleId);
        this._throttleId = 0;
        session?.cancellable.cancel();
        if (connection) {
            if (session.closedId)
                connection.disconnect(session.closedId);
            if (this._nameWatchId)
                Gio.bus_unwatch_name(this._nameWatchId);
            for (const id of [...this._managerSignals, ...this._pathSignals.values()])
                connection.signal_unsubscribe(id);
            // Closing the connection ends the subscription: systemd counts subscribers by bus
            // name, and this one is Greenlight's alone.
            closeConnection(connection);
        }
        this._reset();
    }
}
