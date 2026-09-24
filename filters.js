/** Normalizes saved owner scopes while preserving case for display and matching case-insensitively. */
export function normalizeOwnerFilters(filters) {
    if (!Array.isArray(filters))
        return [];

    const normalized = new Map();
    for (const candidate of filters) {
        const login = typeof candidate?.login === 'string' ? candidate.login.trim() : '';
        if (!login)
            continue;

        const key = login.toLowerCase();
        const repositories = candidate.repositories === null
            ? null
            : Array.isArray(candidate.repositories)
                ? [...new Set(candidate.repositories.filter(repository =>
                    typeof repository === 'string' &&
                    repository.toLowerCase().startsWith(key + '/')
                ))]
                : null;
        const owner = {
            login,
            kind: ['user', 'organization'].includes(candidate.kind)
                ? candidate.kind
                : 'owner',
            enabled: candidate.enabled !== false,
            repositories,
        };
        const existing = normalized.get(key);
        if (!existing) {
            normalized.set(key, owner);
            continue;
        }

        existing.enabled = existing.enabled || owner.enabled;
        if (existing.repositories === null || owner.repositories === null) {
            existing.repositories = null;
        } else {
            existing.repositories = [...new Set([
                ...existing.repositories,
                ...owner.repositories,
            ])];
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
    }
    return JSON.stringify(owners);
}

function parseStringArray(value) {
    try {
        const parsed = JSON.parse(value);
        return Array.isArray(parsed) ? parsed.filter(item => typeof item === 'string') : [];
    } catch {
        return [];
    }
}

/** Migrates both earlier single-owner settings and the original comma-separated repository filter. */
export function migrateLegacyOwnerFilters(settings) {
    if (settings.get_boolean('owner-filters-configured'))
        return;

    const existingFilters = readOwnerFilters(settings);
    if (existingFilters.length > 0) {
        settings.set_boolean('owner-filters-configured', true);
        return;
    }

    const owners = new Map();
    const legacyRepositories = settings.get_string('repo-filter')
        .split(',')
        .map(repository => repository.trim())
        .filter(Boolean);

    for (const repository of legacyRepositories) {
        const separator = repository.indexOf('/');
        if (separator <= 0 || separator === repository.length - 1)
            continue;
        const login = repository.slice(0, separator);
        const key = login.toLowerCase();
        if (!owners.has(key)) {
            owners.set(key, {
                login,
                kind: 'owner',
                enabled: true,
                repositories: [],
            });
        }
        owners.get(key).repositories.push(repository);
    }

    if (owners.size === 0) {
        const legacyOwner = settings.get_string('repo-owner').trim();
        if (legacyOwner) {
            owners.set(legacyOwner.toLowerCase(), {
                login: legacyOwner,
                kind: 'owner',
                enabled: true,
                repositories: settings.get_boolean('repo-selection-configured')
                    ? parseStringArray(settings.get_string('selected-repositories'))
                    : null,
            });
        }
    }

    if (owners.size === 0)
        return;

    settings.delay();
    settings.set_string('owner-filters', serializeOwnerFilters([...owners.values()]));
    settings.set_boolean('owner-filters-configured', true);
    settings.set_string('repo-filter', '');
    settings.apply();
}
