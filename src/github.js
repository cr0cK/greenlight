/**
 * Explains a failed gh call in words a user can act on. gh exits with 4 when it has no
 * authentication; the other cases are only told apart by their message.
 */
export function describeGhFailure({exitCode, stderr}) {
    const text = stderr ?? '';
    if (exitCode === 4 || /gh auth login|HTTP 401|bad credentials/i.test(text)) {
        return {
            kind: 'auth',
            message: 'gh is not signed in to GitHub. Run gh auth login in a terminal, then refresh.',
        };
    }
    if (/rate limit/i.test(text)) {
        return {
            kind: 'rate-limit',
            message: 'GitHub rate limit reached. Greenlight tries again at the next refresh.',
        };
    }
    if (/could not resolve|no such host|dial tcp|connection refused|network is unreachable|timeout|TLS/i
        .test(text))
        return {kind: 'network', message: 'Could not reach GitHub. Check the network connection.'};

    const line = text.split('\n').map(part => part.trim()).find(Boolean);
    return {
        kind: 'other',
        message: line ? 'gh failed: ' + line : 'gh failed with exit code ' + exitCode + '.',
    };
}

/**
 * Checks in one GraphQL request that every owner and every selected repository still exists for
 * gh. Logins and names travel as variables, never inside the query text.
 */
export function reachabilityArguments(owners) {
    const logins = owners.map(owner => owner.login);
    const repositories = [...new Set(owners.flatMap(owner => owner.repositories ?? []))];
    const variables = [];
    const fields = [];
    const values = [];
    logins.forEach((login, index) => {
        variables.push('$login' + index + ': String!');
        fields.push('o' + index + ': repositoryOwner(login: $login' + index + ') { login }');
        values.push('-f', 'login' + index + '=' + login);
    });
    repositories.forEach((repository, index) => {
        const [owner, name] = repository.split('/');
        variables.push('$owner' + index + ': String!, $name' + index + ': String!');
        fields.push('r' + index + ': repository(owner: $owner' + index + ', name: $name' + index +
            ') { id }');
        values.push('-f', 'owner' + index + '=' + owner, '-f', 'name' + index + '=' + name);
    });

    return {
        logins,
        repositories,
        args: [
            'api', 'graphql', '--hostname', 'github.com',
            '-f', 'query=query(' + variables.join(', ') + ') { ' + fields.join(' ') + ' }',
            ...values,
        ],
    };
}

/**
 * Lists the owners and repositories a reachability response did not find. gh exits with 1 when
 * a repository is missing but still prints the data, so the exit code is not checked here; a
 * response without data throws.
 */
export function parseReachability(stdout, logins, repositories) {
    const data = JSON.parse(stdout)?.data;
    if (!data || typeof data !== 'object')
        throw new Error('gh api graphql returned no reachability data');

    return {
        owners: logins.filter((_, index) => !data['o' + index]),
        repositories: repositories.filter((_, index) => !data['r' + index]),
    };
}
