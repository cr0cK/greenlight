// The save of the preferences window, as a pure function of the values it would write: it keeps
// the ones that differ from what is stored and refuses the whole batch when one key is locked.
// Pure: it imports nothing from gi://, so node --test covers it.

/** Tells whether two setting values are the same: strings, booleans, integers, and string lists. */
function sameValue(first, second) {
    return JSON.stringify(first) === JSON.stringify(second);
}

/**
 * Plans one save. `values` lists `{key, value}` in write order; `stored(key)` reads the value a
 * key holds now and `isWritable(key)` tells whether it can be written. A locked key makes
 * GSettings drop a whole delayed batch silently, so the batch is refused before anything is
 * written. Returns `{writes, blockedKey, message}`: the values that differ from the stored ones,
 * the first locked key among them (null when none), and the toast text.
 */
export function planSave(values, stored, isWritable) {
    const writes = values.filter(({key, value}) => !sameValue(stored(key), value));
    const blocked = writes.find(({key}) => !isWritable(key));
    if (blocked) {
        return {
            writes: [],
            blockedKey: blocked.key,
            message: 'Could not save: ' + blocked.key + ' is not writable',
        };
    }
    return {writes, blockedKey: null, message: 'Preferences saved'};
}
