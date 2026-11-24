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
 * and `conditionTimestamp`. Returns `{name, unit, description, state, time, cause, nextAt}`:
 * the state is the first of State's list that applies, `time` its time in microseconds, `cause`
 * the failure's text (failed only), and `nextAt` the next run in microseconds, null when not
 * scheduled.
 */
export function readRoutine(raw, nowRealUs, nowMonotonicUs) {
    const {unit, description, timer, service} = raw;
    const routine = {
        name: routineName(unit),
        unit,
        description: description ?? '',
        state: 'unknown',
        time: null,
        cause: null,
        nextAt: nextRunTime(timer, nowRealUs, nowMonotonicUs),
    };
    if (service === null)
        return {...routine, state: 'not-loaded'};

    if (service.activeState === 'failed')
        return {...routine, state: 'failed', time: service.stateChange, cause: failureCause(service)};
    if (timer.result !== 'success') {
        return {
            ...routine,
            state: 'failed',
            time: timer.stateChange,
            cause: 'timer failed: ' + timer.result,
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
