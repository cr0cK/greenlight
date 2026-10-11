import assert from 'node:assert/strict';
import {test} from 'node:test';

import {
    parseQuickOpenQuery,
    quickOpenSuggestions,
    readRecentRepositories,
    rememberRepository,
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
