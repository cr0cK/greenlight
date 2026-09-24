# BabysitPR — v0.2 specification

## Goal

Make the open pull request monitor configurable and show enough review and CI detail to spot failures without opening GitHub.

## Filters

- The repository filter accepts one owner/repository value for the active gh host.
- An empty repository filter includes all repositories visible to gh.
- The author filter defaults to @me and accepts a GitHub login.
- An empty author filter includes pull requests by every author.
- Applying changed filters performs one refresh and establishes a quiet notification baseline.

## Pull request list

- Show at most the 30 most recently updated open pull requests.
- Order results by updatedAt, newest first.
- Show the repository and pull request number, title, author, and Draft or Ready for review status.
- Show passed checks divided by total checks, plus failure, pending, skipped, and cancelled counts.
- Open a pull request in the browser when its row is selected.

## Check status and notifications

- A pull request is green when it has at least one passed check and all remaining checks passed or were skipped.
- Any failed check makes the pull request fail; pending checks keep it in progress.
- No checks, cancelled checks, unknown check buckets, and check read errors are distinct states.
- A complete first refresh, or a refresh after filter changes, establishes a baseline without sending notifications.
- Later transitions to green notify once for each changed check-run fingerprint.

## Settings

- Repository and author filters are applied together from Preferences.
- The refresh interval remains configurable from 30 to 600 seconds, with a 120-second default.
- Filter changes are debounced so one apply action triggers one refresh.

## Acceptance criteria

- A broken URL parser no longer hides the repository or prevents checks from loading.
- Filters constrain results through gh search prs arguments without invoking a shell.
- Pull requests appear in newest-first order and display author, draft/review status, passed/total checks, and failures.
- Changing filters does not produce startup notifications for already-green pull requests.
- Existing green-transition notifications continue to work for the selected filter.
