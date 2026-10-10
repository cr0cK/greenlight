# Contributing

Thanks for helping improve BabysitPR. By participating, you agree to follow the
[Code of Conduct](CODE_OF_CONDUCT.md).

## Development setup

You need GNOME Shell 49, the GitHub CLI (`gh`), GLib schema tools, Node.js 24, and
[pre-commit](https://pre-commit.com). Node.js is only used for development; the extension does
not need it at runtime.

~~~sh
npm ci                                # ESLint and its plugins
pre-commit install --install-hooks    # pre-commit and commit-msg hooks
~~~

## Checks

~~~sh
npm run lint    # ESLint
make check      # GSettings schema, module parsing, unit tests, extension bundle in dist/
~~~

The hooks run ESLint, the unit tests, schema validation, gitleaks, typos, and file hygiene on
each commit, and check the commit message format. CI runs the same checks on every pull request.
Do not commit `dist/`.

## Trying a change

To run the current checkout without touching your desktop session, use the windowed GNOME Shell
sandbox (it requires `mutter-devel` for the devkit):

~~~sh
scripts/sandbox.sh          # rebuilds, then opens the sandbox window
scripts/sandbox.sh --reset  # same, from fresh settings
~~~

The sandbox keeps its extensions and settings in ~/.cache/babysitpr-sandbox (override with
BABYSITPR_SANDBOX) on a private D-Bus session. The devkit window starts with a 1280x800 screen
and can take about 30 seconds to appear the first time. The sandbox copies the desktop's Num Lock
state on each run. Preferences persist between runs. Close the window and run the script again
after a code change.

## Code and documentation style

- Follow .editorconfig and the ESLint rules, which match the GNOME Shell code style.
- Keep source comments, documentation, metadata, and user-facing strings in English.
- Use GNOME Shell ES modules and GSettings for extension preferences.
- Keep subprocess calls as argument arrays; do not pass user or repository data through a shell.
- Do not add or store GitHub credentials. Use the user's existing gh authentication.
- Update README.md and the relevant docs/spec-v*.md when a change affects the user-visible
  contract.

## Commits and pull requests

Use [Conventional Commits](https://www.conventionalcommits.org/en/v1.0.0/) with an English
summary:

~~~text
<type>(<scope>): <summary>
~~~

Types are feat, fix, docs, style, refactor, perf, test, build, ci, chore, and revert; the scope
is optional. Pull requests are squash-merged, so the PR title becomes the commit subject and must
follow the same format.

## Releases

Releases are automated with [release-please](https://github.com/googleapis/release-please).
Every merge to `main` updates a release pull request that bumps `package.json`, the
`version-name` in `metadata.json`, and CHANGELOG.md from the commit history: `feat` bumps the
minor version, `fix` the patch, and breaking changes the minor version until 1.0. Do not edit
CHANGELOG.md by hand. Merging the release pull request tags `vX.Y.Z`, publishes a GitHub Release,
and attaches the installable extension zip. The integer `version` field of metadata.json is left
to extensions.gnome.org.
