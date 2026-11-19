import assert from 'node:assert/strict';
import {test} from 'node:test';

import {
    MAX_SUGGESTIONS,
    ageAccessibleText,
    formatActivityAge,
    parseQuickOpenQuery,
    quickOpenSuggestions,
    readRecentRepositories,
    rememberRepository,
    sortByActivity,
} from '../src/quickopen.js';

const REPOSITORIES = [
    'acme/web-platform',
    'acme/web-client',
    'acme/platform-infra',
    'octocat/greenlight',
    'octocat/repo2',
];

test('parses repository queries and numbers', () => {
    assert.deepEqual(parseQuickOpenQuery('plat 42'),
        {repositoryQuery: 'plat', number: 42, url: null});
    assert.deepEqual(parseQuickOpenQuery(' plat#42 '),
        {repositoryQuery: 'plat', number: 42, url: null});
    assert.deepEqual(parseQuickOpenQuery('plat #42'),
        {repositoryQuery: 'plat', number: 42, url: null});
    assert.deepEqual(parseQuickOpenQuery('#42'),
        {repositoryQuery: '', number: 42, url: null});
    assert.deepEqual(parseQuickOpenQuery('42'),
        {repositoryQuery: '', number: 42, url: null});
    assert.deepEqual(parseQuickOpenQuery('repo2'),
        {repositoryQuery: 'repo2', number: null, url: null});
    assert.deepEqual(parseQuickOpenQuery('plat #'),
        {repositoryQuery: 'plat', number: null, url: null});
});

test('parses pasted GitHub URLs without their trailing fragments', () => {
    assert.deepEqual(
        parseQuickOpenQuery('https://github.com/cr0cK/greenlight/pull/7/files#diff'),
        {
            repositoryQuery: 'cr0cK/greenlight',
            number: 7,
            url: 'https://github.com/cr0cK/greenlight/pull/7',
        });
});

test('ranks repository name matches before owner and fuzzy matches', () => {
    const suggestions = quickOpenSuggestions('plat 42', REPOSITORIES);
    assert.deepEqual(suggestions.map(suggestion => suggestion.repository), [
        'acme/platform-infra',
        'acme/web-platform',
    ]);
    assert.equal(suggestions[0].url, 'https://github.com/acme/platform-infra/issues/42');
});

test('uses recent repositories to break ties', () => {
    const suggestions = quickOpenSuggestions('#3', REPOSITORIES, ['octocat/greenlight']);
    assert.equal(suggestions[0].repository, 'octocat/greenlight');
    assert.equal(suggestions.length, 5);
});

test('returns more ranked candidates when asked', () => {
    assert.equal(quickOpenSuggestions('#3', REPOSITORIES).length, 5);
    assert.equal(quickOpenSuggestions('#3', [...REPOSITORIES, 'x/one', 'x/two'], [], {limit: 20}).length, 7);
});

test('matches subsequences and reports no match', () => {
    assert.equal(quickOpenSuggestions('wbc 1', REPOSITORIES)[0].repository,
        'acme/web-client');
    assert.deepEqual(quickOpenSuggestions('xyz 1', REPOSITORIES), []);
    assert.deepEqual(quickOpenSuggestions('   ', REPOSITORIES), []);
});

test('suggests repositories without a URL until a number is typed', () => {
    const [suggestion] = quickOpenSuggestions('green', REPOSITORIES);
    assert.deepEqual(suggestion, {repository: 'octocat/greenlight', number: null, url: null});
});

test('accepts an unwatched owner/repository typed in full', () => {
    assert.deepEqual(quickOpenSuggestions('gnome/gnome-shell#12', REPOSITORIES)[0], {
        repository: 'gnome/gnome-shell',
        number: 12,
        url: 'https://github.com/gnome/gnome-shell/issues/12',
    });
});

test('keeps ten distinct recent repositories, newest first', () => {
    let recent = [];
    for (let index = 0; index < 12; index++)
        recent = rememberRepository(recent, 'owner/repo' + index);
    recent = rememberRepository(recent, 'OWNER/repo5');
    assert.equal(recent.length, 10);
    assert.equal(recent[0], 'OWNER/repo5');
    assert.equal(recent.filter(name => name.toLowerCase() === 'owner/repo5').length, 1);
});

test('ignores malformed recent repository settings', () => {
    assert.deepEqual(readRecentRepositories({get_string: () => 'not json'}), []);
    assert.deepEqual(readRecentRepositories({get_string: () => '["a/b", 3, "bad"]'}), ['a/b']);
});

const NOW = Date.parse('2026-11-19T12:00:00Z');
const ago = ms => new Date(NOW - ms).toISOString();
const SECOND = 1000;
const MINUTE = 60 * SECOND;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

test('formats the age at each boundary', () => {
    const age = ms => formatActivityAge(ago(ms), NOW);
    assert.equal(age(0), 'now');
    assert.equal(age(59 * SECOND), 'now');
    assert.equal(age(60 * SECOND), '1 min');
    assert.equal(age(12 * MINUTE + 59 * SECOND), '12 min');
    assert.equal(age(59 * MINUTE), '59 min');
    assert.equal(age(HOUR), '1 h');
    assert.equal(age(23 * HOUR + 59 * MINUTE), '23 h');
    assert.equal(age(23 * HOUR), '23 h');
    assert.equal(age(DAY), '1 d');
    assert.equal(age(29 * DAY), '29 d');
    assert.equal(age(30 * DAY - SECOND), '29 d');
});

test('formats an age of 30 days or more as a local date', () => {
    const local = (year, month, day) => new Date(year, month, day, 12).toISOString();
    const now = new Date(2026, 10, 19, 12).getTime();
    assert.equal(formatActivityAge(local(2026, 9, 20), now), 'Oct 20');
    assert.equal(formatActivityAge(local(2026, 8, 2), now), 'Sep 2');
    assert.equal(formatActivityAge(local(2026, 0, 1), now), 'Jan 1');
    assert.equal(formatActivityAge(local(2025, 11, 31), now), 'Dec 31, 2025');
    assert.equal(formatActivityAge(local(2025, 2, 4), now), 'Mar 4, 2025');
});

test('reads a future date as now and a missing or invalid date as no age', () => {
    assert.equal(formatActivityAge(new Date(NOW + 5 * MINUTE).toISOString(), NOW), 'now');
    assert.equal(formatActivityAge('not a date', NOW), null);
    assert.equal(formatActivityAge('', NOW), null);
    assert.equal(formatActivityAge(null, NOW), null);
    assert.equal(formatActivityAge(undefined, NOW), null);
});

test('words the age for the accessible name', () => {
    assert.equal(ageAccessibleText('now'), 'updated now');
    assert.equal(ageAccessibleText('12 min'), 'updated 12 min ago');
    assert.equal(ageAccessibleText('5 h'), 'updated 5 h ago');
    assert.equal(ageAccessibleText('3 d'), 'updated 3 d ago');
    assert.equal(ageAccessibleText('Sep 2'), 'updated Sep 2');
    assert.equal(ageAccessibleText('Mar 4, 2025'), 'updated Mar 4, 2025');
});

const found = (repository, updatedAt) => ({repository, number: 184, updatedAt});
const names = list => list.map(suggestion => suggestion.repository);

test('sorts looked up suggestions newest first, ties and missing dates in ranking order', () => {
    const list = [
        found('acme/a', '2026-11-01T00:00:00Z'),
        found('acme/b', null),
        found('acme/c', '2026-11-19T00:00:00Z'),
        found('acme/d', '2026-11-01T00:00:00Z'),
        found('acme/e', 'garbage'),
        found('acme/f', '2026-11-10T00:00:00Z'),
    ];
    assert.deepEqual(names(sortByActivity(list, '')),
        ['acme/c', 'acme/f', 'acme/a', 'acme/d', 'acme/b', 'acme/e']);
    assert.deepEqual(names(list), ['acme/a', 'acme/b', 'acme/c', 'acme/d', 'acme/e', 'acme/f']);
});

test('puts exact repository matches first, whatever their age', () => {
    const list = [
        found('acme/web-client', '2026-11-19T00:00:00Z'),
        found('acme/web', '2026-01-01T00:00:00Z'),
        found('octocat/web', '2026-06-01T00:00:00Z'),
        found('globex/web', null),
    ];
    assert.deepEqual(names(sortByActivity(list, 'web')),
        ['octocat/web', 'acme/web', 'globex/web', 'acme/web-client']);
    assert.deepEqual(names(sortByActivity(list, 'ACME/Web')),
        ['acme/web', 'acme/web-client', 'octocat/web', 'globex/web']);
    assert.deepEqual(names(sortByActivity(list, '')),
        ['acme/web-client', 'octocat/web', 'acme/web', 'globex/web']);
});

test('sorts every looked up candidate before the cut to five suggestions', () => {
    const suggestions = ['a', 'b', 'c', 'd', 'e', 'f', 'g'].map((name, index) =>
        found('acme/' + name, new Date(Date.UTC(2026, 0, 1 + (name === 'g' ? 300 : index))).toISOString()));
    assert.equal(sortByActivity(suggestions, '').slice(0, MAX_SUGGESTIONS)[0].repository, 'acme/g');
});
