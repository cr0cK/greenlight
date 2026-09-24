# BabysitPR v0.4 specification

## Goal

Monitor open pull requests across multiple GitHub accounts and organizations, keep repository choices manageable per owner, and make the menu easy to scan.

## Owner discovery and selection

- **Discover** reads the authenticated login with `gh api user` and organization memberships with `gh api user/orgs --paginate`.
- Discovered owners include the authenticated personal account and each organization membership. First discovery enables the returned owners by default; later discoveries preserve existing choices and leave newly found owners disabled.
- Users can add any public organization or account manually, including owners outside their organization memberships.
- Each owner has an independent enabled switch and repository mode.
- **All repositories** includes current and future repositories for that owner. Custom mode lists accessible repositories from `gh repo list <owner>` and stores checked repositories. An intentionally empty custom selection includes no repositories.
- The author filter remains `@me` by default; an empty value includes every author.
- **Save preferences** applies owner scopes, per-owner repositories, author, and refresh interval together.
- Before owner filters are configured, the extension preserves the broad `gh` search behavior across all accessible repositories.

## Pull request searches

- Search open PRs from enabled all-repository owners and selected repository names through `gh search prs`.
- Keep owner qualifiers separate from repository qualifiers. Chunk qualifiers to stay within GitHub search limits, then merge and deduplicate results by repository and PR number.
- Sort the combined results by `updatedAt` and read CI details sequentially for the 30 most recently updated PRs.
- A failed search keeps the previous complete snapshot and notification cache.
- Existing check summaries and green-run notifications remain in effect.

## Menu and visual hierarchy

- Group PRs under account or organization headings, ordered by each owner's newest PR.
- Sort rows within each owner section by last update.
- Each row puts the PR number, title, and CI status badge on the first line.
- The second line shows the repository, author, review state, and colored counts for failures, pending checks, skipped checks, cancellations, or unknown checks.
- Retain native GNOME menu behavior, theme, keyboard navigation, and the neutral panel icon.

## Migration and verification

- Migrate v0.2 single-repository and v0.3 owner/repository settings to the new multi-owner configuration without replacing a valid v0.4 selection.
- Update metadata to version 4 / `0.4.0`, README, and CHANGELOG.
- `make check` validates the GSettings schema, parses every JavaScript module, and packages the icon and helper module into the extension bundle.
