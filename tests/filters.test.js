import assert from 'node:assert/strict';
import {test} from 'node:test';

import {
    nextSearchLimit,
    normalizeOwnerFilters,
    sameOwnerFilters,
    searchScopes,
    ownerFiltersToSave,
    serializeOwnerFilters,
    withoutUnreachable,
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

test('keeps a paused duplicate from widening an enabled owner', () => {
    const merge = (...owners) => normalizeOwnerFilters(owners)[0];
    for (const owners of [
        [{login: 'acme', enabled: true, repositories: ['acme/web']},
            {login: 'acme', enabled: false, repositories: null}],
        [{login: 'acme', enabled: false, repositories: null},
            {login: 'acme', enabled: true, repositories: ['acme/web']}],
    ]) {
        const merged = merge(...owners);
        assert.equal(merged.enabled, true);
        assert.deepEqual(merged.repositories, ['acme/web']);
    }
    const paused = merge(
        {login: 'acme', enabled: false, repositories: ['acme/web']},
        {login: 'acme', enabled: false, repositories: ['ACME/web', 'acme/api']}
    );
    assert.equal(paused.enabled, false);
    assert.deepEqual(paused.repositories, ['acme/web', 'acme/api']);
    assert.deepEqual(merge(
        {login: 'acme', repositories: null, excludedRepositories: ['acme/Web']},
        {login: 'acme', repositories: ['ACME/web']}
    ).excludedRepositories, []);
});

test('serializes exclusions in a stable order', () => {
    const saved = JSON.parse(serializeOwnerFilters([
        owner('acme', {excludedRepositories: ['acme/web', 'acme/api']}),
    ]));
    assert.deepEqual(saved[0].excludedRepositories, ['acme/api', 'acme/web']);
});

test('serializes owners in the kind-then-login order, whatever their order in the window', () => {
    const owners = [
        owner('zed', {kind: 'organization'}),
        owner('amy', {kind: 'organization'}),
        owner('Zoe', {kind: 'user'}),
        owner('ann', {kind: 'owner'}),
    ];
    const names = JSON.parse(serializeOwnerFilters(owners)).map(entry => entry.login);
    assert.deepEqual(names, ['Zoe', 'amy', 'zed', 'ann']);
    assert.equal(serializeOwnerFilters([...owners].reverse()), serializeOwnerFilters(owners));
});

test('a stored document in another order serializes like the window\'s owners', () => {
    const stored = JSON.stringify([
        {login: 'octo', kind: 'organization', enabled: true, repositories: null},
        {login: 'cat', kind: 'user', enabled: true, repositories: null},
    ]);
    const window = [owner('cat', {kind: 'user'}), owner('octo', {kind: 'organization'})];
    assert.equal(serializeOwnerFilters(JSON.parse(stored)), serializeOwnerFilters(window));
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

test('drops owners and selected repositories gh cannot find', () => {
    const kept = withoutUnreachable([
        owner('acme', {repositories: ['acme/web', 'acme/old']}),
        owner('Gone'),
        owner('hub', {repositories: ['hub/old']}),
        owner('octo'),
    ], {owners: ['gone'], repositories: ['ACME/old', 'hub/old']});
    assert.deepEqual(kept.map(entry => [entry.login, entry.repositories]),
        [['acme', ['acme/web']], ['octo', null]]);
});

test('a save writes owner-filters only when the owners changed, whatever the block order', () => {
    const stored = [owner('octo', {kind: 'organization'}), owner('cat', {kind: 'user'})];
    // The same owners, blocks moved: nothing to write.
    assert.equal(ownerFiltersToSave(stored, [stored[1], stored[0]]), null);
    assert.equal(ownerFiltersToSave(stored, [stored[0], stored[1]]), null);
    // A paused owner, an added owner, a removed one: the serialized document.
    assert.ok(ownerFiltersToSave(stored, [owner('cat', {kind: 'user', enabled: false}), stored[0]]));
    assert.ok(ownerFiltersToSave(stored, [...stored, owner('new', {kind: 'user'})]));
    assert.ok(ownerFiltersToSave(stored, [stored[0]]));
    // Owners added then removed again, on an empty store: nothing to write.
    assert.equal(ownerFiltersToSave([], []), null);
});

test('owner-filters compares names case-insensitively and keeps the stored spelling', () => {
    const stored = [owner('Acme', {kind: 'organization', repositories: ['Acme/Web', 'Acme/api']})];
    const rediscovered = [owner('acme', {kind: 'organization', repositories: ['acme/API', 'ACME/web']})];
    assert.equal(ownerFiltersToSave(stored, rediscovered), null);
    assert.ok(sameOwnerFilters(stored, rediscovered));
    // A different scope is a change, and the window's spelling is what gets written.
    const changed = [owner('acme', {kind: 'organization', repositories: ['acme/web']})];
    assert.equal(ownerFiltersToSave(stored, changed), serializeOwnerFilters(changed));
    // The mode is kept: nothing excluded is not the same as an empty selection.
    assert.ok(!sameOwnerFilters([owner('acme')], [owner('acme', {repositories: []})]));
});

test('a save keeps the stored spelling of the owners it did not change', () => {
    const stored = [owner('Acme', {repositories: ['Acme/Web']}), owner('octo')];
    const written = ownerFiltersToSave(stored, [
        owner('acme', {repositories: ['ACME/web']}),
        owner('octo', {enabled: false}),
    ]);
    assert.deepEqual(JSON.parse(written).map(entry => [entry.login, entry.repositories, entry.enabled]),
        [['Acme', ['Acme/Web'], true], ['octo', null, false]]);
});
