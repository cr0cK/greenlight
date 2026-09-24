# BabysitPR v0.3 specification

## Goal

Make repository filtering practical for an organization with several repositories, make preference changes explicit and atomic from the user's perspective, and give the panel a recognizable pull request icon.

## Preferences

- The owner field accepts a GitHub organization or account name. It defaulted to the author's organization until v0.4 replaced it with owner discovery.
- **Load repositories** runs `gh repo list <owner>` with the existing local GitHub CLI authentication and displays accessible repositories as individual switches.
- A first repository load selects every listed repository. After a selection is saved, reloading preserves the saved selection for the same owner.
- The author filter accepts `@me`, a GitHub login, or an empty value for every author.
- The refresh interval remains configurable from 30 seconds through 10 minutes.
- **Save preferences** applies the owner, selected repositories, author, and interval together. A changed owner must be loaded before it can be saved.
- An unconfigured repository selection includes all open pull requests for the owner. A configured empty selection includes none.
- Existing single-repository settings migrate to the new owner and repository selection on extension startup.

## Pull request list

- Search open pull requests under the configured owner and apply author filtering through `gh search prs`.
- Filter search results to the selected repositories, sort newest update first, and display up to 30 rows.
- The owner-scoped search fetches at most the 1,000 most recently updated pull requests. The menu reports this cap when reached.
- Existing author, review, CI, failure, and notification behavior remains in place.

## Panel icon

- The panel uses a bundled neutral pull request symbol that remains unchanged as CI status changes.
- The adjacent `PR` count and the pull request rows continue to communicate monitoring and CI status.

## Verification

- `make check` validates the GSettings schema, checks both JavaScript modules, and packages the extension.
- Repository discovery must return JSON repository names and handle CLI, authentication, and response errors without displaying raw command output.
