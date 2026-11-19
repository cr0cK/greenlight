const GITHUB_ORIGIN = 'https://github.com';
export const MAX_SUGGESTIONS = 5;
const MAX_RECENT_REPOSITORIES = 10;
const FUZZY_RANK = 4;
const REPOSITORY_PATTERN = /^[A-Za-z0-9-]+\/[A-Za-z0-9._-]+$/;
const URL_PATTERN =
    /^(https?:\/\/[^/\s]+)\/([A-Za-z0-9-]+\/[A-Za-z0-9._-]+)\/(issues|pull)\/(\d+)(?:[/?#]\S*)?$/;

/** Splits quick-open text into a repository query and an optional issue or pull request number. */
export function parseQuickOpenQuery(text) {
    const query = text.trim();
    const url = URL_PATTERN.exec(query);
    if (url) {
        return {
            repositoryQuery: url[2],
            number: Number(url[4]),
            url: url[1] + '/' + url[2] + '/' + url[3] + '/' + url[4],
        };
    }

    // A number needs a separator so repository names ending in digits stay intact.
    const match = /^(?:(.*?)(?:\s*#|\s+))?(\d+)$/.exec(query);
    return match
        ? {repositoryQuery: (match[1] ?? '').trim(), number: Number(match[2]), url: null}
        : {repositoryQuery: query.replace(/\s*#$/, ''), number: null, url: null};
}

/** Keeps valid owner/repository names once, preserving the first spelling seen. */
export function uniqueRepositories(repositories) {
    const unique = new Map();
    for (const repository of repositories) {
        if (typeof repository !== 'string' || !REPOSITORY_PATTERN.test(repository))
            continue;
        const key = repository.toLowerCase();
        if (!unique.has(key))
            unique.set(key, repository);
    }
    return [...unique.values()];
}

/** Moves a repository to the front of the most-recently-used list. */
export function rememberRepository(recentRepositories, repository) {
    return uniqueRepositories([repository, ...recentRepositories])
        .slice(0, MAX_RECENT_REPOSITORIES);
}

/** Reads the most-recently-used repositories without letting malformed settings break the menu. */
export function readRecentRepositories(settings) {
    try {
        const recent = JSON.parse(settings.get_string('recent-repositories'));
        return Array.isArray(recent) ? uniqueRepositories(recent) : [];
    } catch {
        return [];
    }
}

function isSubsequence(query, text) {
    let index = 0;
    for (const character of text) {
        if (character === query[index])
            index++;
    }
    return index === query.length;
}

/** Ranks a repository against a lowercase query; lower is better and -1 means no match. */
function matchRank(repository, query) {
    if (!query)
        return 0;

    const fullName = repository.toLowerCase();
    const name = fullName.slice(fullName.indexOf('/') + 1);
    if (fullName === query || name === query)
        return 0;
    if (name.startsWith(query))
        return 1;
    if (name.includes(query))
        return 2;
    if (fullName.includes(query))
        return 3;
    return isSubsequence(query.replace(/\s+/g, ''), fullName) ? FUZZY_RANK : -1;
}

/**
 * Ranks known repositories for quick-open text. A suggestion with a number carries the URL to
 * open; GitHub redirects /issues/<n> to /pull/<n> when the number belongs to a pull request.
 */
export function quickOpenSuggestions(
    text,
    repositories,
    recentRepositories = [],
    {limit = MAX_SUGGESTIONS} = {}
) {
    const {repositoryQuery, number, url} = parseQuickOpenQuery(text);
    if (url)
        return [{repository: repositoryQuery, number, url}];
    if (!repositoryQuery && number === null)
        return [];

    const query = repositoryQuery.toLowerCase();
    const candidates = uniqueRepositories(repositories);
    if (REPOSITORY_PATTERN.test(repositoryQuery) &&
        !candidates.some(repository => repository.toLowerCase() === query))
        candidates.push(repositoryQuery);

    const recentRanks = new Map(recentRepositories.map((repository, index) =>
        [repository.toLowerCase(), index]));
    const recency = repository =>
        recentRanks.get(repository.toLowerCase()) ?? MAX_RECENT_REPOSITORIES;

    const ranked = candidates
        .map(repository => ({repository, rank: matchRank(repository, query)}))
        .filter(candidate => candidate.rank >= 0);
    // Subsequence matches are noisy, so they only appear when no substring matches.
    const hasSubstringMatch = ranked.some(candidate => candidate.rank < FUZZY_RANK);
    return ranked
        .filter(candidate => !hasSubstringMatch || candidate.rank < FUZZY_RANK)
        .sort((first, second) =>
            first.rank - second.rank ||
            recency(first.repository) - recency(second.repository) ||
            first.repository.localeCompare(second.repository))
        .slice(0, limit)
        .map(({repository}) => ({
            repository,
            number,
            url: number === null
                ? null
                : GITHUB_ORIGIN + '/' + repository + '/issues/' + number,
        }));
}

const MINUTE_MS = 60 * 1000;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

function activityTime(updatedAt) {
    const time = typeof updatedAt === 'string' ? Date.parse(updatedAt) : NaN;
    return Number.isNaN(time) ? null : time;
}

/**
 * Orders looked up suggestions by last activity, newest first. An exact repository match
 * (full name or name equal to the typed text, case-insensitively) comes before the others
 * whatever its age; a missing or unparsable date sorts after the dated ones of its group; ties
 * keep the incoming ranking order.
 */
export function sortByActivity(suggestions, repositoryQuery) {
    const query = repositoryQuery.trim().toLowerCase();
    const isExact = ({repository}) => {
        const fullName = repository.toLowerCase();
        return query !== '' && (fullName === query || fullName.slice(fullName.indexOf('/') + 1) === query);
    };
    return suggestions
        .map((suggestion, index) => ({
            suggestion,
            index,
            exact: isExact(suggestion),
            time: activityTime(suggestion.updatedAt),
        }))
        .sort((first, second) =>
            Number(second.exact) - Number(first.exact) ||
            Number(first.time === null) - Number(second.time === null) ||
            (second.time ?? 0) - (first.time ?? 0) ||
            first.index - second.index)
        .map(({suggestion}) => suggestion);
}

/**
 * Formats the age of a last activity at time now (ms): now, <n> min, <n> h, <n> d, then the date
 * in the local time zone. Returns null when the date is missing or unparsable.
 */
export function formatActivityAge(updatedAt, now) {
    const time = activityTime(updatedAt);
    if (time === null)
        return null;

    const elapsed = now - time;
    if (elapsed < MINUTE_MS)
        return 'now';
    if (elapsed < HOUR_MS)
        return Math.floor(elapsed / MINUTE_MS) + ' min';
    if (elapsed < DAY_MS)
        return Math.floor(elapsed / HOUR_MS) + ' h';
    if (elapsed < 30 * DAY_MS)
        return Math.floor(elapsed / DAY_MS) + ' d';

    const date = new Date(time);
    const day = MONTHS[date.getMonth()] + ' ' + date.getDate();
    return date.getFullYear() === new Date(now).getFullYear() ? day : day + ', ' + date.getFullYear();
}

/** Words an age for the accessible name: `updated now`, `updated 12 min ago`, `updated Sep 2`. */
export function ageAccessibleText(age) {
    if (age === 'now')
        return 'updated now';
    return /^\d+ (min|h|d)$/.test(age) ? 'updated ' + age + ' ago' : 'updated ' + age;
}
