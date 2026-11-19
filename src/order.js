// Order of the owner sections in the menu and of the owner blocks in the preferences. Pure: it
// imports nothing from gi://, so node --test covers it.

export const UNKNOWN_OWNER = 'Unknown owner';

/** Ranks the owner kinds: personal accounts, organizations, then other owners. */
const kindRank = owner => owner.kind === 'user' ? 0 : owner.kind === 'organization' ? 1 : 2;

/** Compares two owners, {login, kind}, in the kind-then-login order. */
export function compareOwnersKindThenLogin(first, second) {
    return kindRank(first) - kindRank(second) || first.login.localeCompare(second.login);
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
 * is dropped.
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

/**
 * The order of the owner blocks, and of the menu sections: the saved logins first, as the owners
 * are spelled, then the configured owners it misses in the kind-then-login order. `owners` is
 * the list of {login, kind}; the result is a list of logins.
 */
export function initialBlockOrder(order, owners) {
    return reconcileOwnerRows(
        order,
        [...owners].sort(compareOwnersKindThenLogin).map(owner => owner.login)
    );
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

/** Tells whether a block's move button can be used: not past an end of the list. */
export function canMoveOwnerRow(count, index, direction) {
    return direction < 0 ? index > 0 : index < count - 1;
}

/**
 * Orders the owner sections, given as {owner, latestUpdate}, by `blockOrder`, the logins of the
 * owner blocks in their order (see initialBlockOrder). The owners without a block follow, by
 * newest pull request, ties by owner name, and the section without an owner comes last.
 */
export function orderOwnerSections(groups, blockOrder) {
    const rank = new Map(readOwnerOrder(blockOrder).map((login, index) => [login.toLowerCase(), index]));
    // The section without an owner is never listed: it ranks past every owner.
    const position = group => group.owner === UNKNOWN_OWNER
        ? Infinity
        : rank.get(group.owner.toLowerCase()) ?? Number.MAX_SAFE_INTEGER;
    return [...groups].sort((first, second) => {
        const firstPosition = position(first);
        const secondPosition = position(second);
        if (firstPosition !== secondPosition)
            return firstPosition < secondPosition ? -1 : 1;
        return second.latestUpdate - first.latestUpdate || first.owner.localeCompare(second.owner);
    });
}
