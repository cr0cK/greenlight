// The unsaved changes of the preferences window: what its values, as shown, change against their
// baselines, which tabs they belong to, and which keys a save writes. Pure: it imports nothing
// from gi://, so node --test covers it. The shortcut arrives already classified (GTK parses it).

import {ownerFiltersToSave, sameOwnerFilters} from './filters.js';
import {normalizeWatched, sameWatched} from './routines.js';

export const PULL_REQUESTS_TAB = 'Pull requests';
export const AGENTS_TAB = 'Agents';
export const ROUTINES_TAB = 'Routines';

const MIN_THRESHOLD = 50;
const MAX_THRESHOLD = 100;

/**
 * Reads the text of **Notify at**: a whole number from 50 to 100 is a value, any other text
 * (empty, `abc`, `8`, `120`, `83.5`) counts as the value last committed.
 */
export function thresholdValue(text, committed) {
    const trimmed = text.trim();
    if (!/^\d+$/.test(trimmed))
        return committed;
    const value = Number(trimmed);
    return value >= MIN_THRESHOLD && value <= MAX_THRESHOLD ? value : committed;
}

/**
 * Classifies the text of the keyboard shortcut. `parsed` is `{valid, name}` from GTK: whether the
 * text parses and names a key, and the accelerator's canonical name when it does.
 */
export function classifyShortcut(text, parsed) {
    const trimmed = text.trim();
    if (trimmed === '')
        return {kind: 'blank'};
    return parsed.valid
        ? {kind: 'valid', accelerator: parsed.name}
        : {kind: 'invalid', text: trimmed};
}

/**
 * Tells whether two shortcuts are the same setting: blank equals blank, valid ones when they name
 * the same accelerator, invalid ones when typed the same (a stored invalid value is its own
 * baseline, and any other text differs from it).
 */
export function sameShortcut(first, second) {
    if (first.kind !== second.kind)
        return false;
    if (first.kind === 'valid')
        return first.accelerator === second.accelerator;
    return first.kind === 'blank' || first.text === second.text;
}

/** The banner title naming the tabs with changes, in tab order. */
export function bannerTitle(tabs) {
    if (tabs.length <= 2)
        return 'Unsaved changes in ' + tabs.join(' and ');
    return 'Unsaved changes in ' + tabs.slice(0, -1).join(', ') + ', and ' + tabs.at(-1);
}

const sameLogins = (first, second) =>
    first.length === second.length &&
    first.every((login, index) => login.toLowerCase() === second[index].toLowerCase());

/**
 * Compares the values the window shows with their baselines. Both have the same shape:
 * `{author, refreshInterval, shortcut, owners, ownerOrder, switches, quotaInterval, threshold,
 * routines}`, where `owners` lists the owners as `owner-filters` stores them, `ownerOrder` the
 * logins in block order, `switches` maps each provider's setting key to its switch, and
 * `routines` lists the timer units switched on, in any order. `pending` holds the
 * keys of the pending normalizations, written whether or not they changed. `storedOwners` is what
 * `owner-filters` holds now: owners that match it are not written again.
 *
 * Returns `{tabs, writes, invalidShortcut}`: the tabs with changes in tab order, the `{key,
 * value}` to write in write order, and whether the shortcut is an invalid text, which stops the
 * save.
 */
export function planChanges(shown, baseline, pending, storedOwners) {
    const entries = [];
    const add = (tab, key, changed, value) => entries.push({tab, key, changed, value});

    // Owners that differ from the baseline are written, unless the store already holds them.
    const ownersChanged = !sameOwnerFilters(shown.owners, baseline.owners);
    const ownersToWrite = ownersChanged ? ownerFiltersToSave(storedOwners, shown.owners) : null;
    add(PULL_REQUESTS_TAB, 'owner-filters', ownersChanged, ownersToWrite);
    add(PULL_REQUESTS_TAB, 'owner-filters-configured', ownersChanged, true);
    add(PULL_REQUESTS_TAB, 'owner-order', !sameLogins(shown.ownerOrder, baseline.ownerOrder), shown.ownerOrder);
    const author = shown.author.trim();
    add(PULL_REQUESTS_TAB, 'author-filter', author !== baseline.author.trim(), author);
    add(PULL_REQUESTS_TAB, 'refresh-interval', shown.refreshInterval !== baseline.refreshInterval,
        shown.refreshInterval);
    const shortcutChanged = !sameShortcut(shown.shortcut, baseline.shortcut);
    add(PULL_REQUESTS_TAB, 'quick-open-shortcut', shortcutChanged,
        shown.shortcut.kind === 'valid' ? [shown.shortcut.accelerator] : []);
    for (const [key, active] of Object.entries(shown.switches))
        add(AGENTS_TAB, key, active !== baseline.switches[key], active);
    add(AGENTS_TAB, 'agent-quota-interval', shown.quotaInterval !== baseline.quotaInterval, shown.quotaInterval);
    add(AGENTS_TAB, 'agent-quota-threshold', shown.threshold !== baseline.threshold, shown.threshold);
    add(ROUTINES_TAB, 'watched-routines', !sameWatched(shown.routines, baseline.routines),
        normalizeWatched(shown.routines));

    // An invalid text stops the save, even a stored one the window opened clean with.
    const invalidShortcut = shown.shortcut.kind === 'invalid';
    const tabs = [PULL_REQUESTS_TAB, AGENTS_TAB, ROUTINES_TAB].filter(tab =>
        entries.some(entry => entry.tab === tab && entry.changed && entry.key !== 'owner-filters-configured'));
    const writes = entries
        .filter(entry => (entry.changed || pending.has(entry.key)) && entry.value !== null)
        .filter(entry => !(entry.key === 'quick-open-shortcut' && invalidShortcut))
        .map(({key, value}) => ({key, value}));
    return {tabs, writes, invalidShortcut};
}

/**
 * Lists the pending normalizations of a window that just opened: the keys whose stored value the
 * window shows adjusted, which the next save stores as shown. `stored` holds `refreshInterval`,
 * `quotaInterval`, and `ownerOrder` as stored; `intervals` and `quotaIntervals` are the lists the
 * rows offer, and `blockOrder` is the completed order of the owner blocks.
 */
export function normalizationsAtOpen(stored, {intervals, quotaIntervals, blockOrder}) {
    const keys = new Set();
    if (!intervals.includes(stored.refreshInterval))
        keys.add('refresh-interval');
    if (!quotaIntervals.includes(stored.quotaInterval))
        keys.add('agent-quota-interval');
    if (JSON.stringify(stored.ownerOrder) !== JSON.stringify(blockOrder))
        keys.add('owner-order');
    return keys;
}
