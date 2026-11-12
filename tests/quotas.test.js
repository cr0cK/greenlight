import assert from 'node:assert/strict';
import {test} from 'node:test';

import {
    MESSAGES,
    codexMessages,
    formatAge,
    formatReset,
    notificationTitle,
    paceFraction,
    parseClaudeReset,
    parseClaudeUsage,
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
            {label: '5 h', usedPercent: 38, durationSeconds: 18000, resetsAt: Date.UTC(2026, 10, 12, 14) / 1000},
            {label: 'Week', usedPercent: 50, durationSeconds: 604800, resetsAt: Date.UTC(2026, 10, 16, 5, 59) / 1000},
        ],
    });

    const weekOnly = parseClaudeUsage(claudeAnswer(SUBSCRIPTION +
        'Current week (all models): 12.5% used · resets Nov 16, 6:59am (Europe/Paris)'), NOW);
    assert.deepEqual(weekOnly.windows.map(window => [window.label, window.usedPercent]), [['Week', 12.5]]);
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
        {label: '5 h', usedPercent: 40, durationSeconds: 18000, resetsAt: 1794500000},
        {label: 'Week', usedPercent: 16, durationSeconds: 604800, resetsAt: 1795007850},
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
    assert.deepEqual(legacy.windows, [{label: 'Quota', usedPercent: 7, durationSeconds: null, resetsAt: null}]);
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
});

test('notifies each period once, after a quiet baseline', () => {
    const week = usedPercent => ({label: 'Week', usedPercent, durationSeconds: 604800, resetsAt: NOW + 86400});
    const track = (windows, notified, baseline = false) =>
        trackPeriods({provider: 'claude', windows, notified, threshold: 80, baseline, now: NOW});

    // The baseline marks periods already over the threshold without notifying.
    const baseline = track([week(85)], [], true);
    assert.deepEqual(baseline.alerts, []);
    assert.equal(track([week(90)], baseline.notified).alerts.length, 0);

    // A baseline under the threshold leaves the period free to notify when it crosses.
    const quiet = track([week(40)], [], true);
    assert.deepEqual(quiet.notified, []);
    const crossed = track([week(81)], quiet.notified);
    assert.deepEqual(crossed.alerts, [week(81)]);
    assert.deepEqual(track([week(95)], crossed.notified).alerts, []);

    // A new period that starts above the threshold notifies, and stale marks are dropped.
    const next = {...week(85), resetsAt: NOW + 8 * 86400};
    const stale = 'claude:Week:' + (NOW - 10);
    const renewed = track([next], [...crossed.notified, stale]);
    assert.deepEqual(renewed.alerts, [next]);
    assert.ok(!renewed.notified.includes(stale));

    // A reading past its reset says nothing about the new period.
    assert.deepEqual(track([{...week(99), resetsAt: NOW - 5}], []).alerts, []);

    // A window without a reset has no period: it never notifies nor leaves a mark.
    assert.deepEqual(track([{...week(99), resetsAt: null}], ['claude:Week:none']),
        {notified: [], alerts: []});
});

test('reads the quota cache defensively', () => {
    assert.deepEqual(readQuotaCache('not json'), {providers: {}, notified: []});
    const window = {label: 'Week', usedPercent: 16, durationSeconds: 604800, resetsAt: 1795007850};
    assert.deepEqual(readQuotaCache(JSON.stringify({
        providers: {
            codex: {windows: [window], readAt: NOW},
            claude: {windows: [{label: 'Week'}], readAt: NOW},
            other: {windows: [window], readAt: NOW},
        },
        notified: ['codex:Week:1795007850', 3],
    })), {providers: {codex: {windows: [window], readAt: NOW}}, notified: ['codex:Week:1795007850']});
});
