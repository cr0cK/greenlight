# Changelog

All notable changes to BabysitPR are documented here.

## [Unreleased]

### Added

- Discovery for the authenticated GitHub account and its organization memberships, with manual public-owner entry.
- Independent all-repository or selected-repository scopes for each enabled owner.
- Pull request sections grouped by owner, with compact review and CI badges.

### Changed

- Pull requests from archived repositories are excluded from every search scope.
- Owners and selected repositories are queried in separate bounded `gh search prs` commands, then merged into the newest 30 results.
- Search scopes are no longer tied to a single organization or repository.

## [0.3.0]

### Added

- Multi-select repository filtering populated with `gh repo list` for a configurable organization or account.
- A single Save preferences button for repository, author, and refresh settings.
- A bundled neutral pull request icon in the GNOME panel.

### Changed

- Repository and author filters apply together when preferences are saved.
- Repository searches inspect up to the 1,000 most recently updated open pull requests for the selected owner.

## [0.2.0]

### Added

- Author filtering, newest-first sorting, and per-PR author, review, and CI summaries.

## [0.1.0]

### Added

- Initial GNOME Shell extension for monitoring authored open pull requests.
- Panel menu with check status, check count, and browser links.
- Desktop notifications for new green check runs.
- Configurable refresh interval and local notification-state cache.
