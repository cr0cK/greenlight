// Order of the owner sections in the menu and of the owner rows in the preferences. Pure: it
// imports nothing from gi://, so node --test covers it.

export const UNKNOWN_OWNER = 'Unknown owner';
export const OWNER_ORDER_MODES = ['newest', 'custom'];

/** Reads the saved mode; anything but 'custom' is the default, 'newest'. */
export function readOwnerOrderMode(value) {
    return value === 'custom' ? 'custom' : 'newest';
}

/** Reads the saved order: strings only, each login once whatever its case, the first one kept. */
export function readOwnerOrder(values) {
    if (!Array.isArray(values))
        return [];
    const seen = new Set();
    const logins = [];
    for (const value of values) {
        if (typeof value !== 'string' || seen.has(value.toLowerCase()))
            continue;
        seen.add(value.toLowerCase());
        logins.push(value);
    }
    return logins;
}

/**
 * Lists the configured logins in the order of `order`: the ones it names first, as the owners
 * are spelled in `configured`, then the others in the order of `configured`. An unknown login
 * is dropped. Serves the initial rows of the preferences and keeps them in step with the owner
 * blocks: an added owner joins the end, a removed one leaves, and the rest never move.
 */
export function reconcileOwnerRows(order, configured) {
    const byKey = new Map();
    for (const login of configured) {
        if (!byKey.has(login.toLowerCase()))
            byKey.set(login.toLowerCase(), login);
    }
    const rows = [];
    for (const login of readOwnerOrder(order)) {
        const key = login.toLowerCase();
        if (byKey.has(key)) {
            rows.push(byKey.get(key));
            byKey.delete(key);
        }
    }
    return [...rows, ...byKey.values()];
}

/** Moves the row at `index` one place up (-1) or down (+1); returns the same list at an edge. */
export function moveOwnerRow(rows, index, direction) {
    const target = index + direction;
    if (index < 0 || index >= rows.length || target < 0 || target >= rows.length)
        return rows;
    const moved = [...rows];
    [moved[index], moved[target]] = [moved[target], moved[index]];
    return moved;
}

/**
 * Tells which button of a row takes the focus after a move: the one just used, unless it became
 * insensitive at the end of the list, and then the row's other button.
 */
export function buttonFocusedAfterMove(count, newIndex, direction) {
    if (direction < 0)
        return newIndex === 0 ? 'down' : 'up';
    return newIndex === count - 1 ? 'up' : 'down';
}

/** Tells whether a row's move button can be used: not in the activity mode, not past an end. */
export function canMoveOwnerRow(mode, count, index, direction) {
    if (mode !== 'custom')
        return false;
    return direction < 0 ? index > 0 : index < count - 1;
}

/**
 * Orders the owner sections, given as {owner, latestUpdate}. 'newest' puts the owner with the
 * newest pull request first. 'custom' follows `order`, then the owners it does not name by newest
 * pull request, and the section without an owner last. Ties go to the owner name.
 */
export function orderOwnerSections(groups, mode, order) {
    const byNewest = (first, second) => second.latestUpdate - first.latestUpdate ||
        first.owner.localeCompare(second.owner);
    if (mode !== 'custom')
        return [...groups].sort(byNewest);

    const rank = new Map(readOwnerOrder(order).map((login, index) => [login.toLowerCase(), index]));
    // The section without an owner is never listed: it ranks past every listed owner.
    const position = group => group.owner === UNKNOWN_OWNER
        ? Infinity
        : rank.get(group.owner.toLowerCase()) ?? Number.MAX_SAFE_INTEGER;
    return [...groups].sort((first, second) => {
        const firstPosition = position(first);
        const secondPosition = position(second);
        if (firstPosition === secondPosition)
            return byNewest(first, second);
        return firstPosition < secondPosition ? -1 : 1;
    });
}
