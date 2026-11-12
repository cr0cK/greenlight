# Specs

The specs of this repository, one file per spec code, follow the **spec delivery process** of the
`sdp` Claude Code plugin: `sdp:spec` designs a spec and its plans, `sdp:approve` gates them and
arbitrates the outbox, and `sdp:exec` implements the approved plans as stacked PRs. Each spec's
delivery is recorded as stamps in its tracking issue.

Each spec describes one topic as the product stands. A later spec that changes an earlier one's
rules lists its version in the earlier one's `amended`. Mockups are in [`mockups/`](mockups/).

## Project settings

- **Owner**: `cr0cK`.
- **Releases**: release-please opens the release PR from Conventional Commits; each spec ships in
  one minor version, and its `version` is that series, vX.Y.
- **Commits and PR titles**: Conventional Commits, squash-merged, so the PR title is the commit
  release-please reads. A spec PR is `docs:`, a plan PR is usually `feat:`.
- **Checks**: `npm run lint` and `make check`. A user-visible change is verified in a headless
  GNOME Shell as AGENTS.md describes, with screenshots and the shell log free of `JS ERROR`. A
  change to the menu or the preferences window regenerates `docs/screenshots/` with
  `scripts/screenshots.sh`.
- **Reviewers**: Codex read-only (`codex exec --sandbox read-only ... < /dev/null`), then Gemini
  through `agy` (`command agy -p ... --model gemini-4-argon-high --mode plan --sandbox <
  /dev/null`), then a fresh-context agent.

## Specs

- [`PRM`](PRM.md) (2026-10-11): the pull request monitor: panel indicator, watched owners and
  repositories, searches, check statuses, the menu list, green-run notifications, preferences,
  and errors. Predates the process.
- [`QOP`](QOP.md) (2026-10-11): quick open, its keyboard shortcut, and issue and pull request
  previews. Predates the process.
- [`ABT`](ABT.md) (2026-10-12): the **About** group with the installed version. Predates the
  process.
- [`QTA`](QTA.md) (2026-11-12): Claude, Codex, and Antigravity subscription quota gauges in the
  menu; tracking issue #36.
