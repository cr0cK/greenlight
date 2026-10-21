import assert from 'node:assert/strict';
import {test} from 'node:test';

import {describeGhFailure, parseReachability, reachabilityArguments} from '../src/github.js';

test('explains gh failures by cause', () => {
    assert.equal(describeGhFailure({exitCode: 4, stderr: ''}).kind, 'auth');
    assert.equal(describeGhFailure({exitCode: 1, stderr: 'HTTP 401: Bad credentials'}).kind, 'auth');
    assert.equal(describeGhFailure({exitCode: 1, stderr: 'API rate limit exceeded'}).kind, 'rate-limit');
    assert.equal(describeGhFailure({
        exitCode: 1,
        stderr: 'HTTP 403: You have exceeded a secondary rate limit.\nmore',
    }).detail, 'HTTP 403: You have exceeded a secondary rate limit.');
    assert.equal(describeGhFailure({
        exitCode: 1,
        stderr: 'error connecting to api.github.com\ndial tcp: lookup api.github.com: no such host',
    }).kind, 'network');
    assert.deepEqual(describeGhFailure({exitCode: 1, stderr: '\n  Something odd\nmore'}),
        {kind: 'other', message: 'gh failed: Something odd', detail: 'Something odd'});
    assert.deepEqual(describeGhFailure({exitCode: 2, stderr: ''}),
        {kind: 'other', message: 'gh failed with exit code 2.', detail: null});
});

test('checks owners and selected repositories in one query, through variables', () => {
    const {args, logins, repositories} = reachabilityArguments([
        {login: 'acme', repositories: ['acme/web', 'acme/api']},
        {login: 'octo', repositories: null},
        {login: 'dup', repositories: ['acme/web']},
    ]);
    assert.deepEqual(logins, ['acme', 'octo', 'dup']);
    assert.deepEqual(repositories, ['acme/web', 'acme/api']);
    assert.deepEqual(args.slice(0, 4), ['api', 'graphql', '--hostname', 'github.com']);
    const query = args[5];
    assert.match(query, /o2: repositoryOwner\(login: \$login2\)/);
    assert.match(query, /r1: repository\(owner: \$owner1, name: \$name1\)/);
    assert.ok(!query.includes('acme'));
    assert.ok(args.includes('login1=octo') && args.includes('name1=api'));
});

test('lists what a reachability response did not find', () => {
    const stdout = JSON.stringify({
        data: {o0: {login: 'acme'}, o1: null, r0: null, r1: {id: 'R_1'}},
        errors: [{type: 'NOT_FOUND'}],
    });
    assert.deepEqual(parseReachability(stdout, ['acme', 'gone'], ['acme/old', 'acme/api']),
        {owners: ['gone'], repositories: ['acme/old']});
    assert.throws(() => parseReachability('{"errors": []}', ['acme'], []));
});
