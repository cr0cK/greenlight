import assert from 'node:assert/strict';
import {test} from 'node:test';

import {
    lookupArguments,
    parseLookupResponse,
    parsePreviewResponse,
    previewArguments,
    summarizeRollup,
} from '../src/preview.js';

const pullRequest = (overrides = {}) => JSON.stringify({
    data: {
        repository: {
            issueOrPullRequest: {
                __typename: 'PullRequest',
                title: 'ci: remove the liveness monitor',
                state: 'OPEN',
                isDraft: false,
                body: '## Why\nIt pages us.',
                headRefName: 'ci/rm-liveness',
                baseRefName: 'main',
                additions: 12,
                deletions: 148,
                author: {login: 'octocat'},
                commits: {nodes: [{commit: {statusCheckRollup: {contexts: {nodes: [
                    {__typename: 'CheckRun', name: 'lint', status: 'COMPLETED', conclusion: 'FAILURE'},
                    {__typename: 'CheckRun', name: 'unit', status: 'COMPLETED', conclusion: 'SUCCESS'},
                ]}}}}]},
                ...overrides,
            },
        },
    },
});

test('builds gh arguments with string owner and name and a typed number', () => {
    const args = previewArguments('octo-org/123', 42);
    assert.deepEqual(args.slice(0, 4), ['api', 'graphql', '--hostname', 'github.com']);
    assert.deepEqual(args.slice(6), ['-f', 'owner=octo-org', '-f', 'name=123', '-F', 'number=42']);
});

test('classifies check runs and commit statuses', () => {
    const summary = summarizeRollup([
        {__typename: 'CheckRun', name: 'a', status: 'COMPLETED', conclusion: 'SUCCESS'},
        {__typename: 'CheckRun', name: 'b', status: 'COMPLETED', conclusion: 'TIMED_OUT'},
        {__typename: 'CheckRun', name: 'c', status: 'IN_PROGRESS', conclusion: null},
        {__typename: 'CheckRun', name: 'd', status: 'COMPLETED', conclusion: 'SKIPPED'},
        {__typename: 'CheckRun', name: 'e', status: 'COMPLETED', conclusion: 'CANCELLED'},
        {__typename: 'StatusContext', context: 'ci/legacy', state: 'ERROR'},
        {__typename: 'StatusContext', context: 'ci/wait', state: 'PENDING'},
    ]);
    assert.deepEqual(summary, {
        total: 7, passed: 1, failed: 2, pending: 2, skipped: 2, unloaded: 0,
        failedNames: ['b', 'ci/legacy'],
    });
});

test('counts checks beyond the fetched page as unloaded', () => {
    const summary = summarizeRollup([
        {__typename: 'CheckRun', name: 'a', status: 'COMPLETED', conclusion: 'SUCCESS'},
    ], 140);
    assert.deepEqual([summary.passed, summary.unloaded, summary.total], [1, 139, 140]);
    const preview = parsePreviewResponse(pullRequest({
        commits: {nodes: [{commit: {statusCheckRollup: {contexts: {totalCount: 101, nodes: [
            {__typename: 'CheckRun', name: 'a', status: 'COMPLETED', conclusion: 'SUCCESS'},
        ]}}}}]},
    }));
    assert.deepEqual([preview.checks.unloaded, preview.checks.total], [100, 101]);
});

test('parses a pull request preview', () => {
    const preview = parsePreviewResponse(pullRequest());
    assert.equal(preview.kind, 'pull-request');
    assert.equal(preview.state, 'open');
    assert.equal(preview.author, 'octocat');
    assert.deepEqual(preview.checks.failedNames, ['lint']);
    assert.equal(preview.checks.passed, 1);
    assert.equal(preview.body, '## Why\nIt pages us.');
});

test('maps draft, merged, and caps failed check names', () => {
    assert.equal(parsePreviewResponse(pullRequest({isDraft: true})).state, 'draft');
    assert.equal(parsePreviewResponse(pullRequest({state: 'MERGED'})).state, 'merged');
    const failing = Array.from({length: 5}, (_, index) => ({
        __typename: 'CheckRun', name: 'job' + index, status: 'COMPLETED', conclusion: 'FAILURE',
    }));
    const preview = parsePreviewResponse(pullRequest({
        commits: {nodes: [{commit: {statusCheckRollup: {contexts: {nodes: failing}}}}]},
    }));
    assert.deepEqual(preview.checks.failedNames, ['job0', 'job1', 'job2']);
    assert.equal(preview.checks.hiddenFailedCount, 2);
    assert.equal(parsePreviewResponse(pullRequest({commits: {nodes: []}})).checks.total, 0);
});

test('parses an issue preview', () => {
    const preview = parsePreviewResponse(JSON.stringify({data: {repository: {issueOrPullRequest: {
        __typename: 'Issue',
        title: 'Crash',
        state: 'CLOSED',
        stateReason: 'COMPLETED',
        body: '',
        author: null,
        comments: {totalCount: 3},
        labels: {nodes: [{name: 'bug'}]},
    }}}}));
    assert.equal(preview.kind, 'issue');
    assert.equal(preview.state, 'completed');
    assert.equal(preview.checks, null);
    assert.equal(preview.comments, 3);
    assert.deepEqual(preview.labels, ['bug']);
});

test('returns null for missing numbers and repositories, throws otherwise', () => {
    assert.equal(parsePreviewResponse(JSON.stringify({
        data: {repository: {issueOrPullRequest: null}},
        errors: [{type: 'NOT_FOUND'}],
    })), null);
    assert.equal(parsePreviewResponse(JSON.stringify({
        data: {repository: null},
        errors: [{type: 'NOT_FOUND'}],
    })), null);
    assert.throws(() => parsePreviewResponse('{"errors":[{"type":"FORBIDDEN"}]}'));
    assert.throws(() => parsePreviewResponse('gh: not logged in'));
});

test('looks up one number across repositories with variables, not inline names', () => {
    const args = lookupArguments(['octo-org/web-platform', 'octocat/greenlight'], 1291);
    assert.deepEqual(args.slice(0, 4), ['api', 'graphql', '--hostname', 'github.com']);
    const query = args[5];
    assert.match(query, /^query=query\(\$number: Int!, \$o0: String!, \$n0: String!, \$o1: String!/);
    assert.match(query, /r1: repository\(owner: \$o1, name: \$n1\)/);
    assert.doesNotMatch(query, /octo-org|greenlight/);
    assert.deepEqual(args.slice(6), [
        '-F', 'number=1291',
        '-f', 'o0=octo-org', '-f', 'n0=web-platform',
        '-f', 'o1=octocat', '-f', 'n1=greenlight',
    ]);
});

test('maps lookup results back to repositories, missing repositories included', () => {
    const repositories = ['a/found', 'a/no-number', 'a/no-repo'];
    assert.deepEqual(parseLookupResponse(JSON.stringify({
        data: {
            r0: {issueOrPullRequest: {__typename: 'PullRequest', title: 'Fix'}},
            r1: {issueOrPullRequest: null},
            r2: null,
        },
        errors: [{type: 'NOT_FOUND'}, {type: 'NOT_FOUND'}],
    }), repositories), [
        {repository: 'a/found', found: true, title: 'Fix'},
        {repository: 'a/no-number', found: false, title: null},
        {repository: 'a/no-repo', found: false, title: null},
    ]);
    assert.throws(() => parseLookupResponse('{"errors":[{"type":"RATE_LIMITED"}]}', repositories));
});
