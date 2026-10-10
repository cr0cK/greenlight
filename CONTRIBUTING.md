# Contributing

## Development setup

Use GNOME Shell 49, the GitHub CLI (gh), GLib schema tools, Node.js, and the GNOME extension tooling.

Run the repository checks before proposing a change:

~~~sh
make check
~~~

The check validates the GSettings schema, parses all JavaScript modules, runs the unit tests in tests/, and packages the extension. Do not include generated dist/ files in commits.

To try the current checkout without touching your desktop session, run it in a windowed GNOME Shell (requires mutter-devel for the devkit):

~~~sh
scripts/sandbox.sh          # rebuilds, then opens the sandbox window
scripts/sandbox.sh --reset  # same, from fresh settings
~~~

The sandbox keeps its extensions and settings in ~/.cache/babysitpr-sandbox (override with BABYSITPR_SANDBOX) on a private D-Bus session. The devkit window starts with a 1280x800 screen and can take about 30 seconds to appear the first time. The sandbox copies the desktop's Num Lock state on each run. Preferences persist between runs. Close the window and run the script again after a code change.

## Code and documentation style

- Follow .editorconfig for indentation and line endings.
- Keep source comments, documentation, metadata, and user-facing strings in English.
- Use GNOME Shell ES modules and GSettings for extension preferences.
- Keep subprocess calls as argument arrays; do not pass user or repository data through a shell.
- Do not add or store GitHub credentials. Use the user's existing gh authentication.
- Update CHANGELOG.md and the relevant docs/spec-v*.md when a change affects the user-visible contract.

## Commit messages

Use Conventional Commits with an English summary:

~~~text
<type>(<scope>): <summary>
~~~

Common types include feat, fix, docs, refactor, test, and chore. The scope is optional. Examples:

~~~text
feat: add configurable refresh interval
fix: avoid duplicate green notifications
docs: clarify first-refresh behavior
~~~
