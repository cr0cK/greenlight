import assert from 'node:assert/strict';
import test from 'node:test';

import {
    FailureTracker,
    JobWait,
    NO_ANSWER_REASON,
    accessibleName,
    canRun,
    chooseTerminal,
    clockText,
    failureCause,
    failureNotification,
    hasFailedRoutine,
    indicatorName,
    isSet,
    jobResultReason,
    logsAccessibleName,
    logsCommand,
    logsFailureTitle,
    logsHint,
    nextRunTime,
    nextText,
    normalizeWatched,
    readRoutine,
    runAccessibleName,
    startErrorText,
    terminalErrorText,
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
    stateChangeMonotonic: 100 * SECOND,
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
    stateChangeMonotonic: 4000 * SECOND,
    conditionResult: true,
    conditionTimestamp: NOW - 5 * MINUTE,
    ...values,
});
const read = (timerValues, serviceValues, unit = 'nightly-report.timer') => readRoutine({
    unit,
    description: 'Build the nightly report',
    timer: timer({unit: unit.replace(/\.timer$/, '.service'), ...timerValues}),
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

// Run now and View logs

const JOURNAL = ['env', 'SYSTEMD_PAGERSECURE=0', 'SYSTEMD_PAGER=less', 'SYSTEMD_LESS=RSXMK',
    'journalctl', '--user', '-u', 'nightly-report.service', '-e'];
const TERMINAL_ORDER = ['xdg-terminal-exec', 'ptyxis', 'kgx', 'gnome-terminal'];
// A lookup as findCli does it: the directories of PATH first, then ~/.local/bin.
const lookup = ({path = [], local = []}) => command =>
    path.includes(command) ? '/usr/bin/' + command
        : local.includes(command) ? '/home/user/.local/bin/' + command : null;

test('the logs command pages at the end and stays open, whatever the inherited pager', () => {
    assert.deepEqual(logsCommand('nightly-report.service'), JOURNAL);
    assert.equal(logsHint('nightly-report.service'), 'journalctl --user -u nightly-report.service -e');
});

test('the terminal is the first of the four found, with its own separator', () => {
    const service = 'nightly-report.service';
    assert.deepEqual(chooseTerminal(service, lookup({path: TERMINAL_ORDER})),
        ['/usr/bin/xdg-terminal-exec', ...JOURNAL]);
    assert.deepEqual(chooseTerminal(service, lookup({path: TERMINAL_ORDER.slice(1)})),
        ['/usr/bin/ptyxis', '--', ...JOURNAL]);
    assert.deepEqual(chooseTerminal(service, lookup({path: TERMINAL_ORDER.slice(2)})),
        ['/usr/bin/kgx', '--', ...JOURNAL]);
    assert.deepEqual(chooseTerminal(service, lookup({path: TERMINAL_ORDER.slice(3)})),
        ['/usr/bin/gnome-terminal', '--', ...JOURNAL]);
});

test('each candidate missing in turn leaves the next one', () => {
    for (let missing = 0; missing < TERMINAL_ORDER.length - 1; missing++) {
        const present = TERMINAL_ORDER.filter((_command, index) => index !== missing);
        assert.equal(chooseTerminal('a.service', lookup({path: present}))[0], '/usr/bin/' + present[0]);
    }
});

test('a terminal only in ~/.local/bin is found, after the ones in PATH', () => {
    assert.equal(chooseTerminal('a.service', lookup({local: ['ptyxis']}))[0],
        '/home/user/.local/bin/ptyxis');
    assert.equal(chooseTerminal('a.service', lookup({path: ['gnome-terminal'], local: ['kgx']}))[0],
        '/home/user/.local/bin/kgx');
    assert.equal(chooseTerminal('a.service', lookup({path: ['kgx'], local: ['kgx']}))[0], '/usr/bin/kgx');
});

test('no terminal found gives no command', () => {
    assert.equal(chooseTerminal('a.service', lookup({})), null);
});

test('the terminal never gets a shell string: one item per argument', () => {
    const [, ...rest] = chooseTerminal('odd name; rm.service', lookup({path: ['xdg-terminal-exec']}));
    assert.ok(rest.includes('odd name; rm.service'));
    assert.equal(rest.filter(item => item.includes(' ')).length, 1);
});

test('the terminal errors name the command to run instead', () => {
    assert.equal(terminalErrorText('nightly-report.service'),
        'No terminal found. Run: journalctl --user -u nightly-report.service -e');
    assert.equal(terminalErrorText('nightly-report.service', 'Failed to execute child process'),
        'Could not open a terminal: Failed to execute child process. Run: journalctl --user -u nightly-report.service -e');
});

test('a start that did not happen reads Could not start with its reason', () => {
    assert.equal(startErrorText('nightly-report', 'Unit is masked.'), 'Could not start nightly-report: Unit is masked.');
    assert.equal(startErrorText('nightly-report', NO_ANSWER_REASON),
        'Could not start nightly-report: no answer from systemd');
    assert.equal(startErrorText('nightly-report', jobResultReason('dependency')),
        'Could not start nightly-report: job dependency');
});

test('only a job result other than done and failed adds a line', () => {
    assert.equal(jobResultReason('done'), null);
    assert.equal(jobResultReason('failed'), null);
    for (const result of ['dependency', 'canceled', 'timeout', 'skipped', 'assert', 'invalid', 'collected'])
        assert.equal(jobResultReason(result), 'job ' + result);
});

test('the buttons are named after the routine', () => {
    const routine = read({}, {});
    assert.equal(runAccessibleName(routine), 'Run nightly-report now');
    assert.equal(logsAccessibleName(routine), 'View nightly-report logs');
});

test('Run now is insensitive while running, stale, or starting', () => {
    const idle = read({}, {});
    assert.equal(canRun(idle, false), true);
    assert.equal(canRun(idle, true), false);
    assert.equal(canRun({...idle, stale: true}, false), false);
    assert.equal(canRun(read({}, {activeState: 'active', subState: 'running'}), false), false);
    assert.equal(canRun(read({}, {activeState: 'failed'}), false), true);
});

test('a routine knows the service its timer activates', () => {
    assert.equal(read({unit: 'other.service'}, {}).service, 'other.service');
});

test('a job result that arrives before the reply waits for the job to be named', async () => {
    const wait = new JobWait('a.service');
    wait.removed('/job/7', 'dependency');
    wait.removed('/job/6', 'done');
    wait.accept('/job/7');
    assert.equal(await wait.result, 'dependency');
});

test('a job result that arrives after the reply settles only for the named job', async () => {
    const wait = new JobWait('a.service');
    wait.accept('/job/7');
    let settled = false;
    wait.result.then(() => (settled = true));
    wait.removed('/job/6', 'canceled');
    await Promise.resolve();
    assert.equal(settled, false);
    wait.removed('/job/7', 'failed');
    assert.equal(await wait.result, 'failed');
});

test('a job result of an earlier job never settles a later one', async () => {
    const wait = new JobWait('a.service');
    wait.removed('/job/3', 'done');
    wait.accept('/job/4');
    wait.cancel();
    assert.equal(await wait.result, null);
});

test('a dropped wait settles with null, and a result after that changes nothing', async () => {
    const wait = new JobWait('a.service');
    wait.accept('/job/1');
    wait.cancel();
    wait.removed('/job/1', 'done');
    assert.equal(await wait.result, null);
});

// Failure notifications and the panel dot --------------------------------------------------

const failed = (unit, serviceValues = {}, timerValues = {}) => ({
    ...read(timerValues, {activeState: 'failed', subState: 'failed', result: 'exit-code', execMainStatus: 1,
        ...serviceValues}, unit + '.timer'),
    stale: false,
});
const ok = (unit, serviceValues = {}) => ({...read({}, serviceValues, unit + '.timer'), stale: false});
const watchedOf = (...units) => units.map(unit => unit + '.timer');

test('a failed service is identified by its service and its monotonic state change', () => {
    const routine = failed('nightly-report', {stateChangeMonotonic: 4100 * SECOND});
    assert.deepEqual(routine.failure, {key: 'service:nightly-report.service', order: 4100 * SECOND});
    assert.notEqual(failed('other-job').failure.key, routine.failure.key);
    assert.equal(ok('nightly-report').failure, null);
});

test('a timer failure is identified by its timer and the timer\'s own monotonic state change', () => {
    const routine = read({result: 'trigger-limit-hit', stateChangeMonotonic: 4200 * SECOND}, {});
    assert.deepEqual(routine.failure, {key: 'timer:nightly-report.timer', order: 4200 * SECOND});
});

test('a routine already failed when watched is a baseline, and never notifies', () => {
    const tracker = new FailureTracker();
    const routines = [failed('a-job')];
    assert.deepEqual(tracker.observe(routines, watchedOf('a-job')), []);
    assert.deepEqual(tracker.observe(routines, watchedOf('a-job')), []);
});

test('a run that turns failed after the baseline notifies once, and a re-read does not repeat it', () => {
    const tracker = new FailureTracker();
    const watched = watchedOf('a-job');
    assert.deepEqual(tracker.observe([ok('a-job')], watched), []);
    const routines = [failed('a-job', {stateChangeMonotonic: 5000 * SECOND})];
    assert.deepEqual(tracker.observe(routines, watched).map(routine => routine.name), ['a-job']);
    assert.deepEqual(tracker.observe(routines, watched), []);
});

test('a second failed run notifies again, even with no successful read between them', () => {
    const tracker = new FailureTracker();
    const watched = watchedOf('a-job');
    tracker.observe([ok('a-job')], watched);
    assert.equal(tracker.observe([failed('a-job', {stateChangeMonotonic: 5000 * SECOND})], watched).length, 1);
    // A direct failed to failed change (systemd cleared and failed again between two reads).
    assert.equal(tracker.observe([failed('a-job', {stateChangeMonotonic: 6000 * SECOND})], watched).length, 1);
});

test('the first successful read is the baseline, not the first read attempt', () => {
    const tracker = new FailureTracker();
    const watched = watchedOf('a-job');
    // A stale read is no baseline: the first fresh read, which already shows a failure, is.
    assert.deepEqual(tracker.observe([{...ok('a-job'), stale: true}], watched), []);
    assert.deepEqual(tracker.observe([failed('a-job')], watched), []);
    assert.equal(tracker.observe([failed('a-job', {stateChangeMonotonic: 6000 * SECOND})], watched).length, 1);
});

test('a routine that starts being watched later gets its own quiet baseline', () => {
    const tracker = new FailureTracker();
    tracker.observe([ok('a-job')], watchedOf('a-job'));
    const routines = [ok('a-job'), failed('b-job')];
    assert.deepEqual(tracker.observe(routines, watchedOf('a-job', 'b-job')), []);
    assert.equal(tracker.observe([ok('a-job'), failed('b-job', {stateChangeMonotonic: 9000 * SECOND})],
        watchedOf('a-job', 'b-job')).length, 1);
});

test('a routine watched again after it stopped is a baseline again', () => {
    const tracker = new FailureTracker();
    tracker.observe([ok('a-job')], watchedOf('a-job'));
    tracker.observe([], []);
    assert.deepEqual(tracker.observe([failed('a-job', {stateChangeMonotonic: 7000 * SECOND})], watchedOf('a-job')), []);
});

test('a routine rewatched while another stays watched is a baseline again', () => {
    const tracker = new FailureTracker();
    tracker.observe([ok('a-job'), ok('b-job')], watchedOf('a-job', 'b-job'));
    tracker.observe([ok('b-job')], watchedOf('b-job'));
    const back = [failed('a-job', {stateChangeMonotonic: 7000 * SECOND}), ok('b-job')];
    assert.deepEqual(tracker.observe(back, watchedOf('a-job', 'b-job')), []);
});

test('a run already announced is not announced again after the watch list was emptied', () => {
    const tracker = new FailureTracker();
    tracker.observe([calm('a-timer')], watchedOf('a-timer'));
    assert.equal(tracker.observe([sharing('a-timer', 5000 * SECOND)], watchedOf('a-timer')).length, 1);
    tracker.observe([], []);
    tracker.observe([ok('b-timer')], watchedOf('b-timer'));
    assert.deepEqual(tracker.observe([sharing('b-timer', 5000 * SECOND)], watchedOf('b-timer')), []);
});

test('after a stale period, a newer failed run notifies and a known one does not', () => {
    const tracker = new FailureTracker();
    const watched = watchedOf('a-job', 'b-job');
    tracker.observe([failed('a-job'), ok('b-job')], watched);
    const stale = [{...failed('a-job'), stale: true}, {...ok('b-job'), stale: true}];
    assert.deepEqual(tracker.observe(stale, watched), []);
    const back = [failed('a-job'), failed('b-job', {stateChangeMonotonic: 8000 * SECOND})];
    assert.deepEqual(tracker.observe(back, watched).map(routine => routine.name), ['b-job']);
});

const sharing = (unit, order) => ({
    ...read({unit: 'shared.service'}, {activeState: 'failed', subState: 'failed', result: 'exit-code',
        execMainStatus: 1, stateChangeMonotonic: order}, unit + '.timer'),
    stale: false,
});
const calm = unit => ({...read({unit: 'shared.service'}, {}, unit + '.timer'), stale: false});

test('two timers on one service share its failed runs and notify once, under the first name', () => {
    const tracker = new FailureTracker();
    const watched = watchedOf('a-timer', 'b-timer');
    tracker.observe([calm('a-timer'), calm('b-timer')], watched);
    const due = tracker.observe([sharing('b-timer', 5000 * SECOND), sharing('a-timer', 5000 * SECOND)], watched);
    assert.deepEqual(due.map(routine => routine.name), ['a-timer']);
    assert.deepEqual(tracker.observe([sharing('b-timer', 5000 * SECOND), sharing('a-timer', 5000 * SECOND)], watched), []);
    assert.equal(tracker.observe([sharing('b-timer', 6000 * SECOND), sharing('a-timer', 6000 * SECOND)], watched).length, 1);
});

test('a timer that joins a watched service does not hide its run from the timer already watched', () => {
    const tracker = new FailureTracker();
    tracker.observe([calm('b-timer')], watchedOf('b-timer'));
    // a-timer sorts first, and its first read is a baseline: the run is b-timer's to announce.
    const due = tracker.observe([sharing('a-timer', 5000 * SECOND), sharing('b-timer', 5000 * SECOND)],
        watchedOf('a-timer', 'b-timer'));
    assert.deepEqual(due.map(routine => routine.name), ['b-timer']);
});

test('a timer that first reads a shared run while the other is stale leaves the run to the other', () => {
    const tracker = new FailureTracker();
    const watched = watchedOf('a-timer', 'b-timer');
    tracker.observe([calm('b-timer')], watchedOf('b-timer'));
    // a-timer joins and reads the failure as its baseline while b-timer's read is stale.
    assert.deepEqual(tracker.observe([sharing('a-timer', 5000 * SECOND), {...sharing('b-timer', 5000 * SECOND), stale: true}],
        watched), []);
    const due = tracker.observe([sharing('a-timer', 5000 * SECOND), sharing('b-timer', 5000 * SECOND)], watched);
    assert.deepEqual(due.map(routine => routine.name), ['b-timer']);
    assert.deepEqual(tracker.observe([sharing('a-timer', 5000 * SECOND), sharing('b-timer', 5000 * SECOND)], watched), []);
});

test('a run announced while a sharing timer was stale is not announced again when it returns', () => {
    const tracker = new FailureTracker();
    const watched = watchedOf('a-timer', 'b-timer');
    tracker.observe([calm('a-timer'), calm('b-timer')], watched);
    assert.equal(tracker.observe([sharing('a-timer', 5000 * SECOND), {...calm('b-timer'), stale: true}], watched).length, 1);
    assert.deepEqual(tracker.observe([sharing('a-timer', 5000 * SECOND), sharing('b-timer', 5000 * SECOND)], watched), []);
});

test('a failure read while stale is not known: the fresh read of it notifies', () => {
    const tracker = new FailureTracker();
    const watched = watchedOf('a-job');
    tracker.observe([ok('a-job')], watched);
    assert.deepEqual(tracker.observe([{...failed('a-job', {stateChangeMonotonic: 5000 * SECOND}), stale: true}], watched), []);
    assert.equal(tracker.observe([failed('a-job', {stateChangeMonotonic: 5000 * SECOND})], watched).length, 1);
});

test('two timers that read different runs of one service each notify their run', () => {
    const tracker = new FailureTracker();
    const watched = watchedOf('a-timer', 'b-timer');
    tracker.observe([calm('a-timer'), calm('b-timer')], watched);
    const due = tracker.observe([sharing('a-timer', 6000 * SECOND), sharing('b-timer', 5000 * SECOND)], watched);
    assert.deepEqual(due.map(routine => routine.name), ['a-timer', 'b-timer']);
    assert.deepEqual(tracker.observe([sharing('a-timer', 6000 * SECOND), sharing('b-timer', 5000 * SECOND)], watched), []);
});

test('a timer failure belongs to its timer alone', () => {
    const tracker = new FailureTracker();
    const watched = watchedOf('a-timer', 'b-timer');
    const timerFailure = unit => ({
        ...read({result: 'trigger-limit-hit', stateChangeMonotonic: 5000 * SECOND}, {}, unit + '.timer'),
        stale: false,
    });
    tracker.observe([ok('a-timer'), ok('b-timer')], watched);
    const due = tracker.observe([timerFailure('a-timer'), timerFailure('b-timer')], watched);
    assert.deepEqual(due.map(routine => routine.name), ['a-timer', 'b-timer']);
});

test('a run that failed and recovered between two reads is never observed', () => {
    const tracker = new FailureTracker();
    const watched = watchedOf('a-job');
    tracker.observe([ok('a-job')], watched);
    assert.deepEqual(tracker.observe([ok('a-job', {stateChangeMonotonic: 5000 * SECOND})], watched), []);
});

test('a routine that is not watched any more is ignored', () => {
    const tracker = new FailureTracker();
    assert.deepEqual(tracker.observe([failed('a-job')], []), []);
});

test('the notification names the routine, the cause, and the time of the run', () => {
    const routine = failed('nightly-report', {stateChange: NOW - 2 * MINUTE});
    assert.deepEqual(failureNotification(routine), {title: 'nightly-report failed', body: 'exit code 1 · 12:12'});
    assert.equal(logsFailureTitle(routine), 'Could not open the logs of nightly-report');
});

test('the dot shows while a routine is failed, stale or not, and the indicator name follows', () => {
    assert.equal(hasFailedRoutine([]), false);
    assert.equal(hasFailedRoutine([ok('a-job'), ok('b-job')]), false);
    assert.equal(indicatorName([ok('a-job')]), 'Greenlight');
    const routines = [ok('a-job'), failed('b-job')];
    assert.equal(hasFailedRoutine(routines), true);
    assert.equal(indicatorName(routines), 'Greenlight, a routine failed');
    assert.equal(hasFailedRoutine([{...failed('b-job'), stale: true}]), true);
    assert.equal(hasFailedRoutine([read({}, null)]), false);
});
