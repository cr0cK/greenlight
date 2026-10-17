import assert from 'node:assert/strict';
import {test} from 'node:test';

import {
    nextSearchLimit,
    normalizeOwnerFilters,
    searchScopes,
    serializeOwnerFilters,
} from '../src/filters.js';

const owner = (login, overrides = {}) => ({
    login,
    kind: 'organization',
    enabled: true,
    repositories: null,
    excludedRepositories: [],
    ...overrides,
});

test('reads exclusions only for owners watching every repository', () => {
    const [all, only, legacy] = normalizeOwnerFilters([
        {login: 'acme', repositories: null,
            excludedRepositories: ['acme/infra', 'acme/infra', 'other/web', 7]},
        {login: 'octo', repositories: ['octo/docs'], excludedRepositories: ['octo/site']},
        {login: 'cat', repositories: null},
    ]);
    assert.deepEqual(all.excludedRepositories, ['acme/infra']);
    assert.equal(only.repositories.length, 1);
    assert.deepEqual(only.excludedRepositories, []);
    assert.deepEqual(legacy.excludedRepositories, []);
});

test('keeps one spelling of a repository whatever its case', () => {
    const [owner] = normalizeOwnerFilters([
        {login: 'acme', repositories: null, excludedRepositories: ['acme/Web', 'ACME/web', 'acme/api']},
    ]);
    assert.deepEqual(owner.excludedRepositories, ['acme/Web', 'acme/api']);
});

test('merges duplicate owners into the wider scope', () => {
    const merge = (...owners) => normalizeOwnerFilters(owners)[0];
    assert.deepEqual(merge(
        {login: 'acme', repositories: null, excludedRepositories: ['acme/a', 'acme/b']},
        {login: 'ACME', repositories: null, excludedRepositories: ['acme/b', 'acme/c']}
    ).excludedRepositories, ['acme/b']);
    const mixed = merge(
        {login: 'acme', repositories: ['acme/a']},
        {login: 'acme', repositories: null, excludedRepositories: ['acme/a', 'acme/b']}
    );
    assert.equal(mixed.repositories, null);
    assert.deepEqual(mixed.excludedRepositories, ['acme/b']);
});

test('serializes exclusions in a stable order', () => {
    const saved = JSON.parse(serializeOwnerFilters([
        owner('acme', {excludedRepositories: ['acme/web', 'acme/api']}),
    ]));
    assert.deepEqual(saved[0].excludedRepositories, ['acme/api', 'acme/web']);
});

test('gives an owner with exclusions its own scope', () => {
    const scopes = searchScopes([
        owner('acme'),
        owner('octo'),
        owner('cat', {excludedRepositories: ['cat/dotfiles']}),
        owner('hub', {repositories: ['hub/docs']}),
        owner('off', {enabled: false, excludedRepositories: ['off/a']}),
    ], '');
    assert.deepEqual(scopes, [
        {type: 'owners', values: ['acme', 'octo'], excluded: [], hidden: []},
        {type: 'owners', values: ['cat'], excluded: ['cat/dotfiles'], hidden: []},
        {type: 'repositories', values: ['hub/docs'], excluded: [], hidden: []},
    ]);
});

test('hides exclusions that do not fit in the query', () => {
    const many = Array.from({length: 20}, (_, index) => 'acme/repository-' + index);
    const [scope] = searchScopes([owner('acme', {excludedRepositories: many})], '@me');
    assert.ok(scope.excluded.length > 0);
    assert.ok(scope.excluded.length < 16);
    assert.deepEqual([...scope.excluded, ...scope.hidden], many);
    const query = 'org:acme ' + scope.excluded.map(name => '-repo:' + name).join(' ');
    assert.ok(24 + 10 + query.length <= 220);
});

test('refetches a filtered search until it fills its share', () => {
    assert.equal(nextSearchLimit(31, 20, 20, 31), null);
    assert.equal(nextSearchLimit(31, 31, 31, 31), null);
    assert.equal(nextSearchLimit(31, 31, 12, 31), 124);
    assert.equal(nextSearchLimit(496, 496, 2, 31), 1000);
    assert.equal(nextSearchLimit(1000, 1000, 2, 31), null);
});
