# BabysitPR — v0.1 specification

## Goal

Show check progress for the authenticated user's open pull requests in the GNOME top bar and send a desktop notification when a monitored pull request reaches a new green check run.

## Audience and environment

- Personal use on GNOME Shell 49.
- The local GitHub CLI (gh) must be installed and authenticated.
- BabysitPR follows the account and host selected by the active gh configuration.

## Main flow

1. Search for the 30 most recently updated open pull requests authored by the active account with gh search prs --author @me.
2. Read each pull request's checks with gh pr checks --repo HOST/OWNER/REPO.
3. Show the number of monitored pull requests in the panel and each pull request's status and check count in the menu.
4. Open a pull request in the browser when its menu row is selected.
5. Notify the desktop when an observed pull request reaches a new green check run.

## Statuses

- All checks passed: at least one check exists, every check passed or was skipped, and at least one check passed.
- Checks in progress: a check is pending, or gh returned an unrecognized check bucket.
- Checks failed: at least one check failed.
- Checks cancelled: at least one check was cancelled and none failed.
- Checks skipped: every check was skipped; this does not trigger a green notification.
- No checks: gh returned no check rows.
- Status unavailable: gh could not read the pull request's checks.

## Notifications

- The first complete refresh establishes a baseline and does not notify for pull requests that are already green.
- Later refreshes notify when a pull request becomes green.
- A compact fingerprint of check names, states, and timestamps prevents duplicate notifications on every refresh and detects a fresh run between polls.
- A failed check lookup does not overwrite that pull request's previous cached state.

## Settings and polling

- The polling interval is configurable in preferences: 30, 60, 120, 300, or 600 seconds.
- The default interval is 120 seconds.
- gh commands run sequentially. An in-progress refresh prevents a second refresh from starting.
- Each gh subprocess has a 30-second timeout.
- The pull request search is capped at the 30 most recently updated results.

## Security and privacy

- BabysitPR does not request or store a GitHub token.
- All GitHub reads use the local gh executable and its configured authentication.
- Commands are started with an argument vector and no shell.
- The extension only performs read operations and stores a small local status cache for notifications.

## Out of scope

- Pull requests the user contributes to but did not author.
- GitHub write actions, workflow reruns, merges, or review management.
- Token entry in the extension.
- GNOME Shell versions earlier than 49.

## Acceptance criteria

- The extension loads in GNOME Shell 49 and shows pull requests returned by gh.
- Failed, pending, successful, cancelled, skipped, and missing checks are distinguished.
- Pull requests open in the browser.
- A pull request already green during the first complete refresh does not trigger a notification.
- A later green transition triggers one notification for that observed check run.
- gh errors are visible without discarding the last known pull request state.
- The refresh interval persists across GNOME Shell restarts.
