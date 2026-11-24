import assert from 'node:assert/strict';
import test from 'node:test';

import {
    accessibleName,
    clockText,
    failureCause,
    isSet,
    nextRunTime,
    nextText,
    normalizeWatched,
    readRoutine,
    routineName,
    sameWatched,
    sortRoutines,
    statusText,
    timerSubtitle,
} from '../src/routines.js';

const UNSET = 2 ** 64 - 1;
const SECOND = 1e6;
const MINUTE = 60 * SECOND;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
// Tuesday 24 November 2026, 12:14 local time, as the mockup shows it.
const NOW_MS = new Date(2026, 10, 24, 12, 14).getTime();
const NOW = NOW_MS * 1000;
const MONOTONIC = 5000 * SECOND;

const timer = (values = {}) => ({
    nextRealtime: 0,
    nextMonotonic: 0,
    result: 'success',
    activeState: 'active',
    stateChange: NOW - DAY,
    ...values,
});
const service = (values = {}) => ({
    result: 'success',
    execMainCode: 1,
    execMainStatus: 0,
    execMainStart: NOW - 5 * MINUTE,
    activeState: 'inactive',
    subState: 'dead',
    inactiveExit: NOW - 5 * MINUTE,
    stateChange: NOW - 4 * MINUTE,
    conditionResult: true,
    conditionTimestamp: NOW - 5 * MINUTE,
    ...values,
});
const read = (timerValues, serviceValues, unit = 'nightly-report.timer') => readRoutine({
    unit,
    description: 'Build the nightly report',
    timer: timer(timerValues),
    service: serviceValues === null ? null : service(serviceValues),
}, NOW, MONOTONIC);

test('a routine is named after its timer unit', () => {
    assert.equal(routineName('nightly-report.timer'), 'nightly-report');
    assert.equal(routineName('odd'), 'odd');
});

test('a service that exited with status 0 succeeded', () => {
    const routine = read();
    assert.equal(routine.state, 'succeeded');
    assert.equal(routine.time, NOW - 4 * MINUTE);
    assert.equal(routine.name, 'nightly-report');
});

test('a RemainAfterExit service stays active and exited, and succeeded', () => {
    assert.equal(read({}, {activeState: 'active', subState: 'exited'}).state, 'succeeded');
});

test('an active service with another sub-state, and the transient states, are running', () => {
    for (const values of [
        {activeState: 'active', subState: 'running'},
        {activeState: 'activating', subState: 'start'},
        {activeState: 'deactivating', subState: 'stop'},
        {activeState: 'reloading', subState: 'reload'},
    ]) {
        const routine = read({}, {...values, inactiveExit: NOW - 90 * SECOND});
        assert.equal(routine.state, 'running', JSON.stringify(values));
        assert.equal(routine.time, NOW - 90 * SECOND);
    }
});

test('a failed service is failed, at its state change, with its cause', () => {
    const routine = read({}, {activeState: 'failed', subState: 'failed', result: 'exit-code', execMainStatus: 3,
        stateChange: NOW - 12 * MINUTE});
    assert.equal(routine.state, 'failed');
    assert.equal(routine.time, NOW - 12 * MINUTE);
    assert.equal(routine.cause, 'exit code 3');
});

test('a timer that failed is failed at the timer state change, whatever the service says', () => {
    const routine = read({result: 'trigger-limit-hit', stateChange: NOW - 2 * MINUTE});
    assert.equal(routine.state, 'failed');
    assert.equal(routine.time, NOW - 2 * MINUTE);
    assert.equal(routine.cause, 'timer failed: trigger-limit-hit');
    // A failed service wins over a failed timer: its own run is what failed.
    assert.equal(read({result: 'trigger-limit-hit'}, {activeState: 'failed', result: 'timeout'}).cause, 'timed out');
});

test('a failed service is never running or succeeded, even with a stale exit status', () => {
    assert.equal(read({}, {activeState: 'failed', result: 'exit-code', execMainStatus: 0}).state, 'failed');
});

test('a start skipped by a condition is skipped, until a later start', () => {
    const skipped = {conditionResult: false, conditionTimestamp: NOW - MINUTE, execMainStart: NOW - HOUR};
    const routine = read({}, skipped);
    assert.equal(routine.state, 'skipped');
    assert.equal(routine.time, NOW - 4 * MINUTE);
    assert.equal(read({}, {...skipped, execMainStart: NOW}).state, 'succeeded');
    // A condition never evaluated reads false with no timestamp: not a skip.
    assert.equal(read({}, {conditionResult: false, conditionTimestamp: 0, execMainStart: 0}).state, 'no-run');
});

test('a service that never started has no run recorded', () => {
    const routine = read({}, {execMainStart: 0, execMainCode: 0, execMainStatus: 0, stateChange: 0});
    assert.equal(routine.state, 'no-run');
    assert.equal(statusText(routine, NOW_MS), 'no run recorded');
});

test('a failure cleared by reset-failed reads unknown', () => {
    const routine = read({}, {execMainStatus: 1, result: 'success', stateChange: NOW - HOUR});
    assert.equal(routine.state, 'unknown');
    assert.equal(statusText(routine, NOW_MS), 'last run 1 h ago · result unknown');
    // A signal that ended a run the service reports as inactive is unknown too.
    assert.equal(read({}, {execMainCode: 2, execMainStatus: 15}).state, 'unknown');
});

test('a service systemd does not load is not loaded, and never failed', () => {
    const routine = read({result: 'resources'}, null);
    assert.equal(routine.state, 'not-loaded');
    assert.equal(statusText(routine, NOW_MS), 'service not loaded');
});

test('each cause reads as the spec words it', () => {
    const cause = (result, execMainCode = 1, execMainStatus = 1) =>
        failureCause({result, execMainCode, execMainStatus});
    assert.equal(cause('exit-code', 1, 2), 'exit code 2');
    assert.equal(cause('signal', 2, 9), 'killed by signal 9');
    assert.equal(cause('core-dump', 3, 11), 'killed by signal 11');
    // A failed control command (ExecStartPre=) leaves the main process unrun or exited cleanly.
    assert.equal(cause('exit-code', 0, 0), 'a start command failed');
    assert.equal(cause('exit-code', 1, 0), 'a start command failed');
    assert.equal(cause('signal', 0, 0), 'a start command failed');
    assert.equal(cause('core-dump', 1, 0), 'a start command failed');
    assert.equal(cause('timeout'), 'timed out');
    assert.equal(cause('oom-kill'), 'out of memory');
    assert.equal(cause('start-limit-hit'), 'start limit hit');
    assert.equal(cause('watchdog'), 'watchdog');
});

test('a pre-start failure reads as a start command that failed', () => {
    const routine = read({}, {activeState: 'failed', result: 'exit-code', execMainCode: 0, execMainStatus: 0});
    assert.equal(routine.cause, 'a start command failed');
    assert.equal(statusText({...routine, time: NOW - 12 * MINUTE}, NOW_MS),
        'failed 12 min ago · a start command failed');
});

test('a deadline is unset when it is 0 or 2^64 - 1', () => {
    assert.equal(isSet(0), false);
    assert.equal(isSet(UNSET), false);
    assert.equal(isSet(NOW), true);
    for (const unset of [0, UNSET]) {
        assert.equal(nextRunTime(timer({nextRealtime: unset, nextMonotonic: unset}), NOW, MONOTONIC), null);
        const next = values => nextRunTime(timer(values), NOW, MONOTONIC);
        assert.equal(next({nextRealtime: NOW + HOUR, nextMonotonic: unset}), NOW + HOUR);
        assert.equal(next({nextRealtime: unset, nextMonotonic: MONOTONIC + HOUR}), NOW + HOUR);
    }
});

test('the next run is the earlier of the two set deadlines, in either order', () => {
    const monotonic = MONOTONIC + 10 * MINUTE;
    assert.equal(nextRunTime(timer({nextRealtime: NOW + HOUR, nextMonotonic: monotonic}), NOW, MONOTONIC),
        NOW + 10 * MINUTE);
    assert.equal(nextRunTime(timer({nextRealtime: NOW + 5 * MINUTE, nextMonotonic: monotonic}), NOW,
        MONOTONIC), NOW + 5 * MINUTE);
});

test('a timer that is not active is not scheduled', () => {
    const inactive = timer({activeState: 'inactive', nextRealtime: NOW + HOUR});
    assert.equal(nextRunTime(inactive, NOW, MONOTONIC), null);
    assert.equal(nextText({state: 'succeeded', nextAt: null}, NOW_MS), 'not scheduled');
});

test('a next run at or before now reads next now', () => {
    assert.equal(nextText(read({nextRealtime: NOW}), NOW_MS), 'next now');
    assert.equal(nextText(read({nextRealtime: NOW - HOUR}), NOW_MS), 'next now');
    assert.equal(nextText(read({nextMonotonic: MONOTONIC - SECOND}), NOW_MS), 'next now');
});

test('a running routine shows no next run, and its row reads running since', () => {
    const routine = read({nextRealtime: NOW + HOUR}, {activeState: 'activating', inactiveExit: NOW - 2 * MINUTE});
    assert.equal(nextText(routine, NOW_MS), null);
    assert.equal(statusText(routine, NOW_MS), 'running since 12:12');
    assert.equal(accessibleName(routine, NOW_MS), 'nightly-report, running since 12:12');
});

test('a next run reads as a countdown under a day, else as a weekday and a time', () => {
    const next = usec => nextText(read({nextRealtime: NOW + usec}), NOW_MS);
    assert.equal(next(30 * SECOND), 'next in 1 min');
    assert.equal(next(11 * MINUTE), 'next in 11 min');
    assert.equal(next(11 * MINUTE + 1), 'next in 12 min');
    assert.equal(next(HOUR), 'next in 1 h');
    assert.equal(next(6 * HOUR + 20 * MINUTE), 'next in 6 h 20 min');
    assert.equal(next(DAY - MINUTE), 'next in 23 h 59 min');
    // A day away or more: the weekday and the time (24 November is a Tuesday).
    assert.equal(next(DAY), 'next Wed 12:14');
    assert.equal(next(DAY + 45 * MINUTE), 'next Wed 12:59');
    assert.equal(next(2 * DAY + 10 * MINUTE), 'next Thu 12:24');
    assert.equal(next(6 * DAY), 'next Mon 12:14');
    assert.equal(next(7 * DAY), 'next Tue 12:14');
    assert.equal(next(20 * DAY), 'next Mon 12:14');
});

test('a monotonic deadline converts through the current monotonic time', () => {
    const routine = read({nextMonotonic: MONOTONIC + 18 * MINUTE});
    assert.equal(routine.nextAt, NOW + 18 * MINUTE);
    assert.equal(nextText(routine, NOW_MS), 'next in 18 min');
});

test('ages read as ORD words them, with ago except for now and a date', () => {
    const ran = usec => statusText({state: 'succeeded', time: NOW - usec}, NOW_MS);
    assert.equal(ran(0), 'ran now');
    assert.equal(ran(59 * SECOND), 'ran now');
    assert.equal(ran(MINUTE), 'ran 1 min ago');
    assert.equal(ran(59 * MINUTE), 'ran 59 min ago');
    assert.equal(ran(HOUR), 'ran 1 h ago');
    assert.equal(ran(23 * HOUR), 'ran 23 h ago');
    assert.equal(ran(DAY), 'ran 1 d ago');
    assert.equal(ran(29 * DAY), 'ran 29 d ago');
    assert.equal(ran(30 * DAY), 'ran Oct 25');
    assert.equal(ran(400 * DAY), 'ran Oct 20, 2025');
});

test('each state has its status text', () => {
    const at = {time: NOW - 4 * MINUTE};
    assert.equal(statusText({state: 'succeeded', ...at}, NOW_MS), 'ran 4 min ago');
    assert.equal(statusText({state: 'failed', cause: 'exit code 1', time: NOW - 12 * MINUTE}, NOW_MS),
        'failed 12 min ago · exit code 1');
    assert.equal(statusText({state: 'skipped', ...at}, NOW_MS), 'skipped 4 min ago · condition not met');
    assert.equal(statusText({state: 'unknown', ...at}, NOW_MS), 'last run 4 min ago · result unknown');
});

test('the accessible name joins the name, the status, and the next run', () => {
    const routine = read({nextRealtime: NOW + 11 * MINUTE});
    assert.equal(accessibleName(routine, NOW_MS), 'nightly-report, ran 4 min ago, next in 11 min');
    assert.equal(accessibleName(read(), NOW_MS), 'nightly-report, ran 4 min ago, not scheduled');
});

test('the preferences subtitle is the description and the next run the menu shows', () => {
    assert.equal(timerSubtitle(read({nextRealtime: NOW + 11 * MINUTE}), NOW_MS),
        'Build the nightly report · next in 11 min');
    assert.equal(timerSubtitle({...read({nextRealtime: NOW + 11 * MINUTE}), description: ''}, NOW_MS),
        'next in 11 min');
    // A running routine shows no next run: the subtitle is the description alone.
    assert.equal(timerSubtitle(read({}, {activeState: 'activating'}), NOW_MS), 'Build the nightly report');
});

test('times are local 24-hour HH:MM', () => {
    assert.equal(clockText(new Date(2026, 10, 24, 7, 5).getTime() * 1000), '07:05');
    assert.equal(clockText(new Date(2026, 10, 24, 23, 59).getTime() * 1000), '23:59');
});

test('routines sort by name, without changing the list', () => {
    const list = ['sync-mail', 'backup-photos', 'systemd-tmpfiles-clean', 'nightly-report']
        .map(name => ({name}));
    assert.deepEqual(sortRoutines(list).map(({name}) => name),
        ['backup-photos', 'nightly-report', 'sync-mail', 'systemd-tmpfiles-clean']);
    assert.equal(list[0].name, 'sync-mail');
});

test('a stored list is sorted, deduplicated, and keeps only timer units', () => {
    assert.deepEqual(normalizeWatched(['b.timer', 'a.timer', 'b.timer', 'c.service', 3]), ['a.timer', 'b.timer']);
});

test('two lists of timers are the same set whatever their order', () => {
    assert.equal(sameWatched(['a.timer', 'b.timer'], ['b.timer', 'a.timer']), true);
    assert.equal(sameWatched(['a.timer'], ['a.timer', 'b.timer']), false);
    assert.equal(sameWatched([], []), true);
});
