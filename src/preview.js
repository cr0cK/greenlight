const PREVIEW_FAILED_NAMES = 3;

/** Reads an issue or pull request with its latest check rollup in one GraphQL request. */
export const PREVIEW_QUERY = `
query($owner: String!, $name: String!, $number: Int!) {
  repository(owner: $owner, name: $name) {
    issueOrPullRequest(number: $number) {
      __typename
      ... on Issue {
        title state stateReason body
        author { login }
        comments { totalCount }
        labels(first: 6) { nodes { name } }
      }
      ... on PullRequest {
        title state isDraft body headRefName baseRefName additions deletions
        author { login }
        commits(last: 1) { nodes { commit { statusCheckRollup { contexts(first: 100) {
          totalCount
          nodes {
            __typename
            ... on CheckRun { name status conclusion }
            ... on StatusContext { context state }
          }
        } } } } }
      }
    }
  }
}`;

/** Builds gh arguments for a preview; owner and name stay strings even when numeric. */
export function previewArguments(repository, number) {
    const [owner, name] = repository.split('/');
    // Suggestions open github.com URLs, so an inherited GH_HOST must not redirect the query.
    return [
        'api', 'graphql', '--hostname', 'github.com',
        '-f', 'query=' + PREVIEW_QUERY,
        '-f', 'owner=' + owner,
        '-f', 'name=' + name,
        '-F', 'number=' + number,
    ];
}

/**
 * Checks one number across several repositories in a single GraphQL request, one alias per
 * repository. Owner and name travel as variables, never inside the query text.
 */
export function lookupArguments(repositories, number) {
    const variables = [];
    const fields = [];
    const values = [];
    repositories.forEach((repository, index) => {
        const [owner, name] = repository.split('/');
        variables.push('$o' + index + ': String!, $n' + index + ': String!');
        fields.push('r' + index + ': repository(owner: $o' + index + ', name: $n' + index + ') {' +
            ' issueOrPullRequest(number: $number) {' +
            ' __typename ... on Issue { title } ... on PullRequest { title } } }');
        values.push('-f', 'o' + index + '=' + owner, '-f', 'n' + index + '=' + name);
    });

    return [
        'api', 'graphql', '--hostname', 'github.com',
        '-f', 'query=query($number: Int!, ' + variables.join(', ') + ') { ' + fields.join(' ') + ' }',
        '-F', 'number=' + number,
        ...values,
    ];
}

/**
 * Maps a lookup response back to its repositories. A missing or inaccessible repository and a
 * missing number both read as not found; a response without data throws.
 */
export function parseLookupResponse(stdout, repositories) {
    const data = JSON.parse(stdout)?.data;
    if (!data || typeof data !== 'object')
        throw new Error('gh api graphql returned no lookup data');

    return repositories.map((repository, index) => {
        const node = data['r' + index]?.issueOrPullRequest;
        return {repository, found: Boolean(node), title: node?.title ?? null};
    });
}

/**
 * Classifies check runs and commit statuses into the buckets shown in the preview. Contexts
 * beyond the fetched page count as unloaded, so a partial rollup never reads as green.
 */
export function summarizeRollup(contexts, totalCount = contexts?.length ?? 0) {
    const summary = {
        total: 0,
        passed: 0,
        failed: 0,
        pending: 0,
        skipped: 0,
        unloaded: 0,
        failedNames: [],
    };
    for (const context of contexts ?? []) {
        let bucket;
        if (context?.__typename === 'StatusContext') {
            bucket = {
                SUCCESS: 'passed',
                FAILURE: 'failed',
                ERROR: 'failed',
            }[context.state] ?? 'pending';
        } else if (context?.status !== 'COMPLETED') {
            bucket = 'pending';
        } else {
            bucket = {
                SUCCESS: 'passed',
                FAILURE: 'failed',
                TIMED_OUT: 'failed',
                STARTUP_FAILURE: 'failed',
                ACTION_REQUIRED: 'failed',
            }[context.conclusion] ?? 'skipped';
        }

        summary.total++;
        summary[bucket]++;
        if (bucket === 'failed')
            summary.failedNames.push(context.name ?? context.context ?? 'Unnamed check');
    }
    summary.unloaded = Math.max(0, totalCount - summary.total);
    summary.total += summary.unloaded;
    return summary;
}

/**
 * Normalizes gh api graphql output. Returns null when the repository or number does not exist,
 * and throws when the output is not a usable GraphQL response.
 */
export function parsePreviewResponse(stdout) {
    const response = JSON.parse(stdout);
    const node = response?.data?.repository?.issueOrPullRequest;
    if (!node) {
        if (response?.errors?.some(error => error.type === 'NOT_FOUND'))
            return null;
        throw new Error('gh api graphql returned no issue or pull request');
    }

    const isPullRequest = node.__typename === 'PullRequest';
    let state = node.state === 'OPEN' ? 'open' : node.state === 'MERGED' ? 'merged' : 'closed';
    if (isPullRequest && state === 'open' && node.isDraft)
        state = 'draft';
    if (!isPullRequest && state === 'closed' && node.stateReason === 'COMPLETED')
        state = 'completed';

    const contexts = node.commits?.nodes?.[0]?.commit?.statusCheckRollup?.contexts;
    const checks = isPullRequest ? summarizeRollup(contexts?.nodes, contexts?.totalCount) : null;
    if (checks) {
        checks.hiddenFailedCount = Math.max(0, checks.failedNames.length - PREVIEW_FAILED_NAMES);
        checks.failedNames = checks.failedNames.slice(0, PREVIEW_FAILED_NAMES);
    }

    return {
        kind: isPullRequest ? 'pull-request' : 'issue',
        title: node.title ?? '',
        state,
        author: node.author?.login ?? null,
        headRefName: node.headRefName ?? null,
        baseRefName: node.baseRefName ?? null,
        additions: node.additions ?? 0,
        deletions: node.deletions ?? 0,
        comments: node.comments?.totalCount ?? 0,
        labels: (node.labels?.nodes ?? []).map(label => label.name),
        checks,
        body: node.body ?? '',
    };
}
