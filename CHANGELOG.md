# Changelog

All notable changes to Greenlight are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), versions follow
[Semantic Versioning](https://semver.org/spec/v2.0.0.html), and release-please writes new
entries from [Conventional Commits](https://www.conventionalcommits.org/en/v1.0.0/).

## [1.0.2](https://github.com/cr0cK/greenlight/compare/v1.0.1...v1.0.2) (2026-10-11)


### Changed

* drop dead code ahead of the extensions.gnome.org review ([#11](https://github.com/cr0cK/greenlight/issues/11)) ([a1790fa](https://github.com/cr0cK/greenlight/commit/a1790fadbc164a4d9463d2611a707bc69d71603e))

## [1.0.1](https://github.com/cr0cK/greenlight/compare/v1.0.0...v1.0.1) (2026-10-11)


### Fixed

* dim the repository and author on pull request rows ([#6](https://github.com/cr0cK/greenlight/issues/6)) ([b425700](https://github.com/cr0cK/greenlight/commit/b425700938172248d6c4e4d581947548e3ba99f9))

## [1.0.0](https://github.com/cr0cK/greenlight/releases/tag/v1.0.0) (2026-10-10)

First public release. BabysitPR is now Greenlight.

### Changed

- The extension is named Greenlight, with the UUID `greenlight@cr0ck.github.io` and the GSettings
  schema `org.gnome.shell.extensions.greenlight`. Preferences from pre-release BabysitPR builds
  are not migrated.
- Released under the MIT license, with release-please managing versions and this changelog.

## Pre-release history (BabysitPR)

## 0.5.0 (2026-10-10)

### Added

- Quick open field in the menu to open an issue or pull request of a watched repository by
  number, with a configurable keyboard shortcut (Super+Shift+G by default). With a number, it
  lists only the repositories where that issue or pull request exists.
- Inline preview of the highlighted issue or pull request: state, author, branches, a CI bar with
  failed check names, and its description rendered as GitHub-flavored Markdown. The preview
  scrolls, opens the issue or pull request on click, and opens links clicked inside it.
- Hover previews for listed pull requests, after a configurable delay (1.5 seconds by default,
  0 to disable).

### Changed

- The pull request list scrolls inside the menu, so long lists no longer run off the screen.
- gh calls can run concurrently, each with its own timeout, so previews never interrupt a refresh.

### Fixed

- Pull requests from archived repositories are excluded from every search scope.
- Migrating v0.2 or v0.3 settings no longer leaves the settings object in delay-apply mode,
  which silently dropped every later write (notification cache, quick open history) on reload.

## 0.4.0 (2026-09-24)

### Added

- Discovery for the authenticated GitHub account and its organization memberships, with manual
  public-owner entry.
- Independent all-repository or selected-repository scopes for each enabled owner.
- Pull request sections grouped by owner, with compact review and CI badges.

### Changed

- Owners and selected repositories are queried in separate bounded `gh search prs` commands,
  then merged into the newest 30 results.
- Search scopes are no longer tied to a single organization or repository.

## 0.3.0 (2026-09-24)

### Added

- Multi-select repository filtering populated with `gh repo list` for a configurable organization
  or account.
- A single Save preferences button for repository, author, and refresh settings.
- A bundled neutral pull request icon in the GNOME panel.

### Changed

- Repository and author filters apply together when preferences are saved.
- Repository searches inspect up to the 1,000 most recently updated open pull requests for the
  selected owner.

## 0.2.0 (2026-09-24)

### Added

- Author filtering, newest-first sorting, and per-PR author, review, and CI summaries.

## 0.1.0 (2026-09-23)

### Added

- Initial GNOME Shell extension for monitoring authored open pull requests.
- Panel menu with check status, check count, and browser links.
- Desktop notifications for new green check runs.
- Configurable refresh interval and local notification-state cache.
