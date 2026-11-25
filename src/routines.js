// Routines: the user's systemd timers, read from systemd's D-Bus API. This module turns the
// properties of a timer and of its service into a state, a cause, a next run, and the texts the
// menu and the preferences show. Pure: it imports nothing from gi://, so node --test covers it.

import {formatActivityAge} from './quickopen.js';

const TIMER_SUFFIX = '.timer';
const USEC_PER_MS = 1000;
const MINUTE_MS = 60 * 1000;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;
const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
// systemd marks an unset deadline with 0 or 2^64 - 1, which a JS number reads as about 1.8e19.
const UNSET_FROM = 2 ** 63;

// `ExecMainCode`: CLD_EXITED, CLD_KILLED, CLD_DUMPED.
const EXITED = 1;
const KILLED = 2;
const DUMPED = 3;

export const STATES = {
    succeeded: {icon: 'object-select-symbolic', color: '#26a269'},
    failed: {icon: 'window-close-symbolic', color: '#c01c28'},
    running: {icon: 'media-record-symbolic', color: '#e5a50a'},
    skipped: {icon: 'list-remove-symbolic', color: '#77767b'},
    'no-run': {icon: 'list-remove-symbolic', color: '#77767b'},
    unknown: {icon: 'list-remove-symbolic', color: '#77767b'},
    'not-loaded': {icon: 'list-remove-symbolic', color: '#77767b'},
};

/** `nightly-report.timer` reads `nightly-report`. */
export function routineName(unit) {
    return unit.endsWith(TIMER_SUFFIX) ? unit.slice(0, -TIMER_SUFFIX.length) : unit;
}

/** Whether a deadline that systemd reports in microseconds is set: neither 0 nor 2^64 - 1. */
export function isSet(usec) {
    return usec > 0 && usec < UNSET_FROM;
}

/**
 * The time of the next run in real-time microseconds, or null when the routine is not scheduled:
 * the earlier of the set deadlines, a monotonic one converted as now plus its distance from the
 * current monotonic time, and none when the timer is not `active`.
 */
export function nextRunTime(timer, nowRealUs, nowMonotonicUs) {
    if (timer.activeState !== 'active')
        return null;
    const candidates = [];
    if (isSet(timer.nextRealtime))
        candidates.push(timer.nextRealtime);
    if (isSet(timer.nextMonotonic))
        candidates.push(nowRealUs + (timer.nextMonotonic - nowMonotonicUs));
    return candidates.length > 0 ? Math.min(...candidates) : null;
}

/** The cause of a service failure, from its `Result` and the main process's exit. */
export function failureCause(service) {
    const {result, execMainCode: code, execMainStatus: status} = service;
    switch (result) {
    case 'exit-code':
    case 'signal':
    case 'core-dump':
        if (result === 'exit-code' && code === EXITED && status !== 0)
            return 'exit code ' + status;
        if (result !== 'exit-code' && (code === KILLED || code === DUMPED))
            return 'killed by signal ' + status;
        return 'a start command failed';
    case 'timeout':
        return 'timed out';
    case 'oom-kill':
        return 'out of memory';
    case 'start-limit-hit':
        return 'start limit hit';
    default:
        return result;
    }
}

/**
 * Reads a routine from the properties of its timer and of its service. `raw` holds
 * `{unit, description, timer, service}`: `timer` has `nextRealtime`, `nextMonotonic`, `result`,
 * `activeState`, and `stateChange` (all times in microseconds), and `service` is null when
 * systemd does not load it, else has `result`, `execMainCode`, `execMainStatus`,
 * `execMainStart`, `activeState`, `subState`, `inactiveExit`, `stateChange`, `conditionResult`,
 * `conditionTimestamp`, and `stateChangeMonotonic` (the timer has it too). Returns
 * `{name, unit, service, description, state, time, cause, failure, nextAt}`: the state is the
 * first of State's list that applies, `time` its time in microseconds, `cause` the failure's text
 * (failed only), `failure` the identity of the failed run (failed only): `key` is the service's
 * or, for a timer failure, the timer's own, and `order` its `StateChangeTimestampMonotonic`; and
 * `nextAt` the next run in microseconds, null when not scheduled.
 */
export function readRoutine(raw, nowRealUs, nowMonotonicUs) {
    const {unit, description, timer, service} = raw;
    const routine = {
        failure: null,
        name: routineName(unit),
        unit,
        // The service the timer activates: what Run now starts and View logs reads.
        service: timer.unit,
        description: description ?? '',
        state: 'unknown',
        time: null,
        cause: null,
        nextAt: nextRunTime(timer, nowRealUs, nowMonotonicUs),
    };
    if (service === null)
        return {...routine, state: 'not-loaded'};

    if (service.activeState === 'failed') {
        return {
            ...routine,
            state: 'failed',
            time: service.stateChange,
            cause: failureCause(service),
            failure: {key: 'service:' + timer.unit, order: service.stateChangeMonotonic},
        };
    }
    if (timer.result !== 'success') {
        return {
            ...routine,
            state: 'failed',
            time: timer.stateChange,
            cause: 'timer failed: ' + timer.result,
            failure: {key: 'timer:' + unit, order: timer.stateChangeMonotonic},
        };
    }
    const state = service.activeState;
    if (state === 'activating' || state === 'deactivating' || state === 'reloading' ||
        (state === 'active' && service.subState !== 'exited'))
        return {...routine, state: 'running', time: service.inactiveExit};

    const time = service.stateChange;
    if (!service.conditionResult && service.conditionTimestamp > service.execMainStart)
        return {...routine, state: 'skipped', time};
    if (service.execMainStart === 0)
        return {...routine, state: 'no-run'};
    const ended = state === 'inactive' || (state === 'active' && service.subState === 'exited');
    if (service.execMainCode === EXITED && service.execMainStatus === 0 && ended)
        return {...routine, state: 'succeeded', time};
    return {...routine, state: 'unknown', time};
}

/** The age of a time, as ORD words it: `now`, `12 min ago`, `5 h ago`, `3 d ago`, `Sep 2`. */
export function ageText(usec, nowMs) {
    const age = formatActivityAge(new Date(usec / USEC_PER_MS).toISOString(), nowMs);
    return age === 'now' || !/^\d+ (min|h|d)$/.test(age) ? age : age + ' ago';
}

/** A local time as `HH:MM`, in 24 hours. */
export function clockText(usec) {
    const date = new Date(usec / USEC_PER_MS);
    return String(date.getHours()).padStart(2, '0') + ':' + String(date.getMinutes()).padStart(2, '0');
}

/** The status text of a row: `ran 4 min ago`, `failed 12 min ago · exit code 1`, and so on. */
export function statusText(routine, nowMs) {
    switch (routine.state) {
    case 'succeeded':
        return 'ran ' + ageText(routine.time, nowMs);
    case 'failed':
        return 'failed ' + ageText(routine.time, nowMs) + ' · ' + routine.cause;
    case 'running':
        return 'running since ' + clockText(routine.time);
    case 'skipped':
        return 'skipped ' + ageText(routine.time, nowMs) + ' · condition not met';
    case 'no-run':
        return 'no run recorded';
    case 'not-loaded':
        return 'service not loaded';
    default:
        return 'last run ' + ageText(routine.time, nowMs) + ' · result unknown';
    }
}

/**
 * The next run of a row: `next in 11 min`, `next in 6 h 20 min` under a day away, else
 * `next Thu 13:00`; `next now` for a run at or before now; `not scheduled`; null for a running
 * routine, which shows none. A countdown rounds up to the minute.
 */
export function nextText(routine, nowMs) {
    if (routine.state === 'running')
        return null;
    if (routine.nextAt === null)
        return 'not scheduled';
    const at = routine.nextAt / USEC_PER_MS;
    const distance = at - nowMs;
    if (distance <= 0)
        return 'next now';
    if (distance < DAY_MS) {
        const minutes = Math.ceil(distance / MINUTE_MS);
        const hours = Math.floor(minutes / 60);
        return 'next in ' + (hours > 0 ? hours + ' h' + (minutes % 60 > 0 ? ' ' + (minutes % 60) + ' min' : '')
            : minutes + ' min');
    }
    return 'next ' + WEEKDAYS[new Date(at).getDay()] + ' ' + clockText(routine.nextAt);
}

/** The accessible name of a row: `<name>, <status text>, <next run>`, without a missing next run. */
export function accessibleName(routine, nowMs) {
    return [routine.name, statusText(routine, nowMs), nextText(routine, nowMs)].filter(Boolean).join(', ');
}

/** The subtitle of a timer in the preferences: its description, then ` · ` and its next run. */
export function timerSubtitle(routine, nowMs) {
    return [routine.description, nextText(routine, nowMs)].filter(Boolean).join(' · ');
}

/** Sorts by name, in code point order, without changing the list. */
export function sortRoutines(routines) {
    return [...routines].sort((first, second) =>
        first.name < second.name ? -1 : first.name > second.name ? 1 : 0);
}

/** The timer unit names of a stored list, sorted, each once; anything else is dropped. */
export function normalizeWatched(names) {
    return [...new Set(names.filter(name => typeof name === 'string' && name.endsWith(TIMER_SUFFIX)))]
        .sort((first, second) => first < second ? -1 : first > second ? 1 : 0);
}

/** Whether two lists of timer units name the same set, whatever the order. */
export function sameWatched(first, second) {
    const names = new Set(first);
    const others = new Set(second);
    return names.size === others.size && [...names].every(name => others.has(name));
}

// Run now and View logs ----------------------------------------------------------------------

// The terminals View logs tries, in order, with what goes between the terminal and its command.
const TERMINALS = [
    {command: 'xdg-terminal-exec', separator: []},
    {command: 'ptyxis', separator: ['--']},
    {command: 'kgx', separator: ['--']},
    {command: 'gnome-terminal', separator: ['--']},
];

/**
 * The command of View logs. The variables are part of it because ptyxis and gnome-terminal run
 * it in an already-running server that ignores the caller's environment: `SYSTEMD_PAGER=less`
 * (honored only with `SYSTEMD_PAGERSECURE=0`) overrides an inherited pager such as `cat`, and
 * `SYSTEMD_LESS` without `F` keeps `less` open when the logs fit one screen.
 */
export function logsCommand(service) {
    return ['env', 'SYSTEMD_PAGERSECURE=0', 'SYSTEMD_PAGER=less', 'SYSTEMD_LESS=RSXMK',
        'journalctl', '--user', '-u', service, '-e'];
}

/** The command a user types for the same logs, which the error lines of View logs name. */
export function logsHint(service) {
    return 'journalctl --user -u ' + service + ' -e';
}

/**
 * The argument array that starts the first terminal `find` locates (`find(command)` gives its
 * path or null): the path found, then the terminal's own separator, then the logs command.
 * Null when no terminal is found.
 */
export function chooseTerminal(service, find) {
    for (const {command, separator} of TERMINALS) {
        const path = find(command);
        if (path)
            return [path, ...separator, ...logsCommand(service)];
    }
    return null;
}

/** The line under a row, or the body of a notification, when the logs did not open. */
export function terminalErrorText(service, error = null) {
    return (error === null ? 'No terminal found' : 'Could not open a terminal: ' + error) +
        '. Run: ' + logsHint(service);
}

/** The line under a row after a start that did not happen. */
export function startErrorText(name, reason) {
    return 'Could not start ' + name + ': ' + reason;
}

/** The dimmed line of a routine whose own read failed: under its row, or under the heading. */
export function readFailureText(unit, cause) {
    return 'Could not read ' + routineName(unit) + ': ' + cause;
}

/**
 * The lines under the heading for watched routines whose read failed before any state was read:
 * those of `failures` (unit to cause) without a row in `loaded` (the units that have one), sorted
 * by name.
 */
export function headingFailureLines(failures, loaded) {
    return sortRoutines([...failures.keys()]
        .filter(unit => !loaded.has(unit))
        .map(unit => ({name: routineName(unit), unit})))
        .map(({unit}) => readFailureText(unit, failures.get(unit)));
}

/**
 * What a job result adds to the row, or null: `done` is a start, and `failed` shows in the row's
 * own Failed state, so neither needs a line. Any other result (`dependency`, `canceled`,
 * `timeout`, `skipped`, `assert`, ...) reads `job <result>`.
 */
export function jobResultReason(result) {
    return result === 'done' || result === 'failed' ? null : 'job ' + result;
}

export const NO_ANSWER_REASON = 'no answer from systemd';

/** The accessible names of the two buttons of a row. */
export const runAccessibleName = routine => 'Run ' + routine.name + ' now';
export const logsAccessibleName = routine => 'View ' + routine.name + ' logs';

/** Whether Run now can be pressed: not while running, stale, or already starting. */
export function canRun(routine, starting) {
    return routine.state !== 'running' && !routine.stale && !starting;
}

/**
 * The wait of one Run now for its job to end. systemd's `JobRemoved` can arrive before the reply
 * of `StartUnit` that names the job, so the results of that service are kept until the reply
 * says which job is the one. `result` settles with the job's result string, or with null when the
 * wait is dropped (systemd changed owner, or Greenlight stopped listening).
 */
export class JobWait {
    constructor(service) {
        this.service = service;
        this.path = null;
        this.early = new Map();
        this.result = new Promise(resolve => (this.settle = resolve));
    }

    /** A `JobRemoved` of this wait's service. */
    removed(path, result) {
        if (this.path === null)
            this.early.set(path, result);
        else if (path === this.path)
            this.settle(result);
    }

    /** The reply of `StartUnit` named the job. */
    accept(path) {
        this.path = path;
        if (this.early.has(path))
            this.settle(this.early.get(path));
        this.early.clear();
    }

    /** Gives up: the result is null. */
    cancel() {
        this.settle(null);
    }
}

// Failure notifications and the panel dot ----------------------------------------------------

/**
 * Decides which failed runs notify. A failed run is identified by `routine.failure`: its service
 * (a timer failure: its timer) and the monotonic time of the state change, so a re-read does not
 * notify it twice and a later run does. Nothing is stored: a new tracker starts with a baseline.
 */
export class FailureTracker {
    constructor() {
        // The watched timers whose first successful read was taken as a quiet baseline.
        this._baselined = new Set();
        // The latest run each routine has read, by `<timer unit> <failure key>`.
        this._seen = new Map();
        // The latest run notified, by failure key: a service two timers share notifies once. One
        // entry per failing service or timer, kept for the life of the extension.
        this._announced = new Map();
    }

    /**
     * Takes a read of the watched routines (`stale` ones, whose last read failed, are skipped)
     * and returns the routines whose failed run is new, one per run. A routine's first read is a
     * baseline and never notifies. A run a routine has not read before notifies, unless another
     * routine's read already notified it, and a service two watched timers share notifies under
     * the first name by sort order. Every routine is compared with what it knew before this read.
     */
    observe(routines, watched) {
        for (const unit of [...this._baselined]) {
            if (!watched.includes(unit))
                this._baselined.delete(unit);
        }
        for (const id of [...this._seen.keys()]) {
            if (!watched.includes(id.split(' ')[0]))
                this._seen.delete(id);
        }
        const due = new Map();
        for (const routine of sortRoutines(routines)) {
            if (routine.stale || !watched.includes(routine.unit))
                continue;
            const baseline = !this._baselined.has(routine.unit);
            this._baselined.add(routine.unit);
            const {failure} = routine;
            if (!failure)
                continue;
            const id = routine.unit + ' ' + failure.key;
            const known = (this._seen.get(id) ?? -Infinity) >= failure.order;
            this._seen.set(id, Math.max(this._seen.get(id) ?? -Infinity, failure.order));
            if (baseline || known || (this._announced.get(failure.key) ?? -Infinity) >= failure.order)
                continue;
            const run = failure.key + ' ' + failure.order;
            if (!due.has(run))
                due.set(run, routine);
        }
        for (const {failure} of due.values()) {
            this._announced.set(failure.key,
                Math.max(this._announced.get(failure.key) ?? -Infinity, failure.order));
        }
        return [...due.values()];
    }
}

/** The title and body of the notification of a failed run: `<name> failed`, `<cause> · <HH:MM>`. */
export function failureNotification(routine) {
    return {title: routine.name + ' failed', body: routine.cause + ' · ' + clockText(routine.time)};
}

/** The title of the notification that says the logs of a routine did not open. */
export const logsFailureTitle = routine => 'Could not open the logs of ' + routine.name;

/** Whether the panel shows the dot: a watched routine is failed, stale or not. */
export function hasFailedRoutine(routines) {
    return routines.some(routine => routine.state === 'failed');
}

/** The accessible name of the panel indicator. */
export function indicatorName(routines) {
    return hasFailedRoutine(routines) ? 'Greenlight, a routine failed' : 'Greenlight';
}
