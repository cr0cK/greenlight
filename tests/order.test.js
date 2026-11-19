import assert from 'node:assert/strict';
import test from 'node:test';

import {
    UNKNOWN_OWNER,
    buttonFocusedAfterMove,
    canMoveOwnerRow,
    moveOwnerRow,
    orderOwnerSections,
    readOwnerOrder,
    readOwnerOrderMode,
    reconcileOwnerRows,
} from '../src/order.js';

const section = (owner, latestUpdate) => ({owner, latestUpdate});
const owners = groups => groups.map(group => group.owner);

test('any mode but custom reads as newest', () => {
    assert.equal(readOwnerOrderMode('custom'), 'custom');
    assert.equal(readOwnerOrderMode('newest'), 'newest');
    for (const value of ['', 'Custom', 'alphabetical', null, undefined, 3])
        assert.equal(readOwnerOrderMode(value), 'newest');
});

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

test('the buttons are insensitive in the activity mode and past the ends', () => {
    assert.equal(canMoveOwnerRow('newest', 3, 1, -1), false);
    assert.equal(canMoveOwnerRow('newest', 3, 1, 1), false);
    assert.equal(canMoveOwnerRow('custom', 3, 0, -1), false);
    assert.equal(canMoveOwnerRow('custom', 3, 0, 1), true);
    assert.equal(canMoveOwnerRow('custom', 3, 2, 1), false);
    assert.equal(canMoveOwnerRow('custom', 3, 2, -1), true);
    assert.equal(canMoveOwnerRow('custom', 1, 0, -1), false);
    assert.equal(canMoveOwnerRow('custom', 1, 0, 1), false);
});

test('the activity mode orders by newest pull request, ties by name, and ignores the saved order', () => {
    const groups = [section('b', 10), section('a', 10), section(UNKNOWN_OWNER, 50), section('c', 99)];
    assert.deepEqual(owners(orderOwnerSections(groups, 'newest', ['b', 'a'])),
        ['c', UNKNOWN_OWNER, 'a', 'b']);
});

test('the custom mode lists the saved owners first, in their order, whatever their case', () => {
    const groups = [section('acme', 99), section('Octocat', 1), section('globex', 50)];
    assert.deepEqual(owners(orderOwnerSections(groups, 'custom', ['octocat', 'GLOBEX', 'acme'])),
        ['Octocat', 'globex', 'acme']);
});

test('the custom mode puts unlisted owners after, by newest pull request, ties by name', () => {
    const groups = [
        section('late', 5), section('listed', 1), section('new', 90), section('also', 90),
    ];
    assert.deepEqual(owners(orderOwnerSections(groups, 'custom', ['listed'])),
        ['listed', 'also', 'new', 'late']);
});

test('the custom mode puts the section without an owner last, even when it is the newest', () => {
    const groups = [section(UNKNOWN_OWNER, 999), section('unlisted', 1), section('listed', 0)];
    assert.deepEqual(owners(orderOwnerSections(groups, 'custom', ['listed'])),
        ['listed', 'unlisted', UNKNOWN_OWNER]);
    assert.deepEqual(owners(orderOwnerSections(groups, 'custom', [])),
        ['unlisted', 'listed', UNKNOWN_OWNER]);
});

test('an order that names an owner without sections changes nothing', () => {
    const groups = [section('a', 1), section('b', 2)];
    assert.deepEqual(owners(orderOwnerSections(groups, 'custom', ['gone', 'a'])), ['a', 'b']);
});

test('ordering never mutates its input', () => {
    const groups = [section('a', 1), section('b', 2)];
    orderOwnerSections(groups, 'newest', []);
    assert.deepEqual(owners(groups), ['a', 'b']);
});
