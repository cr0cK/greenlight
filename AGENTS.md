# AGENTS.md

Guidance for AI agents working on Greenlight, a GNOME Shell 49 extension that monitors GitHub pull
requests through the `gh` CLI. Read CONTRIBUTING.md for the human workflow; this file holds what
the code does not tell you.

## Layout

Everything that ships lives in `src/`; `make check` packs it into the extension zip and picks up
new `src/*.js` modules on its own.

| Path | Role |
|---|---|
| `src/extension.js` | Panel indicator, refresh loop, notifications, menu, quick open, previews |
| `src/prefs.js` | Adwaita preferences window; every setting is applied by **Save preferences** |
| `src/filters.js` | Owner and repository filter storage |
| `src/quickopen.js` | Quick open parsing, fuzzy repository ranking, recent repositories (pure) |
| `src/preview.js` | GraphQL queries and check-rollup classification (pure) |
| `src/markdown.js` | GitHub-flavored Markdown to Pango markup blocks (pure) |
| `src/schemas/` | GSettings schema; settings live under `org.gnome.shell.extensions.greenlight` |
| `tests/` | `node --test` suites for the pure modules |
| `docs/specs/v*.md` | Product contracts, one per minor version |
| `scripts/sandbox.sh` | Windowed, isolated GNOME Shell running the checkout |
| `scripts/screenshots.sh` | Regenerates `docs/screenshots/` from fictional data served by `scripts/screenshots/gh` |

The pure modules import nothing from `gi://`, so `node --test` covers them. Keep new logic there
when it can live without GNOME APIs.

## Commands

```sh
npm ci && pre-commit install --install-hooks   # once
npm run lint                                   # ESLint
make check                                     # schema, parse, unit tests, zip in dist/
scripts/sandbox.sh                             # try it in a windowed GNOME Shell
```

`make check` and `npm run lint` must pass before you declare work done.

## Verify UI changes in a real GNOME Shell

Unit tests do not prove the menu works. For any user-visible change, run the extension in a
headless GNOME Shell and drive it, rather than asking the user to check:

- Launch `gnome-shell --headless --wayland --no-x11 --wayland-display=<short-name>
  --virtual-monitor 1280x800` inside `dbus-run-session`, with `XDG_DATA_HOME` and
  `XDG_CONFIG_HOME` pointing at a scratch directory and `GSETTINGS_BACKEND=keyfile`. Seed
  `org.gnome.shell enabled-extensions` in that keyfile, and never touch the user's dconf.
- The Wayland socket path must stay under 108 bytes, so keep the display name short and leave
  `XDG_RUNTIME_DIR` at its usual `/run/user/<uid>`.
- `gh` keeps its token in the desktop keyring, which a private D-Bus session cannot reach. Pass
  `GH_TOKEN=$(gh auth token)` and `GH_CONFIG_DIR=~/.config/gh`.
- `org.gnome.Shell.Eval` and `org.gnome.Shell.Screenshot` need unsafe mode. Enable it with a
  throwaway helper extension in the scratch directory whose `enable()` sets
  `global.context.unsafe_mode = true`. Never ship that helper.
- Reach the extension from Eval with
  `Main.extensionManager.lookup('greenlight@cr0ck.github.io').stateObj`.
- Drive input with a Clutter virtual device:
  - `notify_keyval` types characters, but keypad keys only work through `notify_key` with evdev
    codes (KP1 = 79).
  - `notify_button` takes Clutter button numbers (`Clutter.BUTTON_PRIMARY` = 1), not evdev codes.
  - Send pointer motion in its own step before clicking or scrolling, or the event lands on the
    old position.
- GNOME Shell caches extension modules. After editing code, restart the headless shell;
  disabling and re-enabling the extension keeps running the old code.
- Look at the screenshots, and grep the shell log for `JS ERROR` and `JS WARNING`.

`scripts/sandbox.sh` uses the mutter devkit instead. Do not pass `--virtual-monitor` there: the
devkit shows its own monitor, and the panel would land on an invisible one.

## GJS, St, and Clutter pitfalls already hit here

- `Gio.Cancellable.connect(callback)` is `g_cancellable_connect`, not a signal connect. Do not
  pass a signal name.
- `GSettings.delay()` is permanent: the object stays in delay-apply mode after `apply()`, and
  later writes through it are never saved. Never call `delay()` on the extension's settings
  object.
- The Shell theme has no `dim-label` class (it is GTK only). Dim text with `opacity`, as
  `createDimLabel` does.
- `St.Label` ellipsizes by default, which silently disables `line_wrap`. Use `wrapLabel()`.
- A `PopupBaseMenuItem` with `reactive: false` renders as insensitive (greyed). For a static
  block, use `{activate: false, hover: false, can_focus: false}`.
- `St.ScrollView` with `vfade` ignored `-st-vfade-offset` on the preview, so the preview has no
  fade.
- The menu is built once in `_buildMenu()` from persistent sections. Refreshes rebuild only the
  refresh and content sections, so text typed in quick open survives. Do not go back to
  `menu.removeAll()`.
- The pull request list scrolls because `_contentSection.actor` is swapped for an `St.ScrollView`
  before `addMenuItem`. The panel menu caps the height.
- The preview has a fixed height on purpose. With a variable height, retargeting a lower row
  could leave the pointer on a sibling row and retarget in a loop.
- Everything rendered with markup goes through `markdown.js`, which escapes text. Only http(s)
  links are clickable; keep it that way.

## gh calls

- Always pass argument arrays through `_runGh(args, cancellable)`, never a shell string.
- `_runGh` tracks concurrent processes, each with its own timeout. Cancelling the cancellable
  kills the process.
- GraphQL calls pass `--hostname github.com`, so an inherited `GH_HOST` cannot redirect them.
- `gh api graphql` exits with 1 when the response contains a `NOT_FOUND` error, but still prints
  the data. Parse stdout before trusting the exit code.
- Quick open makes no network call to open a number. GitHub redirects `/issues/<n>` to
  `/pull/<n>`.

## Versions, releases, and docs

- The UUID is `greenlight@cr0ck.github.io`. Never change it casually: changing it makes users
  reinstall.
- release-please owns `CHANGELOG.md`, `package.json` `version`, and `src/metadata.json`
  `version-name`. Do not edit them by hand. `metadata.json` must not get an integer `version`:
  extensions.gnome.org sets it.
- The repository is public: never put session links, local paths, or private organization and
  repository names in commits, PR texts, docs, or test fixtures.
- Commits and PR titles use Conventional Commits. PRs are squash-merged, so the PR title is the
  commit release-please reads. `feat` bumps the minor version, `fix` the patch, and breaking
  changes the major version. `docs`, `test`, `build`, `ci`, `chore`, and `style` are hidden
  changelog sections and never trigger a release.
- release-please runs as a GitHub App (`RELEASE_APP_CLIENT_ID` variable,
  `RELEASE_APP_PRIVATE_KEY` secret), not with GITHUB_TOKEN. GitHub holds `pull_request`
  workflows on PRs opened by GITHUB_TOKEN for manual approval, and checks dispatched on the
  release branch never attach to the PR, so do not switch back.
- The gitleaks pre-commit hook only scans staged changes. CI scans the full history with a
  checksum-pinned gitleaks binary; bump its version and SHA-256 together.
- A user-visible change updates README.md and the current `docs/specs/v*.md` in the same PR. When
  it changes the menu or the preferences window, run `scripts/screenshots.sh`, look at the new
  images, and commit them; extend `scripts/screenshots/gh` rather than capturing real data.
  Source, docs, and UI strings are in English.
- A defect found outside the task at hand becomes a GitHub issue with its reproduction, not a
  wider PR.
