const MAX_QUERY_QUALIFIERS = 16;
const MAX_QUERY_LENGTH = 220;
// gh search returns at most 1000 results, whatever the limit asked.
const MAX_SEARCH_LIMIT = 1000;

/**
 * Keeps the strings of a saved list that name a repository of this owner, once each whatever
 * their case, since GitHub names are case-insensitive.
 */
function ownerRepositories(names, key) {
    const unique = new Map();
    for (const repository of names) {
        if (typeof repository !== 'string' || !repository.toLowerCase().startsWith(key + '/'))
            continue;
        if (!unique.has(repository.toLowerCase()))
            unique.set(repository.toLowerCase(), repository);
    }
    return [...unique.values()];
}

/**
 * Normalizes saved owner scopes while preserving case for display and matching case-insensitively.
 * `repositories` is null to watch every repository, minus `excludedRepositories`, or the list of
 * the only repositories to watch, and then `excludedRepositories` is empty.
 */
export function normalizeOwnerFilters(filters) {
    if (!Array.isArray(filters))
        return [];

    const normalized = new Map();
    for (const candidate of filters) {
        const login = typeof candidate?.login === 'string' ? candidate.login.trim() : '';
        if (!login)
            continue;

        const key = login.toLowerCase();
        const repositories = Array.isArray(candidate.repositories)
            ? ownerRepositories(candidate.repositories, key)
            : null;
        const owner = {
            login,
            kind: ['user', 'organization'].includes(candidate.kind)
                ? candidate.kind
                : 'owner',
            enabled: candidate.enabled !== false,
            repositories,
            excludedRepositories: repositories === null &&
                Array.isArray(candidate.excludedRepositories)
                ? ownerRepositories(candidate.excludedRepositories, key)
                : [],
        };
        const existing = normalized.get(key);
        if (!existing) {
            normalized.set(key, owner);
            continue;
        }

        if (existing.enabled !== owner.enabled) {
            // A paused duplicate must not widen what the enabled one watches.
            if (owner.enabled) {
                existing.enabled = true;
                existing.repositories = owner.repositories;
                existing.excludedRepositories = owner.excludedRepositories;
            }
        } else if (existing.repositories === null || owner.repositories === null) {
            // Duplicates merge into the wider scope: a repository stays excluded only if no
            // duplicate watches it.
            const [all, other] = existing.repositories === null
                ? [existing, owner]
                : [owner, existing];
            const has = (names, name) => names.some(entry => entry.toLowerCase() === name.toLowerCase());
            existing.excludedRepositories = all.excludedRepositories.filter(name =>
                other.repositories === null
                    ? has(other.excludedRepositories, name)
                    : !has(other.repositories, name)
            );
            existing.repositories = null;
        } else {
            existing.repositories = ownerRepositories(
                [...existing.repositories, ...owner.repositories], key
            );
        }
        if (existing.kind === 'owner' && owner.kind !== 'owner')
            existing.kind = owner.kind;
    }

    return [...normalized.values()];
}

/** Reads the persisted owner scopes without allowing malformed settings to break the extension. */
export function readOwnerFilters(settings) {
    try {
        return normalizeOwnerFilters(JSON.parse(settings.get_string('owner-filters')));
    } catch {
        return [];
    }
}

/** Serializes a canonical document so filter signatures do not depend on row order. */
export function serializeOwnerFilters(filters) {
    const owners = normalizeOwnerFilters(filters)
        .sort((first, second) => first.login.localeCompare(second.login));
    for (const owner of owners) {
        if (owner.repositories)
            owner.repositories.sort((first, second) => first.localeCompare(second));
        owner.excludedRepositories.sort((first, second) => first.localeCompare(second));
    }
    return JSON.stringify(owners);
}

/** Splits owner/repository qualifiers without exceeding GitHub search query bounds. */
function chunkSearchFilters(values, qualifier, fixedQueryLength) {
    const chunks = [];
    let current = [];
    let currentLength = fixedQueryLength;

    for (const value of values) {
        const qualifierLength = qualifier.length + value.length + (current.length > 0 ? 1 : 0);
        if (current.length > 0 && (current.length >= MAX_QUERY_QUALIFIERS ||
            currentLength + qualifierLength > MAX_QUERY_LENGTH)) {
            chunks.push(current);
            current = [];
            currentLength = fixedQueryLength;
        }
        current.push(value);
        currentLength += qualifier.length + value.length + (current.length > 1 ? 1 : 0);
    }

    if (current.length > 0)
        chunks.push(current);
    return chunks;
}

/**
 * Produces non-overlapping search scopes for enabled owners. An owner with exclusions gets its
 * own scope, because `-repo:` terms apply to the whole query: `excluded` lists the exclusions
 * that fit in the query, and `hidden` the rest, which only client-side filtering can drop.
 */
export function searchScopes(owners, authorFilter) {
    const fixedQueryLength = 24 + (authorFilter ? 7 + authorFilter.length : 0);
    const enabled = owners.filter(owner => owner.enabled);
    const allOwners = enabled
        .filter(owner => owner.repositories === null && owner.excludedRepositories.length === 0)
        .map(owner => owner.login);
    const repositories = [...new Set(enabled
        .filter(owner => owner.repositories !== null)
        .flatMap(owner => owner.repositories))];

    const exceptOwners = enabled
        .filter(owner => owner.repositories === null && owner.excludedRepositories.length > 0)
        .map(owner => {
            let length = fixedQueryLength + 'org:'.length + owner.login.length;
            let fitting = 0;
            for (const name of owner.excludedRepositories) {
                length += ' -repo:'.length + name.length;
                if (fitting + 1 >= MAX_QUERY_QUALIFIERS || length > MAX_QUERY_LENGTH)
                    break;
                fitting++;
            }
            return {
                type: 'owners',
                values: [owner.login],
                excluded: owner.excludedRepositories.slice(0, fitting),
                hidden: owner.excludedRepositories.slice(fitting),
            };
        });

    return [
        ...chunkSearchFilters(allOwners, 'org:', fixedQueryLength)
            .map(values => ({type: 'owners', values, excluded: [], hidden: []})),
        ...exceptOwners,
        ...chunkSearchFilters(repositories, 'repo:', fixedQueryLength)
            .map(values => ({type: 'repositories', values, excluded: [], hidden: []})),
    ];
}

/**
 * Decides whether a search must run again with a larger limit. Client-side filtering can drop
 * rows from a full page, and the scope must still yield `wanted` rows when GitHub has them, so
 * counts and the most recent pull requests stay exact. Returns null once the search is complete.
 */
export function nextSearchLimit(limit, received, kept, wanted) {
    if (received < limit || kept >= wanted || limit >= MAX_SEARCH_LIMIT)
        return null;
    return Math.min(limit * 4, MAX_SEARCH_LIMIT);
}

/**
 * Drops the owners and selected repositories gh can no longer find, so one missing account or
 * repository does not fail the whole search. An owner left with no selected repository goes too.
 */
export function withoutUnreachable(owners, unreachable) {
    const logins = new Set(unreachable.owners.map(login => login.toLowerCase()));
    const repositories = new Set(unreachable.repositories.map(name => name.toLowerCase()));
    return owners
        .filter(owner => !logins.has(owner.login.toLowerCase()))
        .map(owner => owner.repositories === null
            ? owner
            : {
                ...owner,
                repositories: owner.repositories.filter(name => !repositories.has(name.toLowerCase())),
            })
        .filter(owner => owner.repositories === null || owner.repositories.length > 0);
}
