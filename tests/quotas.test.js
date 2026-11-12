import assert from 'node:assert/strict';
import {test} from 'node:test';

import {
    MESSAGES,
    codexMessages,
    formatAge,
    forgetPeriods,
    formatReset,
    isAgyAuthError,
    notificationTitle,
    paceFraction,
    parseAgyRun,
    parseClaudeReset,
    parseClaudeRun,
    parseCodexResponse,
    readQuotaCache,
    trackPeriods,
    windowLabel,
} from '../src/quotas.js';

// Local times in formatReset follow the runner's zone; pin it.
process.env.TZ = 'UTC';

// Thursday 12 November 2026, 13:00 UTC (14:00 in Paris).
const NOW = Date.UTC(2026, 10, 12, 13, 0) / 1000;

const claudeAnswer = (result, extra = {}) => JSON.stringify({
    type: 'result', is_error: false, num_turns: 0, total_cost_usd: 0, result, ...extra,
});

// A finished claude run; stdout is read before the exit status.
const run = (stdout, exit = {}) => ({stdout, exitCode: 0, signal: null, ...exit});
const parseClaudeUsage = (stdout, now) => parseClaudeRun(run(stdout), now);

const SUBSCRIPTION = 'You are currently using your subscription to power your Claude Code usage\n\n';

test('labels windows by their length', () => {
    assert.equal(windowLabel(5 * 3600), '5 h');
    assert.equal(windowLabel(7 * 86400), 'Week');
    assert.equal(windowLabel(30 * 86400), '30 d');
    assert.equal(windowLabel(24 * 3600), '1 d');
    assert.equal(windowLabel(90 * 60), '90 min');
    assert.equal(windowLabel(null), 'Quota');
    assert.equal(windowLabel(0), 'Quota');
});

test('reads claude /usage reset times in their zone', () => {
    assert.equal(parseClaudeReset('Nov 16, 6:59am (Europe/Paris)', NOW), Date.UTC(2026, 10, 16, 5, 59) / 1000);
    assert.equal(parseClaudeReset('3pm (Europe/Paris)', NOW), Date.UTC(2026, 10, 12, 14, 0) / 1000);
    // Already past today: the next one is tomorrow.
    assert.equal(parseClaudeReset('1pm (Europe/Paris)', NOW), Date.UTC(2026, 10, 13, 12, 0) / 1000);
    assert.equal(parseClaudeReset('12am (UTC)', NOW), Date.UTC(2026, 10, 13, 0, 0) / 1000);
    assert.equal(parseClaudeReset('12:30pm (UTC)', NOW), Date.UTC(2026, 10, 12, 12, 30) / 1000 + 86400);
    // Summer time applies on the reset's own date.
    assert.equal(parseClaudeReset('Jul 3, 9am (Europe/Paris)', NOW), Date.UTC(2027, 6, 3, 7, 0) / 1000);
    const lateDecember = Date.UTC(2026, 11, 30, 12) / 1000;
    assert.equal(parseClaudeReset('Jan 2, 9am (UTC)', lateDecember), Date.UTC(2027, 0, 2, 9) / 1000);
    assert.equal(parseClaudeReset('Nov 16, 6:59am (Not/AZone)', NOW), null);
    assert.equal(parseClaudeReset('soon', NOW), null);
    // A day the month does not have is not a reset.
    assert.equal(parseClaudeReset('Nov 31, 9am (UTC)', NOW), null);
    assert.equal(parseClaudeReset('Feb 29, 9am (UTC)', NOW), null);
    assert.equal(parseClaudeReset('Nov 0, 9am (UTC)', NOW), null);
    assert.equal(parseClaudeReset('Nov 30, 9am (UTC)', NOW), Date.UTC(2026, 10, 30, 9) / 1000);
    // A February 29 that only the next year has belongs to the next year.
    const lateDecember2027 = Date.UTC(2027, 11, 30, 12) / 1000;
    assert.equal(parseClaudeReset('Feb 29, 9am (UTC)', lateDecember2027), Date.UTC(2028, 1, 29, 9) / 1000);
    assert.equal(parseClaudeReset('13pm (UTC)', NOW), null);
});

test('reads the subscription windows of claude /usage', () => {
    const usage = parseClaudeUsage(claudeAnswer(SUBSCRIPTION +
        'Current session: 38% used · resets 3pm (Europe/Paris)\n' +
        'Current week (all models): 50% used · resets Nov 16, 6:59am (Europe/Paris)\n' +
        'Current week (Fable): 4% used · resets Nov 16, 6:59am (Europe/Paris)\n\n' +
        'What\'s contributing to your usage?\n  82%  Give simple subagents a cheaper model'), NOW);
    assert.deepEqual(usage, {
        status: 'ok',
        windows: [
            {slot: 'session', label: '5 h', usedPercent: 38, durationSeconds: 18000,
                resetsAt: Date.UTC(2026, 10, 12, 14) / 1000},
            {slot: 'week', label: 'Week', usedPercent: 50, durationSeconds: 604800,
                resetsAt: Date.UTC(2026, 10, 16, 5, 59) / 1000},
        ],
    });

    const weekOnly = parseClaudeUsage(claudeAnswer(SUBSCRIPTION +
        'Current week (all models): 12.5% used · resets Nov 16, 6:59am (Europe/Paris)'), NOW);
    assert.deepEqual(weekOnly.windows.map(window => [window.slot, window.label, window.usedPercent]),
        [['week', 'Week', 12.5]]);

    // Lines follow the slot order, whatever the order of the answer.
    const swapped = parseClaudeUsage(claudeAnswer(SUBSCRIPTION +
        'Current week (all models): 50% used · resets Nov 16, 6:59am (Europe/Paris)\n' +
        'Current session: 38% used · resets 3pm (Europe/Paris)'), NOW);
    assert.deepEqual(swapped.windows.map(window => window.slot), ['session', 'week']);
});

test('tells an unusable claude from a transient failure', () => {
    // Signed out, or on an API key: /usage prints the session costs.
    assert.deepEqual(parseClaudeUsage(claudeAnswer('Total cost:            $0.0000\nUsage: 0 input'), NOW),
        {status: 'unavailable', message: MESSAGES.claudeNotSubscribed});
    assert.deepEqual(parseClaudeUsage(claudeAnswer(SUBSCRIPTION + 'Something new: 40%'), NOW),
        {status: 'unavailable', message: MESSAGES.claudeUnknown});
    assert.deepEqual(parseClaudeUsage(claudeAnswer('API Error: 529 Overloaded\nretry', {is_error: true}), NOW),
        {status: 'failed', message: 'API Error: 529 Overloaded'});
    assert.equal(parseClaudeUsage('', NOW).status, 'failed');
    assert.equal(parseClaudeUsage('null', NOW).status, 'failed');
});

test('reads claude stdout before its exit status', () => {
    const failure = claudeAnswer('API Error: 529 Overloaded\nretry', {is_error: true});
    // The CLI's own message wins over the exit code.
    assert.deepEqual(parseClaudeRun(run(failure, {exitCode: 1}), NOW),
        {status: 'failed', message: 'API Error: 529 Overloaded'});
    assert.deepEqual(parseClaudeRun(run(failure), NOW),
        {status: 'failed', message: 'API Error: 529 Overloaded'});
    assert.deepEqual(parseClaudeRun(run(claudeAnswer('', {is_error: true})), NOW),
        {status: 'failed', message: 'reported an error'});

    // Without an error in stdout, the exit status is the cause.
    assert.deepEqual(parseClaudeRun(run('', {exitCode: 2}), NOW),
        {status: 'failed', message: 'exited with code 2'});
    assert.deepEqual(parseClaudeRun(run('Segmentation fault', {exitCode: 139}), NOW),
        {status: 'failed', message: 'exited with code 139'});
    assert.deepEqual(parseClaudeRun(run(claudeAnswer(SUBSCRIPTION + 'Current session: 5% used'),
        {exitCode: 1}), NOW), {status: 'failed', message: 'exited with code 1'});
    assert.deepEqual(parseClaudeRun(run('', {exitCode: null, signal: 9}), NOW),
        {status: 'failed', message: 'killed by signal 9'});

    // A clean exit with something that is not JSON is a transient failure too.
    assert.deepEqual(parseClaudeRun(run('hello'), NOW),
        {status: 'failed', message: 'answered with something that is not JSON'});
});

test('pipelines the codex app-server messages, one per line', () => {
    const lines = codexMessages('1.3.0').trimEnd().split('\n').map(line => JSON.parse(line));
    assert.deepEqual(lines.map(line => [line.id, line.method]),
        [[1, 'initialize'], [undefined, 'initialized'], [2, 'account/rateLimits/read']]);
    assert.deepEqual(lines[0].params.clientInfo, {name: 'greenlight', version: '1.3.0'});
});

test('reads the codex bucket and its windows', () => {
    const bucket = (primary, secondary = null) => ({limitId: 'codex', primary, secondary});
    const response = parseCodexResponse({id: 2, result: {
        rateLimits: bucket({usedPercent: 99, windowDurationMins: 300, resetsAt: 1}),
        rateLimitsByLimitId: {
            codex: bucket({usedPercent: 16, windowDurationMins: 10080, resetsAt: 1795007850},
                {usedPercent: 40, windowDurationMins: 300, resetsAt: 1794500000}),
            other: bucket({usedPercent: 80, windowDurationMins: 60, resetsAt: 1}),
        },
    }});
    assert.deepEqual(response, {status: 'ok', windows: [
        {slot: 'primary', label: 'Week', usedPercent: 16, durationSeconds: 604800, resetsAt: 1795007850},
        {slot: 'secondary', label: '5 h', usedPercent: 40, durationSeconds: 18000, resetsAt: 1794500000},
    ]});

    // With the map but no codex bucket, another feature's bucket is never shown.
    assert.deepEqual(parseCodexResponse({id: 2, result: {
        rateLimits: bucket({usedPercent: 92, windowDurationMins: 300, resetsAt: 1}),
        rateLimitsByLimitId: {review: bucket({usedPercent: 92, windowDurationMins: 300, resetsAt: 1})},
    }}), {status: 'unavailable', message: MESSAGES.codexNoQuota});

    // Without the map, the legacy single bucket; a window without a length reads Quota.
    const legacy = parseCodexResponse({id: 2, result: {
        rateLimits: bucket({usedPercent: 7, windowDurationMins: null, resetsAt: null}),
    }});
    assert.deepEqual(legacy.windows,
        [{slot: 'primary', label: 'Quota', usedPercent: 7, durationSeconds: null, resetsAt: null}]);
});

test('tells an unusable codex from a transient failure', () => {
    assert.deepEqual(parseCodexResponse({id: 2, error: {code: -32600,
        message: 'codex account authentication required to read rate limits'}}),
    {status: 'unavailable', message: MESSAGES.codexNotSignedIn});
    assert.deepEqual(parseCodexResponse({id: 2, error: {code: -32601, message: 'Method not found'}}),
        {status: 'unavailable', message: MESSAGES.codexTooOld});
    assert.deepEqual(parseCodexResponse({id: 2, error: {code: -32600,
        message: 'Invalid request: unknown variant `account/rateLimits/read`'}}),
    {status: 'unavailable', message: MESSAGES.codexTooOld});
    assert.deepEqual(parseCodexResponse({id: 2, result: {rateLimits: {primary: null, secondary: null}}}),
        {status: 'unavailable', message: MESSAGES.codexNoQuota});
    assert.deepEqual(parseCodexResponse({id: 2, error: {code: -32603, message: 'upstream timeout'}}),
        {status: 'failed', message: 'upstream timeout'});
});

const bucket = (id, remaining, reset = '2026-11-19T10:53:04Z') => ({
    id, window: id.endsWith('5h') ? '5h' : 'weekly', remaining_fraction: remaining, reset_time: reset,
});
const agyAnswer = (groups, extra = {}) => JSON.stringify({
    conversation_id: '', status: 'SUCCESS', response: '', num_turns: 0,
    command: {name: 'usage', data: {description: '', groups}}, ...extra,
});
const GEMINI = {name: 'Gemini Models', buckets: [
    bucket('gemini-weekly', 0.9996, '2026-11-19T10:53:04Z'),
    bucket('gemini-5h', 0.75, '2026-11-12T15:48:40Z'),
]};
const OTHER = {name: 'Claude and GPT models', buckets: [bucket('3p-weekly', 0.5), bucket('3p-5h', 0.5)]};
const parseAgy = (stdout, exit = {}) => parseAgyRun(run(stdout, exit));

test('reads the Gemini windows of agy /usage in slot order', () => {
    // The weekly bucket comes first in the answer; the 5 h window still leads.
    assert.deepEqual(parseAgy(agyAnswer([GEMINI, OTHER])), {
        status: 'ok',
        windows: [
            {slot: 'gemini-5h', label: '5 h', usedPercent: 25, durationSeconds: 18000,
                resetsAt: Date.UTC(2026, 10, 12, 15, 48, 40) / 1000},
            {slot: 'gemini-weekly', label: 'Week', usedPercent: (1 - 0.9996) * 100,
                durationSeconds: 604800, resetsAt: Date.UTC(2026, 10, 19, 10, 53, 4) / 1000},
        ],
    });
    // The group's name does not matter, only the bucket ids.
    const renamed = parseAgy(agyAnswer([{name: 'Anything', buckets: GEMINI.buckets}]));
    assert.deepEqual(renamed.windows.map(window => window.slot), ['gemini-5h', 'gemini-weekly']);
    // A used-up window reads 100, and an impossible fraction is clamped.
    assert.equal(parseAgy(agyAnswer([{buckets: [bucket('gemini-5h', 0)]}])).windows[0].usedPercent, 100);
    assert.equal(parseAgy(agyAnswer([{buckets: [bucket('gemini-5h', 1.2)]}])).windows[0].usedPercent, 0);
});

test('shows only the agy buckets that carry a fraction', () => {
    const disabled = {id: 'gemini-weekly', window: 'weekly', reset_time: '2026-11-19T10:53:04Z'};
    const usage = parseAgy(agyAnswer([{buckets: [disabled, bucket('gemini-5h', 1)]}]));
    assert.deepEqual(usage.windows.map(window => window.slot), ['gemini-5h']);
    assert.equal(usage.windows[0].usedPercent, 0);
    for (const remaining of ['0.5', null, NaN])
        assert.equal(parseAgy(agyAnswer([{buckets: [bucket('gemini-5h', remaining)]}])).status, 'unavailable');
    // An unreadable reset time reads as none.
    for (const invalid of ['soon', '2026-02-30T10:00:00Z', '2026-13-01T10:00:00Z', '2026-11-12T25:00:00Z',
        '2026-11-12T10:00:00', '2026-11-12', 12])
        assert.equal(parseAgy(agyAnswer([{buckets: [bucket('gemini-5h', 1, invalid)]}])).windows[0].resetsAt, null, String(invalid));
    // An offset is read, and a leap day exists in a leap year only.
    assert.equal(parseAgy(agyAnswer([{buckets: [bucket('gemini-5h', 1, '2028-02-29T12:00:00+02:00')]}])).windows[0].resetsAt,
        Date.UTC(2028, 1, 29, 10) / 1000);
    assert.equal(parseAgy(agyAnswer([{buckets: [bucket('gemini-5h', 1, '2027-02-29T12:00:00Z')]}])).windows[0].resetsAt, null);
    assert.equal(parseAgy(agyAnswer([{buckets: [{id: 'gemini-5h', remaining_fraction: 1}]}])).windows[0].resetsAt, null);
    // Whole epoch seconds keep periods storable in the cache.
    const fractional = parseAgy(agyAnswer([{buckets: [bucket('gemini-5h', 1, '2026-11-12T15:48:40.900Z')]}]));
    assert.equal(fractional.windows[0].resetsAt, Date.UTC(2026, 10, 12, 15, 48, 40) / 1000);
    // The first bucket of a slot wins.
    const twice = parseAgy(agyAnswer([GEMINI, {buckets: [bucket('gemini-5h', 0.1)]}]));
    assert.equal(twice.windows[0].usedPercent, 25);
});

test('tells an unusable agy from a transient failure', () => {
    const unknown = {status: 'unavailable', message: MESSAGES.agyUnknown};
    const noQuota = {status: 'unavailable', message: MESSAGES.agyNoQuota};
    // No Gemini Models group, or groups without a Gemini window.
    assert.deepEqual(parseAgy(agyAnswer([OTHER])), noQuota);
    assert.deepEqual(parseAgy(agyAnswer([])), noQuota);
    assert.deepEqual(parseAgy(agyAnswer([{name: 'Gemini Models'}, null])), noQuota);
    // No groups at all, or a SUCCESS in another form.
    assert.deepEqual(parseAgy(JSON.stringify({status: 'SUCCESS', command: {data: {}}})), unknown);
    assert.deepEqual(parseAgy(JSON.stringify({status: 'SUCCESS'})), unknown);
    assert.deepEqual(parseAgy(JSON.stringify({command: {data: {groups: [GEMINI]}}})), unknown);
    assert.deepEqual(parseAgy(JSON.stringify([GEMINI])), unknown);

    // Output that is not JSON: unknown after a zero exit, transient after anything else.
    assert.deepEqual(parseAgy('Usage: agy [options]'), unknown);
    assert.deepEqual(parseAgy(''), unknown);
    assert.deepEqual(parseAgy('5'), unknown);
    assert.deepEqual(parseAgy('oops', {exitCode: 1}), {status: 'failed', message: 'exited with code 1'});
    assert.deepEqual(parseAgy('', {exitCode: null, signal: 9}), {status: 'failed', message: 'killed by signal 9'});

    // A status other than SUCCESS fails with the first line of the response, or the status.
    const error = (extra, exit) => parseAgy(JSON.stringify({status: 'ERROR', ...extra}), exit);
    assert.deepEqual(error({response: 'quota service down\nsee logs'}, {exitCode: 1}),
        {status: 'failed', message: 'quota service down'});
    assert.deepEqual(error({response: '  '}), {status: 'failed', message: 'ERROR'});
    assert.deepEqual(error({}), {status: 'failed', message: 'ERROR'});
    // Stdout is read before the exit status, and a good answer cannot hide a bad exit.
    assert.deepEqual(error({response: 'no'}, {exitCode: 3}), {status: 'failed', message: 'no'});
    assert.deepEqual(parseAgy(agyAnswer([GEMINI]), {exitCode: 2}),
        {status: 'failed', message: 'exited with code 2'});
    assert.deepEqual(parseAgy(agyAnswer([GEMINI]), {exitCode: null, signal: 15}),
        {status: 'failed', message: 'killed by signal 15'});
});

test('recognizes an agy authentication error by its failure phrase', () => {
    for (const phrase of ['authentication required', 'authentication failed', 'unauthorized',
        'unauthorised', 'unauthenticated', 'not logged in', 'not signed in']) {
        assert.ok(isAgyAuthError(phrase), phrase);
        assert.ok(isAgyAuthError(phrase.toUpperCase()), phrase);
        assert.ok(isAgyAuthError(`Warning: ${phrase} (token refresh), retrying`), phrase);
    }
    assert.ok(isAgyAuthError('Authentication required. Please visit the URL to log in:'));
    assert.ok(isAgyAuthError('Error: authentication required. Run \'agy\' to log in, then retry.'));
    assert.ok(isAgyAuthError('error: authentication failed or timed out'));
    assert.ok(isAgyAuthError('Warning: unauthorized token refresh'));
    assert.ok(!isAgyAuthError('Authenticated successfully'));
    assert.ok(!isAgyAuthError('design input'));
    assert.ok(!isAgyAuthError('  https://accounts.google.com/o/oauth2/auth?access_type=offline'));
    assert.ok(!isAgyAuthError('Waiting for authentication (timeout 60s)...'));
    assert.ok(!isAgyAuthError('Authentication requirements changed'));
    assert.ok(!isAgyAuthError('preunauthorized access'));
    assert.ok(!isAgyAuthError(''));
});

test('reads an agy error answer: authentication errors are unavailable, others transient', () => {
    const error = (extra, exit = {exitCode: 1}) => parseAgy(JSON.stringify({status: 'ERROR', ...extra}), exit);
    const signedOut = {status: 'unavailable', message: MESSAGES.agyNotSignedIn};
    assert.deepEqual(error({response: '', error: 'authentication failed or timed out'}), signedOut);
    assert.deepEqual(error({response: 'Not signed in\nsee logs'}), signedOut);
    assert.deepEqual(error({response: 'fine', error: 'Unauthorized'}), signedOut);
    // The error field is the cause, before the response and the status.
    assert.deepEqual(error({response: '', error: 'quota service down\nsee logs'}),
        {status: 'failed', message: 'quota service down'});
    assert.deepEqual(error({response: 'other', error: 'quota service down'}),
        {status: 'failed', message: 'quota service down'});
    assert.deepEqual(error({response: 'other', error: '  '}), {status: 'failed', message: 'other'});
    // Only the first line of the response counts.
    assert.deepEqual(error({response: 'busy\nunauthorized'}), {status: 'failed', message: 'busy'});
});

test('places the pace mark at the elapsed share of the window', () => {
    const week = {durationSeconds: 604800, resetsAt: NOW + 2 * 86400};
    assert.equal(paceFraction(week, NOW), 5 / 7);
    assert.equal(paceFraction({...week, resetsAt: NOW + 10 * 86400}, NOW), 0);
    assert.equal(paceFraction({...week, resetsAt: NOW - 1}, NOW), 1);
    assert.equal(paceFraction({durationSeconds: null, resetsAt: NOW + 1}, NOW), null);
    assert.equal(paceFraction({durationSeconds: 18000, resetsAt: null}, NOW), null);
});

test('formats resets and ages', () => {
    assert.equal(formatReset({resetsAt: NOW + 2 * 3600 + 10 * 60}, NOW), 'resets in 2 h 10 min');
    assert.equal(formatReset({resetsAt: NOW + 3 * 3600}, NOW), 'resets in 3 h');
    assert.equal(formatReset({resetsAt: NOW + 20}, NOW), 'resets in 1 min');
    assert.equal(formatReset({resetsAt: Date.UTC(2026, 10, 14, 9, 0) / 1000}, NOW), 'resets Sat 09:00');
    assert.equal(formatReset({resetsAt: NOW - 1}, NOW), 'reset · waiting for a new reading');
    assert.equal(formatReset({resetsAt: null}, NOW), '');
    assert.deepEqual([30, 720, 3 * 3600, 2 * 86400].map(formatAge),
        ['just now', '12 min ago', '3 h ago', '2 d ago']);
});

test('names the window in notifications', () => {
    assert.equal(notificationTitle('claude', {label: 'Week', usedPercent: 82.4}), 'Claude weekly quota at 82 %');
    assert.equal(notificationTitle('codex', {label: '5 h', usedPercent: 90}), 'Codex 5-hour quota at 90 %');
    assert.equal(notificationTitle('codex', {label: '30 d', usedPercent: 85}), 'Codex 30-day quota at 85 %');
    assert.equal(notificationTitle('codex', {label: 'Quota', usedPercent: 85}), 'Codex quota at 85 %');
    assert.equal(notificationTitle('codex', {label: '90 min', usedPercent: 85}), 'Codex 90-minute quota at 85 %');
    assert.equal(notificationTitle('codex', {label: '1 d', usedPercent: 85}), 'Codex 1-day quota at 85 %');
});

test('notifies each period once, after a quiet baseline', () => {
    const week = usedPercent => ({
        slot: 'week', label: 'Week', usedPercent, durationSeconds: 604800, resetsAt: NOW + 86400,
    });
    const track = (windows, notified, baseline = false) =>
        trackPeriods({provider: 'claude', windows, notified, threshold: 80, baseline, now: NOW});

    // The baseline marks periods already over the threshold without notifying.
    const baseline = track([week(85)], [], true);
    assert.deepEqual(baseline.alerts, []);
    assert.deepEqual(baseline.notified, ['claude:week:' + (NOW + 86400)]);
    assert.equal(track([week(90)], baseline.notified).alerts.length, 0);

    // A baseline under the threshold leaves the period free to notify when it crosses.
    const quiet = track([week(40)], [], true);
    assert.deepEqual(quiet.notified, []);
    const crossed = track([week(81)], quiet.notified);
    assert.deepEqual(crossed.alerts, [week(81)]);
    assert.deepEqual(track([week(95)], crossed.notified).alerts, []);

    // A new period that starts above the threshold notifies, and stale marks are dropped.
    const next = {...week(85), resetsAt: NOW + 8 * 86400};
    const stale = 'claude:week:' + (NOW - 10);
    const renewed = track([next], [...crossed.notified, stale]);
    assert.deepEqual(renewed.alerts, [next]);
    assert.ok(!renewed.notified.includes(stale));

    // A reading past its reset says nothing about the new period.
    assert.deepEqual(track([{...week(99), resetsAt: NOW - 5}], []).alerts, []);

    // A window without a reset has no period: it never notifies nor leaves a mark.
    assert.deepEqual(track([{...week(99), resetsAt: null}], ['claude:week:none']),
        {notified: [], alerts: []});
});

test('identifies a period by its slot, not by its label', () => {
    const reset = NOW + 86400;
    const window = (slot, label) => ({slot, label, usedPercent: 90, durationSeconds: null, resetsAt: reset});
    const track = (windows, notified) =>
        trackPeriods({provider: 'codex', windows, notified, threshold: 80, baseline: false, now: NOW});

    // Two windows with the same label and reset time are two periods.
    const both = track([window('primary', 'Week'), window('secondary', 'Week')], []);
    assert.equal(both.alerts.length, 2);
    assert.deepEqual(both.notified, ['codex:primary:' + reset, 'codex:secondary:' + reset]);

    // A window whose length changed keeps its period, so it does not notify again.
    assert.deepEqual(track([window('primary', '5 h')], both.notified).alerts, []);
});

test('keeps agy periods apart by slot and stores them in the cache', () => {
    const reset = NOW + 3600;
    const windows = ['gemini-5h', 'gemini-weekly'].map(slot =>
        ({slot, label: 'Week', usedPercent: 82, durationSeconds: 604800, resetsAt: reset}));
    const tracked = trackPeriods({provider: 'agy', windows, notified: [], threshold: 80, baseline: false, now: NOW});
    assert.deepEqual(tracked.notified, ['agy:gemini-5h:' + reset, 'agy:gemini-weekly:' + reset]);
    assert.equal(notificationTitle('agy', windows[1]), 'Antigravity weekly quota at 82 %');
    assert.equal(notificationTitle('agy', {...windows[0], label: '5 h'}), 'Antigravity 5-hour quota at 82 %');
    assert.deepEqual(forgetPeriods(tracked.notified, 'agy'), []);

    const cache = readQuotaCache(JSON.stringify({
        providers: {agy: {windows, readAt: NOW}}, notified: tracked.notified,
    }));
    assert.deepEqual(cache, {providers: {agy: {windows, readAt: NOW}}, notified: tracked.notified});
    // A Claude slot is not an Antigravity one.
    const stray = JSON.stringify({providers: {agy: {windows: [{...windows[0], slot: 'session'}], readAt: NOW}}});
    assert.deepEqual(readQuotaCache(stray).providers, {});
});

test('compares the rounded percentage with the threshold', () => {
    const reset = NOW + 86400;
    const window = usedPercent => ({slot: 'week', label: 'Week', usedPercent, durationSeconds: null, resetsAt: reset});
    const track = usedPercent => trackPeriods({
        provider: 'claude', windows: [window(usedPercent)], notified: [], threshold: 80, baseline: false, now: NOW,
    }).alerts.length;
    assert.equal(track(79.4), 0);
    assert.equal(track(79.5), 1);
    assert.equal(notificationTitle('claude', window(79.5)), 'Claude weekly quota at 80 %');
});

test('forgets the periods of one provider', () => {
    assert.deepEqual(forgetPeriods(['claude:week:10', 'codex:primary:20', 'codex:secondary:30'], 'codex'),
        ['claude:week:10']);
    assert.deepEqual(forgetPeriods(['claude:week:10'], 'codex'), ['claude:week:10']);
});

test('reads the quota cache defensively', () => {
    assert.deepEqual(readQuotaCache('not json'), {providers: {}, notified: []});
    const window = {
        slot: 'primary', label: 'Week', usedPercent: 16, durationSeconds: 604800, resetsAt: 1795007850,
    };
    assert.deepEqual(readQuotaCache(JSON.stringify({
        providers: {
            codex: {windows: [window], readAt: NOW},
            claude: {windows: [{slot: 'week', label: 'Week'}], readAt: NOW},
            other: {windows: [window], readAt: NOW},
        },
        notified: ['codex:primary:1795007850', 'codex:Week:1795007850', 'other:week:1', 3],
    })), {providers: {codex: {windows: [window], readAt: NOW}}, notified: ['codex:primary:1795007850']});

    // A slot of another provider, a missing one, or a malformed number rejects the reading.
    for (const bad of [{slot: 'week'}, {slot: undefined}, {resetsAt: 'soon'}, {durationSeconds: undefined}]) {
        const cache = JSON.stringify({providers: {codex: {windows: [{...window, ...bad}], readAt: NOW}}});
        assert.deepEqual(readQuotaCache(cache).providers, {}, JSON.stringify(bad));
    }
    const empty = JSON.stringify({providers: {codex: {windows: [], readAt: NOW}}});
    assert.deepEqual(readQuotaCache(empty).providers, {});
});

test('drops a cached reading written before windows had slots', () => {
    const old = {label: 'Week', usedPercent: 16, durationSeconds: 604800, resetsAt: 1795007850};
    assert.deepEqual(readQuotaCache(JSON.stringify({
        providers: {codex: {windows: [old], readAt: NOW}},
        notified: ['codex:Week:1795007850'],
    })), {providers: {}, notified: []});
});
