import assert from 'node:assert/strict';
import test from 'node:test';

import {
    UNKNOWN_OWNER,
    buttonFocusedAfterMove,
    canMoveOwnerRow,
    compareOwnersKindThenLogin,
    initialBlockOrder,
    moveOwnerRow,
    orderOwnerSections,
    readOwnerOrder,
    reconcileOwnerRows,
} from '../src/order.js';

const section = (owner, latestUpdate) => ({owner, latestUpdate});
const owners = groups => groups.map(group => group.owner);

test('the saved order ignores non-strings and duplicates, whatever their case', () => {
    assert.deepEqual(readOwnerOrder(['Acme', 3, null, 'acme', 'octocat', 'ACME', {}, 'OctoCat']),
        ['Acme', 'octocat']);
    assert.deepEqual(readOwnerOrder(undefined), []);
    assert.deepEqual(readOwnerOrder('acme'), []);
});

test('the rows start from the saved order, then the owners it misses in block order', () => {
    assert.deepEqual(
        reconcileOwnerRows(['octocat', 'acme'], ['acme', 'globex', 'octocat', 'initech']),
        ['octocat', 'acme', 'globex', 'initech']
    );
});

test('the rows drop unknown logins and spell owners as configured', () => {
    assert.deepEqual(reconcileOwnerRows(['gone', 'OCTOCAT', 'gone'], ['Acme', 'octocat']),
        ['octocat', 'Acme']);
    assert.deepEqual(reconcileOwnerRows([], ['b', 'a']), ['b', 'a']);
    assert.deepEqual(reconcileOwnerRows(['a'], []), []);
});

test('adding an owner appends it, removing one keeps the others in place', () => {
    const rows = ['octocat', 'acme', 'globex'];
    assert.deepEqual(reconcileOwnerRows(rows, ['globex', 'acme', 'octocat', 'initech']),
        ['octocat', 'acme', 'globex', 'initech']);
    assert.deepEqual(reconcileOwnerRows(rows, ['globex', 'octocat']), ['octocat', 'globex']);
});

test('a move swaps a row with its neighbour and stops at the ends', () => {
    const rows = ['a', 'b', 'c'];
    assert.deepEqual(moveOwnerRow(rows, 1, -1), ['b', 'a', 'c']);
    assert.deepEqual(moveOwnerRow(rows, 1, 1), ['a', 'c', 'b']);
    assert.deepEqual(moveOwnerRow(rows, 0, -1), rows);
    assert.deepEqual(moveOwnerRow(rows, 2, 1), rows);
    assert.deepEqual(rows, ['a', 'b', 'c']);
});

test('the focus follows the button used, or the other one at an end', () => {
    // Moving up from index 2 of 4 lands on index 1: the up button stays usable.
    assert.equal(buttonFocusedAfterMove(4, 1, -1), 'up');
    // Moving up onto the first place makes up insensitive.
    assert.equal(buttonFocusedAfterMove(4, 0, -1), 'down');
    assert.equal(buttonFocusedAfterMove(4, 2, 1), 'down');
    // Moving down onto the last place makes down insensitive.
    assert.equal(buttonFocusedAfterMove(4, 3, 1), 'up');
    assert.equal(buttonFocusedAfterMove(2, 1, 1), 'up');
});

test('the buttons are insensitive past the ends', () => {
    assert.equal(canMoveOwnerRow(3, 0, -1), false);
    assert.equal(canMoveOwnerRow(3, 0, 1), true);
    assert.equal(canMoveOwnerRow(3, 1, -1), true);
    assert.equal(canMoveOwnerRow(3, 1, 1), true);
    assert.equal(canMoveOwnerRow(3, 2, 1), false);
    assert.equal(canMoveOwnerRow(3, 2, -1), true);
});

test('a single owner has both buttons insensitive', () => {
    assert.equal(canMoveOwnerRow(1, 0, -1), false);
    assert.equal(canMoveOwnerRow(1, 0, 1), false);
});

test('a single owner does not move', () => {
    assert.deepEqual(moveOwnerRow(['a'], 0, -1), ['a']);
    assert.deepEqual(moveOwnerRow(['a'], 0, 1), ['a']);
});

test('pressing the same button twice moves a block two places', () => {
    let rows = ['a', 'b', 'c', 'd'];
    rows = moveOwnerRow(rows, rows.indexOf('d'), -1);
    rows = moveOwnerRow(rows, rows.indexOf('d'), -1);
    assert.deepEqual(rows, ['a', 'd', 'b', 'c']);
});

const owner = (login, kind) => ({login, kind});

test('owners rank personal accounts, then organizations, then others, each by login', () => {
    const owners = [owner('zed', 'owner'), owner('beta', 'organization'), owner('Zoe', 'user'),
        owner('alpha', 'organization'), owner('amy', 'user'), owner('ann', 'owner')];
    assert.deepEqual([...owners].sort(compareOwnersKindThenLogin).map(entry => entry.login),
        ['amy', 'Zoe', 'alpha', 'beta', 'ann', 'zed']);
});

test('the blocks open in the saved order, then the missing owners by kind and login', () => {
    const owners = [owner('acme', 'organization'), owner('octocat', 'user'),
        owner('globex', 'organization'), owner('zed', 'owner')];
    assert.deepEqual(initialBlockOrder(['globex', 'zed'], owners),
        ['globex', 'zed', 'octocat', 'acme']);
});

test('an empty saved order gives the kind-then-login order', () => {
    const owners = [owner('acme', 'organization'), owner('octocat', 'user'),
        owner('zed', 'owner'), owner('globex', 'organization')];
    assert.deepEqual(initialBlockOrder([], owners), ['octocat', 'acme', 'globex', 'zed']);
    assert.deepEqual(initialBlockOrder(undefined, owners), ['octocat', 'acme', 'globex', 'zed']);
    assert.deepEqual(initialBlockOrder([], []), []);
});

test('the initial block order drops unknown logins and spells owners as configured', () => {
    const owners = [owner('Acme', 'organization'), owner('octocat', 'user')];
    assert.deepEqual(initialBlockOrder(['gone', 'ACME', 'acme', 'Gone'], owners),
        ['Acme', 'octocat']);
});

test('the initial block order does not mutate its input', () => {
    const owners = [owner('b', 'organization'), owner('a', 'user')];
    initialBlockOrder([], owners);
    assert.deepEqual(owners.map(entry => entry.login), ['b', 'a']);
});

test('the sections follow the block order, whatever their activity', () => {
    const groups = [section('acme', 99), section('Octocat', 1), section('globex', 50)];
    assert.deepEqual(owners(orderOwnerSections(groups, ['octocat', 'GLOBEX', 'acme'])),
        ['Octocat', 'globex', 'acme']);
});

test('an empty saved order, completed by the owner filters, lists personal accounts first', () => {
    const configured = [owner('acme', 'organization'), owner('octocat', 'user')];
    const groups = [section('acme', 99), section('octocat', 1)];
    assert.deepEqual(owners(orderOwnerSections(groups, initialBlockOrder([], configured))),
        ['octocat', 'acme']);
});

test('owners without a block follow, by newest pull request, ties by name', () => {
    const groups = [
        section('late', 5), section('listed', 1), section('new', 90), section('also', 90),
    ];
    assert.deepEqual(owners(orderOwnerSections(groups, ['listed'])),
        ['listed', 'also', 'new', 'late']);
});

test('with no block at all every section is ordered by newest pull request', () => {
    const groups = [section('b', 10), section('a', 10), section('c', 99)];
    assert.deepEqual(owners(orderOwnerSections(groups, [])), ['c', 'a', 'b']);
    assert.deepEqual(owners(orderOwnerSections(groups, undefined)), ['c', 'a', 'b']);
});

test('the section without an owner comes last, even when it is the newest', () => {
    const groups = [section(UNKNOWN_OWNER, 999), section('unlisted', 1), section('listed', 0)];
    assert.deepEqual(owners(orderOwnerSections(groups, ['listed'])),
        ['listed', 'unlisted', UNKNOWN_OWNER]);
    assert.deepEqual(owners(orderOwnerSections(groups, [])), ['unlisted', 'listed', UNKNOWN_OWNER]);
});

test('a block order that names an owner without sections changes nothing', () => {
    const groups = [section('a', 1), section('b', 2)];
    assert.deepEqual(owners(orderOwnerSections(groups, ['gone', 'a'])), ['a', 'b']);
});

test('ordering never mutates its input', () => {
    const groups = [section('a', 1), section('b', 2)];
    orderOwnerSections(groups, []);
    assert.deepEqual(owners(groups), ['a', 'b']);
});
