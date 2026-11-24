import assert from 'node:assert/strict';
import test from 'node:test';

import {planSave} from '../src/save.js';

const store = values => key => values[key];
const everything = () => true;

test('a save keeps the values that differ from the stored ones, in write order', () => {
    const plan = planSave(
        [
            {key: 'author-filter', value: 'monalisa'},
            {key: 'refresh-interval', value: 120},
            {key: 'owner-order', value: ['b', 'a']},
            {key: 'claude-quota-enabled', value: false},
        ],
        store({
            'author-filter': '@me',
            'refresh-interval': 120,
            'owner-order': ['a', 'b'],
            'claude-quota-enabled': false,
        }),
        everything
    );
    assert.deepEqual(plan.writes, [
        {key: 'author-filter', value: 'monalisa'},
        {key: 'owner-order', value: ['b', 'a']},
    ]);
    assert.equal(plan.blockedKey, null);
    assert.equal(plan.message, 'Preferences saved');
});

test('a save that changes nothing writes nothing and still succeeds', () => {
    const plan = planSave(
        [{key: 'author-filter', value: ''}, {key: 'owner-order', value: []}],
        store({'author-filter': '', 'owner-order': []}),
        everything
    );
    assert.deepEqual(plan.writes, []);
    assert.equal(plan.blockedKey, null);
    assert.equal(plan.message, 'Preferences saved');
});

test('one locked key writes nothing and names that key', () => {
    const plan = planSave(
        [
            {key: 'author-filter', value: 'monalisa'},
            {key: 'agent-quota-threshold', value: 90},
            {key: 'quick-open-shortcut', value: ['<Control>g']},
        ],
        store({'author-filter': '', 'agent-quota-threshold': 80, 'quick-open-shortcut': []}),
        key => key !== 'agent-quota-threshold'
    );
    assert.deepEqual(plan.writes, []);
    assert.equal(plan.blockedKey, 'agent-quota-threshold');
    assert.equal(plan.message, 'Could not save: agent-quota-threshold is not writable');
});

test('with several locked keys the first one in write order is named', () => {
    const plan = planSave(
        [{key: 'b-key', value: 1}, {key: 'a-key', value: 1}],
        store({'b-key': 0, 'a-key': 0}),
        () => false
    );
    assert.equal(plan.blockedKey, 'b-key');
});

test('a locked key whose value does not change does not block the save', () => {
    const plan = planSave(
        [{key: 'author-filter', value: 'monalisa'}, {key: 'agent-quota-threshold', value: 80}],
        store({'author-filter': '', 'agent-quota-threshold': 80}),
        key => key !== 'agent-quota-threshold'
    );
    assert.deepEqual(plan.writes, [{key: 'author-filter', value: 'monalisa'}]);
    assert.equal(plan.blockedKey, null);
});
