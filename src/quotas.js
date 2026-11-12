/**
 * Agent quota parsing, labels, pace, and notification periods (pure, no GNOME imports).
 *
 * Every provider normalizes its answer to windows of
 * `{slot, label, usedPercent, durationSeconds, resetsAt}`, with `resetsAt` in epoch seconds,
 * before anything is shown, notified, or stored. A window is identified by its slot, never by
 * its label: Claude has `session` and `week`, Codex `primary` and `secondary`, listed in that
 * order.
 */

const HOUR = 3600;
const DAY = 24 * HOUR;
const WEEK = 7 * DAY;
const SESSION = 5 * HOUR;

/** Arguments for the unmodified claude binary: no tokens, no saved session, no user hooks. */
export const CLAUDE_ARGS = [
    '-p', '/usage',
    '--no-session-persistence',
    '--output-format', 'json',
    '--settings', '{"disableAllHooks":true}',
];

export const PROVIDERS = {
    claude: {name: 'Claude', command: 'claude', setting: 'claude-quota-enabled',
        slots: ['session', 'week']},
    codex: {name: 'Codex', command: 'codex', setting: 'codex-quota-enabled',
        slots: ['primary', 'secondary']},
};

export const MESSAGES = {
    claudeNotSubscribed: 'Claude Code is not signed in with a Claude subscription. Run claude, then /login.',
    claudeUnknown: 'Claude Code answered /usage in an unknown form. Update Claude Code.',
    codexNotSignedIn: 'Codex is not signed in. Run codex login.',
    codexTooOld: 'This codex cannot report rate limits. Update Codex.',
    codexNoQuota: 'Codex reports no subscription quota. Sign in with ChatGPT: codex login.',
};

const SUBSCRIPTION_LINE = 'You are currently using your subscription';
const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

/** The CLI cannot give a quota until the user acts: hide the provider and say why. */
export function unavailable(message) {
    return {status: 'unavailable', message};
}

/** A failure that the next refresh may not repeat: keep the last reading. */
export function failed(message) {
    return {status: 'failed', message};
}

export function missingCliMessage(command) {
    return command + ' not found in PATH or ~/.local/bin';
}

/** Labels a window by its length: `5 h`, `Week`, `30 d`, or `Quota` without a length. */
export function windowLabel(durationSeconds) {
    if (!Number.isFinite(durationSeconds) || durationSeconds <= 0)
        return 'Quota';
    if (durationSeconds === WEEK)
        return 'Week';
    if (durationSeconds % DAY === 0)
        return durationSeconds / DAY + ' d';
    if (durationSeconds % HOUR === 0)
        return durationSeconds / HOUR + ' h';
    return Math.round(durationSeconds / 60) + ' min';
}

function createWindow(slot, usedPercent, durationSeconds, resetsAt) {
    return {
        slot,
        label: windowLabel(durationSeconds),
        usedPercent: Math.min(100, Math.max(0, usedPercent)),
        durationSeconds: Number.isFinite(durationSeconds) && durationSeconds > 0 ? durationSeconds : null,
        resetsAt: Number.isFinite(resetsAt) && resetsAt > 0 ? resetsAt : null,
    };
}

/** Offset of an IANA zone from UTC at an instant, in seconds; throws on an unknown zone. */
function zoneOffset(epochSeconds, timeZone) {
    const parts = new Intl.DateTimeFormat('en-US', {
        timeZone,
        hourCycle: 'h23',
        year: 'numeric',
        month: 'numeric',
        day: 'numeric',
        hour: 'numeric',
        minute: 'numeric',
        second: 'numeric',
    }).formatToParts(new Date(epochSeconds * 1000));
    const part = type => Number(parts.find(candidate => candidate.type === type).value);
    const wall = Date.UTC(part('year'), part('month') - 1, part('day'), part('hour'), part('minute'),
        part('second')) / 1000;
    return wall - epochSeconds;
}

/** Converts a wall time in an IANA zone to epoch seconds. */
function zonedTime(year, month, day, hour, minute, timeZone) {
    const wall = Date.UTC(year, month, day, hour, minute) / 1000;
    const first = wall - zoneOffset(wall, timeZone);
    return wall - zoneOffset(first, timeZone);
}

/** Today's date in an IANA zone, as `[year, monthIndex, day]`. */
function zonedDate(epochSeconds, timeZone) {
    const offset = zoneOffset(epochSeconds, timeZone);
    const date = new Date((epochSeconds + offset) * 1000);
    return [date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()];
}

/**
 * Reads a claude /usage reset such as `Nov 16, 6:59am (Europe/Paris)` or `3pm (Europe/Paris)`
 * as the next matching time, in epoch seconds; null when it cannot be read.
 */
export function parseClaudeReset(text, now) {
    const match = /^(?:([A-Za-z]{3,9})\.? (\d{1,2}),?(?: at)? )?(\d{1,2})(?::(\d{2}))?\s*(am|pm)?\s*\(([^)]+)\)$/i
        .exec(text.trim());
    if (!match)
        return null;

    const [, monthName, dayText, hourText, minuteText, meridiem, timeZone] = match;
    let hour = Number(hourText);
    const minute = Number(minuteText ?? 0);
    if (meridiem) {
        if (hour < 1 || hour > 12)
            return null;
        hour = hour % 12 + (meridiem.toLowerCase() === 'pm' ? 12 : 0);
    }
    if (hour > 23 || minute > 59)
        return null;

    try {
        const [year, month, day] = zonedDate(now, timeZone);
        if (!monthName) {
            const today = zonedTime(year, month, day, hour, minute, timeZone);
            return today >= now - 60 ? today : zonedTime(year, month, day + 1, hour, minute, timeZone);
        }

        const monthIndex = MONTHS.indexOf(monthName.slice(0, 3).toLowerCase());
        if (monthIndex < 0)
            return null;
        // A day the month does not have, such as Nov 31, is not a reset.
        const dayOfMonth = Number(dayText);
        const exists = candidate =>
            dayOfMonth >= 1 && dayOfMonth <= new Date(Date.UTC(candidate, monthIndex + 1, 0)).getUTCDate();
        // A reset is never far in the past: a date before yesterday belongs to next year.
        if (exists(year)) {
            const thisYear = zonedTime(year, monthIndex, dayOfMonth, hour, minute, timeZone);
            if (thisYear >= now - DAY)
                return thisYear;
        }
        return exists(year + 1) ? zonedTime(year + 1, monthIndex, dayOfMonth, hour, minute, timeZone) : null;
    } catch {
        return null;
    }
}

function firstLine(text) {
    return String(text).trim().split('\n')[0].trim();
}

/**
 * Reads a finished `claude -p /usage --output-format json` run, stdout before the exit status:
 * JSON with `is_error` is a transient failure whose cause is the first line of its `result`;
 * otherwise a signal, a non-zero exit, or output that is not JSON is one too. Only the
 * `Current session` and `Current week (all models)` lines count; per-model lines and the advice
 * are ignored.
 */
export function parseClaudeRun({stdout, exitCode, signal}, now) {
    let answer = null;
    try {
        answer = JSON.parse(stdout);
    } catch {
        // Handled below, once the exit status had its say.
    }
    const isAnswer = answer !== null && typeof answer === 'object';
    if (isAnswer && answer.is_error) {
        return failed(typeof answer.result === 'string' && answer.result.trim()
            ? firstLine(answer.result)
            : 'reported an error');
    }
    if (signal)
        return failed('killed by signal ' + signal);
    if (exitCode !== 0)
        return failed('exited with code ' + exitCode);
    if (!isAnswer)
        return failed('answered with something that is not JSON');

    const text = typeof answer.result === 'string' ? answer.result.trim() : '';
    // Signed out or on an API key, /usage prints the session costs instead.
    if (!text.startsWith(SUBSCRIPTION_LINE))
        return unavailable(MESSAGES.claudeNotSubscribed);

    const found = new Map();
    const patterns = [
        ['session', /^Current session:\s*(\d+(?:\.\d+)?)% used(?:\s*·\s*resets (.+))?$/, SESSION],
        ['week', /^Current week \(all models\):\s*(\d+(?:\.\d+)?)% used(?:\s*·\s*resets (.+))?$/, WEEK],
    ];
    for (const line of text.split('\n').map(candidate => candidate.trim())) {
        for (const [slot, pattern, duration] of patterns) {
            const match = pattern.exec(line);
            if (match && !found.has(slot)) {
                const resetsAt = match[2] ? parseClaudeReset(match[2], now) : null;
                found.set(slot, createWindow(slot, Number(match[1]), duration, resetsAt));
            }
        }
    }
    const windows = PROVIDERS.claude.slots.filter(slot => found.has(slot)).map(slot => found.get(slot));
    return windows.length > 0 ? {status: 'ok', windows} : unavailable(MESSAGES.claudeUnknown);
}

/**
 * The three messages `codex app-server` needs, one JSON object per line. They can be written
 * at once: the server handles them in order.
 */
export function codexMessages(version) {
    return [
        {jsonrpc: '2.0', id: 1, method: 'initialize',
            params: {clientInfo: {name: 'greenlight', version: String(version)}}},
        {jsonrpc: '2.0', method: 'initialized'},
        {jsonrpc: '2.0', id: 2, method: 'account/rateLimits/read'},
    ].map(message => JSON.stringify(message) + '\n').join('');
}

function codexWindow(slot, raw) {
    if (!raw || typeof raw !== 'object' || !Number.isFinite(raw.usedPercent))
        return null;
    const minutes = Number.isFinite(raw.windowDurationMins) ? raw.windowDurationMins : null;
    return createWindow(slot, raw.usedPercent, minutes === null ? null : minutes * 60, raw.resetsAt);
}

/** Reads the `account/rateLimits/read` response (the message with id 2). */
export function parseCodexResponse(message) {
    if (!message || typeof message !== 'object')
        return failed('answered with something that is not JSON');
    if (message.error) {
        const text = String(message.error.message ?? '');
        if (/authenticat|sign in|log ?in/i.test(text))
            return unavailable(MESSAGES.codexNotSignedIn);
        if (message.error.code === -32601 || /method not found|unknown (variant|method)/i.test(text))
            return unavailable(MESSAGES.codexTooOld);
        return failed(text || 'reported an error');
    }

    const result = message.result ?? {};
    // With the per-limit map, only its codex bucket is the subscription; other buckets meter
    // other features. The single bucket is the fallback for servers without the map.
    const bucket = result.rateLimitsByLimitId && typeof result.rateLimitsByLimitId === 'object'
        ? result.rateLimitsByLimitId.codex
        : result.rateLimits;
    const windows = PROVIDERS.codex.slots
        .map(slot => codexWindow(slot, bucket?.[slot]))
        .filter(Boolean);
    return windows.length > 0 ? {status: 'ok', windows} : unavailable(MESSAGES.codexNoQuota);
}

/** Share of the window elapsed, the even-spending budget; null without a length or reset. */
export function paceFraction(window, now) {
    if (!window.durationSeconds || !window.resetsAt)
        return null;
    return Math.min(1, Math.max(0, 1 - (window.resetsAt - now) / window.durationSeconds));
}

function formatDuration(seconds) {
    const hours = Math.floor(seconds / HOUR);
    const minutes = Math.floor(seconds % HOUR / 60);
    if (hours === 0)
        return Math.max(1, minutes) + ' min';
    return minutes === 0 ? hours + ' h' : hours + ' h ' + minutes + ' min';
}

/** `resets in 2 h 10 min` under a day away, `resets Sat 09:00` later, in local time. */
export function formatReset(window, now) {
    if (!window.resetsAt)
        return '';
    const remaining = window.resetsAt - now;
    if (remaining <= 0)
        return 'reset · waiting for a new reading';
    if (remaining < DAY)
        return 'resets in ' + formatDuration(remaining);
    const date = new Date(window.resetsAt * 1000);
    const pad = value => String(value).padStart(2, '0');
    return 'resets ' + WEEKDAYS[date.getDay()] + ' ' + pad(date.getHours()) + ':' + pad(date.getMinutes());
}

export function formatAge(seconds) {
    if (seconds < 60)
        return 'just now';
    if (seconds < HOUR)
        return Math.floor(seconds / 60) + ' min ago';
    if (seconds < DAY)
        return Math.floor(seconds / HOUR) + ' h ago';
    return Math.floor(seconds / DAY) + ' d ago';
}

/** `Claude weekly quota at 82 %`, `Codex 5-hour quota at 90 %`. */
export function notificationTitle(provider, window) {
    const units = {h: 'hour', d: 'day', min: 'minute'};
    const match = /^(\d+) (h|d|min)$/.exec(window.label);
    const name = window.label === 'Week'
        ? 'weekly '
        : match ? match[1] + '-' + units[match[2]] + ' ' : '';
    return PROVIDERS[provider].name + ' ' + name + 'quota at ' + Math.round(window.usedPercent) + ' %';
}

function periodKey(provider, window) {
    return provider + ':' + window.slot + ':' + window.resetsAt;
}

/** A provider that turns unavailable or off forgets the periods it marked as notified. */
export function forgetPeriods(notified, provider) {
    return notified.filter(key => !key.startsWith(provider + ':'));
}

/**
 * Finds the windows to notify. A period (provider, window, reset time) notifies once, when a
 * reading of it is at or above the threshold. A baseline reading only marks such periods.
 * A window without a reset time has no period and never notifies. Marks of periods whose reset
 * has passed are dropped.
 */
export function trackPeriods({provider, windows, notified, threshold, baseline, now}) {
    const marks = new Set(notified.filter(key => {
        const resetsAt = Number(key.split(':').pop());
        return Number.isFinite(resetsAt) && resetsAt > now;
    }));
    const alerts = [];
    for (const window of windows) {
        if (window.usedPercent < threshold || !window.resetsAt || window.resetsAt <= now)
            continue;
        const key = periodKey(provider, window);
        if (marks.has(key))
            continue;
        marks.add(key);
        if (!baseline)
            alerts.push(window);
    }
    return {notified: [...marks], alerts};
}

function isNumberOrNull(value) {
    return value === null || Number.isFinite(value);
}

function validWindow(provider, window) {
    return window && typeof window === 'object' &&
        PROVIDERS[provider].slots.includes(window.slot) && typeof window.label === 'string' &&
        Number.isFinite(window.usedPercent) && isNumberOrNull(window.durationSeconds) &&
        isNumberOrNull(window.resetsAt);
}

function validPeriod(key) {
    const [provider, slot, resetsAt, ...rest] = key.split(':');
    return rest.length === 0 && PROVIDERS[provider]?.slots.includes(slot) && /^\d+$/.test(resetsAt);
}

/**
 * Reads `agent-quota-cache`, dropping anything malformed. A reading whose windows have no known
 * slot, such as one written before windows had slots, is dropped with the periods it marked, so
 * the provider's next reading sets a quiet baseline.
 */
export function readQuotaCache(text) {
    let cache;
    try {
        cache = JSON.parse(text);
    } catch {
        cache = null;
    }
    const providers = {};
    for (const provider of Object.keys(PROVIDERS)) {
        const entry = cache?.providers?.[provider];
        if (entry && Array.isArray(entry.windows) && entry.windows.length > 0 &&
            Number.isFinite(entry.readAt) && entry.windows.every(window => validWindow(provider, window)))
            providers[provider] = {windows: entry.windows, readAt: entry.readAt};
    }
    const notified = Array.isArray(cache?.notified)
        ? cache.notified.filter(key => typeof key === 'string' && validPeriod(key))
        : [];
    return {providers, notified};
}
