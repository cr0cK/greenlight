---
code: PRM
status: done
version: v0.1
amended: [v0.2, v0.3, v0.4, v1.2]
created: 2026-10-11
---

# Greenlight — PRM specification

PRM covers the pull request monitor at the core of Greenlight, a GNOME Shell extension: the
panel indicator, the owners and repositories it watches, the searches it runs through the `gh`
CLI, the pull request list in the menu, check statuses, green-run notifications, the
preferences that choose what to watch, and how failures are reported. It predates the spec
delivery process, so it has no plans. It gathers the rules of the former v0.1 to v0.4
specifications and the parts of v1.2 on labels, owners, and errors, as the product stands.

## Environment

- GNOME Shell 49 or 50. Earlier versions are out of scope.
- The GitHub CLI (`gh`) must be installed and authenticated. Searches and check reads follow the
  account and host of the active `gh` configuration. GraphQL requests (the owner check below,
  and QOP's lookups and previews) pass `--hostname github.com`, so an inherited `GH_HOST` cannot
  redirect them.
- Greenlight never requests or stores a GitHub token. Every GitHub read goes through the local
  `gh` executable, started with an argument array and no shell.
- Greenlight only reads from GitHub. Writes (merges, reruns, reviews) are out of scope.

## Panel indicator

- The panel shows a neutral pull request symbol, which never changes with CI status, and
  `PR <n>`, the number of listed pull requests, up to 30. After a failed refresh it shows `PR !`.

## What is watched

- `owner-filters` holds the watched owners, each with its login, its kind (personal account,
  organization, or unknown owner), an enabled flag, and a repository scope:
  - **All**: `repositories` is null and `excludedRepositories` empty; every repository,
    including new ones.
  - **All except…**: `repositories` is null and `excludedRepositories` lists the skipped ones;
    new repositories are watched.
  - **Only…**: `repositories` lists the watched ones; new repositories are skipped. An empty list
    watches nothing.
- Names compare case-insensitively and keep their case for display. A saved repository that does
  not belong to its owner is ignored. Duplicate owners merge into the wider scope; a paused
  duplicate never widens an enabled one. An owner without `excludedRepositories` has no
  exclusions. Otherwise malformed settings read as no owners.
- Until `owner-filters-configured` is set, Greenlight searches every repository visible to `gh`.
  Once it is set, only enabled owners and their scopes are searched, and an empty configuration
  watches nothing.
- `author-filter` defaults to `@me`, accepts a GitHub login, and empty includes every author.

## Refresh

- A refresh runs at start, every `refresh-interval` seconds (30, 60, 120, 300, or 600; 120 by
  default), from **Refresh now**, and 600 ms after a filter setting changes, so one save triggers
  one refresh. A refresh never starts while another runs; a filter change during one queues
  another. Results of a refresh whose filters changed meanwhile are dropped.
- Each `gh` process has its own 30-second timeout, after which it is killed.
- Before searching, one `gh api graphql` request checks that every enabled owner
  (`repositoryOwner`) and every repository of an **Only…** scope (`repository`) still exists for
  `gh`. Missing ones are left out of the search and listed in a warning row under
  **Refresh now**; an owner left with no repository is skipped. `gh api graphql` exits with 1 on
  `NOT_FOUND` but still prints the data, which is read first.

## Searches

- Pull requests come from `gh search prs` with `--state open`, `--archived=false`, `--sort
  updated --order desc`, the author filter, and `--json
  number,title,url,repository,author,isDraft,updatedAt,labels`.
- Owners in **All** go in `--owner` qualifiers, **Only…** repositories in `--repo` qualifiers,
  never mixed in one command. Qualifiers are chunked to at most 16 per query and a 220-character
  query, then results are merged and deduplicated by repository and number.
- An owner in **All except…** gets its own command with `-repo:owner/name` terms after `--`,
  within the same bounds. Exclusions that do not fit are filtered on the client; because that can
  shorten a full page, the search runs again with a limit four times larger, up to 1000, until
  the owner yields its share of the 30 most recent pull requests.
- The combined results are sorted by `updatedAt`, newest first, and the 30 most recent are kept.
  When more exist, or a search hit its cap, the list ends with `Showing the 30 most recently
  updated pull requests across owners.`
- Checks are read sequentially for those 30 with `gh pr checks <n> --repo <host/owner/repo>
  --json bucket,name,workflow,state,completedAt,startedAt,link`; exit code 8 (pending checks)
  counts as success.

## Check statuses

- From the check buckets: **Checks failed** when one failed; else **Checks in progress** when one
  is pending or in an unknown bucket; else **Checks cancelled** when one was cancelled; else
  **Checks green** when at least one passed (skipped checks do not block); else **Checks
  skipped** when every check was skipped; **No checks** when there is none; **Checks
  unavailable** when `gh` could not read them.
- A pull request without checks, or with only skipped checks, is never green.

## Menu

- From top to bottom: **Refresh now** (reading `Refreshing…` while a refresh runs), its error
  and warning rows, quick open (QOP), the pull request list, and **Preferences…**.
- The list groups pull requests under `<owner> · <n> pull request(s)` headings, ordered by each
  owner's newest pull request, and sorts each group by last update. Only the list scrolls; the
  panel menu caps its height.
- Each row has a status icon, then:
  - first line: the `#number` badge, up to three labels in their GitHub color (text dark on light
    colors, white on dark ones, the number badge color when a label has no valid color), a `+N`
    badge whose accessible name lists the others, the title, the `CI <passed>/<total>` badge in
    the status color, and an open icon. Long label names ellipsize.
  - second line: the repository, the author, a **Draft** or **Ready for review** badge, and
    colored counts of failed, pending, skipped, cancelled, and unknown checks.
- Selecting the open icon opens the pull request in the browser (QOP covers the row's preview).
- Empty states: `Loading open pull requests…` during the first refresh;
  `No active owners or repositories. Open Preferences to choose what to monitor.` when the
  configuration watches nothing; `No previous state available.` after a failed first refresh;
  otherwise `No open pull requests match the selected owners and author.`

## Notifications

- A notification says `<repo> #<n> is all green: <title>` when a pull request becomes green, or
  turns green again on a new check run.
- A fingerprint of each check's name, workflow, bucket, state, and start and completion times
  tells a new run from the same one, so a run notifies once.
- The first complete refresh, and the first one after the owners, repositories, or author
  change, set a quiet baseline: nothing already green notifies. A baseline waits for a refresh
  where every check read succeeded.
- A failed check read keeps that pull request's previous cached state.

## Preferences

- **Monitoring** holds **Author** (an entry, `@me or username`) and **Refresh interval** (30
  seconds to 10 minutes).
- **Accounts and organizations** holds **Discover accounts** (`gh api user` and `gh api
  user/orgs --paginate`: the gh account and its organizations) and **Add an owner**. **Add**
  checks the login with `gh api users/<login>` and takes its kind from the answer; an unknown
  login is refused with a message, other failures explain the `gh` problem. A status row counts
  the owners and the enabled ones.
- Each owner gets its own block, titled with its login and described as
  `<kind> · Monitoring|Paused · <scope>`, the scope reading `All repositories`,
  `All except N repositories`, or `N selected repositories`. Its header has a trash icon that
  removes the owner and a switch that pauses it. A paused owner's rows are greyed out.
- A block has three steps:
  1. **Repositories**, with **Discover**: runs `gh repo list` for that owner only, on demand.
  2. **Monitor**: **All**, **All except…**, or **Only…**. It shows the saved mode and can only
     change once the repositories are discovered, so a selection is never converted without its
     list.
  3. A collapsible `M of N monitored` list with a filter and one switch per repository, shown
     for **All except…** and **Only…**. It opens when the mode changes to one of them. Saved
     repositories `gh` no longer lists stay in it.
- A repository switch on always means monitored. Changing between **All except…** and **Only…**
  keeps every switch; only the rule for new repositories changes. Leaving **All** turns every
  switch on.
- A block refreshes in place after **Discover**, so the page keeps its scroll position. An added
  owner's block comes first; owners found by **Discover accounts** come last, paused unless they
  are the first ones configured. Only one `gh` task runs at a time; its buttons and **Save
  preferences** are insensitive meanwhile, and closing the window cancels it.
- **Save preferences** applies every setting of the window together and closes it. Nothing
  applies before.

## Errors

- A failed refresh shows an error row under **Refresh now** that names the cause: `gh` missing
  from `PATH`, `gh` not signed in (exit code 4: `gh auth login`), GitHub unreachable, the rate
  limit, or `gh`'s own first error line. The last pull requests stay listed, and the
  notification cache is left unchanged, so recovery notifies nothing twice.
- For the sign-in, network, and rate-limit causes, a dimmed line under the row quotes `gh`'s first
  error line, so a primary rate limit can be told from a secondary one. The shell log line for
  the failure carries it too.

## Out of scope

- Pull requests the user contributes to without authoring them, unless the author filter is
  cleared.
- Token entry, GitHub writes, and GitHub Enterprise hosts for the GraphQL requests.
