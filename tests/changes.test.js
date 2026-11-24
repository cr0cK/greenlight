import assert from 'node:assert/strict';
import test from 'node:test';

import {
    bannerTitle,
    classifyShortcut,
    normalizationsAtOpen,
    planChanges,
    sameShortcut,
    thresholdValue,
} from '../src/changes.js';
import {initialBlockOrder} from '../src/order.js';

const owner = (login, extra = {}) => ({
    login,
    kind: 'organization',
    enabled: true,
    repositories: null,
    excludedRepositories: [],
    ...extra,
});

const shortcut = (text, accelerator) =>
    classifyShortcut(text, {valid: accelerator !== undefined, name: accelerator});

const opened = () => ({
    author: '@me',
    refreshInterval: 120,
    shortcut: shortcut('<Super><Shift>g', '<Shift><Super>g'),
    owners: [owner('acme'), owner('octo', {kind: 'user'})],
    ownerOrder: ['acme', 'octo'],
    switches: {'claude-quota-enabled': true, 'codex-quota-enabled': false},
    quotaInterval: 60,
    threshold: 80,
    routines: ['nightly-report.timer'],
});
const stored = opened().owners;
const plan = (shown, baseline = opened(), pending = new Set(), storedOwners = stored) =>
    planChanges(shown, baseline, pending, storedOwners);
const change = values => ({...opened(), ...values});

test('a window as opened has no change and writes nothing', () => {
    assert.deepEqual(plan(opened()), {tabs: [], writes: [], invalidShortcut: false});
});

test('the author is compared trimmed, and typing it back clears the change', () => {
    assert.deepEqual(plan(change({author: 'monalisa'})).writes, [{key: 'author-filter', value: 'monalisa'}]);
    assert.deepEqual(plan(change({author: 'monalisa'})).tabs, ['Pull requests']);
    assert.deepEqual(plan(change({author: '  monalisa '})).writes, [{key: 'author-filter', value: 'monalisa'}]);
    // Spaces around the stored author or the typed one are not a change.
    assert.deepEqual(plan(change({author: ' @me  '})).tabs, []);
    assert.deepEqual(plan(change({author: '@me'}), change({author: ' @me'})).tabs, []);
});

test('the shortcut is blank, valid, or invalid', () => {
    assert.deepEqual(shortcut('  ', undefined), {kind: 'blank'});
    assert.deepEqual(shortcut('<Control>', undefined), {kind: 'invalid', text: '<Control>'});
    assert.deepEqual(shortcut('<Super><Shift>g', '<Shift><Super>g'), {kind: 'valid', accelerator: '<Shift><Super>g'});
});

test('two valid shortcuts are equal when they name the same accelerator', () => {
    assert.ok(sameShortcut(shortcut('<Shift><Super>g', '<Shift><Super>g'), shortcut('<Super><Shift>g', '<Shift><Super>g')));
    assert.ok(!sameShortcut(shortcut('<Super>h', '<Super>h'), shortcut('<Super>g', '<Super>g')));
    assert.ok(sameShortcut(shortcut('', undefined), shortcut(' ', undefined)));
    assert.ok(!sameShortcut(shortcut('', undefined), shortcut('<Super>g', '<Super>g')));
});

test('a changed valid shortcut is written, a blank one writes an empty list', () => {
    assert.deepEqual(plan(change({shortcut: shortcut('<Super>h', '<Super>h')})).writes,
        [{key: 'quick-open-shortcut', value: ['<Super>h']}]);
    assert.deepEqual(plan(change({shortcut: shortcut('', undefined)})).writes,
        [{key: 'quick-open-shortcut', value: []}]);
    // Written as the same accelerator: nothing changed.
    assert.deepEqual(plan(change({shortcut: shortcut('<Shift><Super>g', '<Shift><Super>g')})).writes, []);
});

test('an invalid shortcut differs from any stored value, and stops the save', () => {
    const result = plan(change({shortcut: shortcut('<Control>', undefined)}));
    assert.equal(result.invalidShortcut, true);
    assert.deepEqual(result.tabs, ['Pull requests']);
    assert.ok(!result.writes.some(({key}) => key === 'quick-open-shortcut'));
});

test('a stored invalid shortcut opens clean, still stops a save, and editing it makes a change', () => {
    const baseline = change({shortcut: shortcut('not-a-key', undefined)});
    const clean = plan(baseline, baseline);
    assert.deepEqual(clean.tabs, []);
    assert.deepEqual(clean.writes, []);
    // A save of another change is stopped while the stored shortcut stays invalid.
    assert.equal(plan({...baseline, quotaInterval: 120}, baseline).invalidShortcut, true);
    assert.deepEqual(plan({...baseline, quotaInterval: 120}, baseline).tabs, ['Agents']);
    const edited = plan(change({shortcut: shortcut('not-a-ke', undefined)}), baseline);
    assert.deepEqual(edited.tabs, ['Pull requests']);
    assert.equal(edited.invalidShortcut, true);
    assert.equal(plan(change({shortcut: shortcut('', undefined)}), baseline).invalidShortcut, false);
});

test('the Notify at text is a value only when it is a whole number from 50 to 100', () => {
    assert.equal(thresholdValue('83', 80), 83);
    assert.equal(thresholdValue(' 100 ', 80), 100);
    assert.equal(thresholdValue('50', 80), 50);
    for (const text of ['', 'abc', '8', '120', '83.5', '49', '101', '-60'])
        assert.equal(thresholdValue(text, 80), 80, text);
    assert.deepEqual(plan(change({threshold: thresholdValue('83', 80)})).writes,
        [{key: 'agent-quota-threshold', value: 83}]);
    assert.deepEqual(plan(change({threshold: thresholdValue('83.5', 80)})).tabs, []);
});

test('an owner list equal after Discover changed only a spelling is not a change', () => {
    const baseline = change({owners: [owner('acme', {repositories: ['acme/web', 'acme/api']})]});
    const shown = change({owners: [owner('Acme', {repositories: ['ACME/API', 'Acme/Web']})]});
    const stores = baseline.owners;
    assert.deepEqual(plan(shown, baseline, new Set(), stores).tabs, []);
    assert.deepEqual(plan(shown, baseline, new Set(), stores).writes, []);
});

test('a move, then a move back, leaves no change; a move alone writes the order only', () => {
    const moved = change({ownerOrder: ['octo', 'acme']});
    assert.deepEqual(plan(moved).tabs, ['Pull requests']);
    assert.deepEqual(plan(moved).writes, [{key: 'owner-order', value: ['octo', 'acme']}]);
    assert.deepEqual(plan(change({ownerOrder: ['acme', 'octo']})).tabs, []);
});

test('a completed order on open is clean, and the next save stores it', () => {
    const configured = [owner('octo', {kind: 'user'}), owner('acme'), owner('beta')];
    const storedOrder = ['gone', 'beta'];
    const blockOrder = initialBlockOrder(storedOrder, configured);
    assert.deepEqual(blockOrder, ['beta', 'octo', 'acme']);
    const pending = normalizationsAtOpen(
        {refreshInterval: 120, quotaInterval: 60, ownerOrder: storedOrder},
        {intervals: [30, 60, 120, 300, 600], quotaIntervals: [15, 30, 60, 120, 240], blockOrder}
    );
    assert.deepEqual([...pending], ['owner-order']);
    const baseline = change({owners: configured, ownerOrder: blockOrder});
    assert.deepEqual(plan(baseline, baseline, pending, configured).tabs, []);
    assert.deepEqual(plan(baseline, baseline, pending, configured).writes,
        [{key: 'owner-order', value: blockOrder}]);
    // A saved order that already matches normalizes nothing.
    assert.equal(normalizationsAtOpen(
        {refreshInterval: 120, quotaInterval: 60, ownerOrder: blockOrder},
        {intervals: [120], quotaIntervals: [60], blockOrder}).size, 0);
});

test('a paused owner is a change, and resuming it clears the change', () => {
    const paused = change({owners: [owner('acme', {enabled: false}), stored[1]]});
    const result = plan(paused);
    assert.deepEqual(result.tabs, ['Pull requests']);
    assert.deepEqual(result.writes.map(({key}) => key), ['owner-filters', 'owner-filters-configured']);
    assert.deepEqual(plan(change({owners: stored})).tabs, []);
});

test('owners changed and changed back, with the store changed meanwhile, write nothing', () => {
    const external = [owner('other')];
    assert.deepEqual(plan(change({owners: stored}), opened(), new Set(), external).writes, []);
});

test('changed owners are written unless the store already holds them', () => {
    const paused = change({owners: [owner('acme', {enabled: false}), stored[1]]});
    // Only the configured flag stays: the save drops it when the store holds it too.
    assert.deepEqual(plan(paused, opened(), new Set(), paused.owners).writes,
        [{key: 'owner-filters-configured', value: true}]);
    assert.deepEqual(plan(paused, opened(), new Set(), paused.owners).tabs, ['Pull requests']);
});

test('a mode change that keeps the stored scope is not a change; All except to Only is', () => {
    // All to All except with nothing excluded stores the same scope.
    assert.deepEqual(plan(change({owners: [owner('acme', {repositories: null, excludedRepositories: []}), stored[1]]})).tabs, []);
    const baseline = change({owners: [owner('acme', {excludedRepositories: ['acme/old']}), stored[1]]});
    const only = change({owners: [owner('acme', {repositories: ['acme/web']}), stored[1]]});
    assert.deepEqual(plan(only, baseline, new Set(), baseline.owners).tabs, ['Pull requests']);
    // Only with every repository selected differs from All except with none excluded.
    const everything = change({owners: [owner('acme', {repositories: ['acme/a', 'acme/b']}), stored[1]]});
    assert.deepEqual(plan(everything).tabs, ['Pull requests']);
});

test('an added and a removed owner are changes', () => {
    assert.deepEqual(plan(change({owners: [...stored, owner('new')], ownerOrder: ['new', 'acme', 'octo']})).tabs,
        ['Pull requests']);
    assert.deepEqual(plan(change({owners: [stored[0]], ownerOrder: ['acme']})).tabs, ['Pull requests']);
});

test('the Agents settings name the Agents tab, and both tabs can change together', () => {
    assert.deepEqual(plan(change({quotaInterval: 120})).tabs, ['Agents']);
    assert.deepEqual(plan(change({switches: {'claude-quota-enabled': false, 'codex-quota-enabled': false}})).tabs,
        ['Agents']);
    assert.deepEqual(plan(change({author: 'x', threshold: 90})).tabs, ['Pull requests', 'Agents']);
    assert.deepEqual(plan(change({refreshInterval: 300})).writes, [{key: 'refresh-interval', value: 300}]);
});

test('pending normalizations are written without a banner, and only once adjusted', () => {
    const pending = normalizationsAtOpen(
        {refreshInterval: 45, quotaInterval: 90, ownerOrder: ['acme', 'octo']},
        {intervals: [30, 60, 120, 300, 600], quotaIntervals: [15, 30, 60, 120, 240], blockOrder: ['acme', 'octo']}
    );
    assert.deepEqual([...pending].sort(), ['agent-quota-interval', 'refresh-interval']);
    const result = plan(opened(), opened(), pending);
    assert.deepEqual(result.tabs, []);
    assert.deepEqual(result.writes, [
        {key: 'refresh-interval', value: 120},
        {key: 'agent-quota-interval', value: 60},
    ]);
});

test('a provider turned off by its check is a pending normalization, not a change', () => {
    const baseline = change({switches: {'claude-quota-enabled': false, 'codex-quota-enabled': false}});
    const pending = new Set(['claude-quota-enabled']);
    assert.deepEqual(plan(baseline, baseline, pending).tabs, []);
    assert.deepEqual(plan(baseline, baseline, pending).writes, [{key: 'claude-quota-enabled', value: false}]);
    // With another tab unsaved, the normalization still goes in the same batch.
    const result = plan({...baseline, author: 'x'}, baseline, pending);
    assert.deepEqual(result.tabs, ['Pull requests']);
    assert.deepEqual(result.writes.map(({key}) => key), ['author-filter', 'claude-quota-enabled']);
});

test('a provider locked on by a failed check is left out of the batch', () => {
    const result = plan(change({author: 'x'}));
    assert.deepEqual(result.writes, [{key: 'author-filter', value: 'x'}]);
});

test('the banner names the tabs in tab order', () => {
    assert.equal(bannerTitle(['Pull requests']), 'Unsaved changes in Pull requests');
    assert.equal(bannerTitle(['Pull requests', 'Agents']), 'Unsaved changes in Pull requests and Agents');
    assert.equal(bannerTitle(['Pull requests', 'Agents', 'Routines']),
        'Unsaved changes in Pull requests, Agents, and Routines');
});

test('a switched timer is a change of Routines, saved sorted', () => {
    const shown = change({routines: ['sync-mail.timer', 'nightly-report.timer']});
    assert.deepEqual(plan(shown).tabs, ['Routines']);
    assert.deepEqual(plan(shown).writes, [
        {key: 'watched-routines', value: ['nightly-report.timer', 'sync-mail.timer']},
    ]);
    assert.deepEqual(plan(change({routines: []})).writes, [{key: 'watched-routines', value: []}]);
});

test('the order of the switched timers is not a change, and switching one back clears it', () => {
    const baseline = change({routines: ['b.timer', 'a.timer']});
    assert.deepEqual(plan(change({routines: ['a.timer', 'b.timer']}), baseline), {tabs: [], writes: [], invalidShortcut: false});
    const switched = change({routines: ['b.timer', 'a.timer', 'c.timer']});
    assert.deepEqual(plan(switched, baseline).tabs, ['Routines']);
    assert.deepEqual(plan(change({routines: ['b.timer', 'a.timer']}), baseline).tabs, []);
});

test('a save from another tab keeps the watched timers as stored', () => {
    const changes = plan(change({threshold: 90}));
    assert.deepEqual(changes.tabs, ['Agents']);
    assert.deepEqual(changes.writes, [{key: 'agent-quota-threshold', value: 90}]);
});

test('Routines joins the other tabs in tab order', () => {
    const changes = plan(change({author: 'monalisa', threshold: 90, routines: []}));
    assert.deepEqual(changes.tabs, ['Pull requests', 'Agents', 'Routines']);
    assert.equal(bannerTitle(changes.tabs), 'Unsaved changes in Pull requests, Agents, and Routines');
});
