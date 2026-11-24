---
code: CAG
status: draft
version: v1.6
created: 2026-11-24
builds-on: QTA
tracking: "#61"
---

# Greenlight — CAG specification

CAG lets the user add their own agent commands to the agent quotas: a command that runs Claude
Code, Codex, or Antigravity under another name, such as a wrapper that keeps its own sign-in on
another subscription. The user types the command and picks its quota type, and Greenlight reads
that command's quota exactly as it reads the agent of that type, shows it in the menu after the
built-in agents, and notifies its thresholds. Several custom agents can be added. It builds on
QTA and TAB, whose rules all still apply: QTA's availability, menu, notification, and CLI rules
apply to a custom agent as to the built-in agent of its type, with the differences below. It
amends QTA's **Agent quotas** preferences (a **Custom agents** group on TAB's **Agents** tab), its
provider order in the menu, its unavailability messages (which name the custom command), and its
storage (the `custom-agents` key); CAG-P1 rewrites those QTA lines. The mockup is
[`mockups/CAG.html`](mockups/CAG.html).

## Custom agents

- A custom agent is a **command** and a **quota type**: **Claude**, **Codex**, or
  **Antigravity**. Its **name**, in the menu, the preferences, and the notifications, is the
  command's last path component (`claude-work`, or `codex-team` for `~/bin/codex-team`).
- A command is either a name, made of letters, digits, `.`, `_`, `+`, and `-`, found as QTA finds
  the built-in CLIs (in `PATH`, then in `~/.local/bin`), or a path that starts with `/` or `~/`
  (`~/` is the home directory) to an executable file.
- The user can add any number of custom agents, up to 10. They keep the order they were added
  in.
- Two custom agents cannot share a command, compared as typed after trimming; nor a name, so
  the menu and notifications tell them apart. A custom agent cannot use the command of a
  built-in agent of the same type (`claude` with **Claude**, `codex` with **Codex**, `agy` with
  **Antigravity**): that one is the built-in switch.
- Each custom agent has its own enabled switch, like a built-in provider. A new one is enabled.

## Preferences

- TAB's **Agents** tab holds, after QTA's **Agent quotas** group, a **Custom agents** group
  described `Another command that runs Claude Code, Codex, or Antigravity, such as a wrapper on
  another subscription. Greenlight reads its quota the way it reads that agent's.`
  (PREFS-EMPTY)
- The group's header holds a **+** button (`list-add-symbolic`, accessible name and tooltip
  `Add a custom agent`). With 10 custom agents, it is insensitive and its tooltip reads
  `10 custom agents at most`. (PREFS-FULL)
- Without any custom agent, the group shows one row: `No custom agent. Add one with +.`
  (PREFS-EMPTY)
- The group lists the custom agents, one row each: the title is the name, the subtitle
  `<type> quota · <availability>`, a trash button (`user-trash-symbolic`, accessible name
  `Remove <name>`), then the switch. The availability text and the switch follow QTA's
  availability rules for the agent's type: `Checking…` while its check runs, `Uses <path>` when
  available, the unavailability message otherwise (switch off and locked),
  `Could not check: <cause>. Reopen Preferences to try again.` on a failed check. (PREFS-LIST,
  PREFS-CHECKING, PREFS-UNAVAILABLE)
- **+** adds a new row at the end of the list, which takes the focus: an entry (placeholder
  `claude-work or ~/bin/codex-team`), the subtitle `Type a command, pick its quota type, then
  press Enter`, a **Quota type** drop-down (**Claude**, **Codex**, **Antigravity**; **Claude** by
  default), and a trash button (`Cancel`) that drops the row. Only one new row exists at a time:
  **+** is insensitive while it does. (PREFS-NEW, PREFS-TYPED)
- Enter in the entry checks the command without running it. An accepted command turns the new
  row into a custom agent row, enabled, whose availability check starts at once. A refused one
  keeps the row, marks the entry, and shows the reason under it until the entry changes:
  - `Enter a command name or a path.` for a command of another form;
  - `<command> not found in PATH or ~/.local/bin` for a name, `<path> is not an executable file`
    for a path; (PREFS-NOT-FOUND)
  - `<command> is already listed.`, `<name> is already listed.` for a name clash, or
    `<command> is the built-in <type> agent.`. (PREFS-DUPLICATE)
- A new row not yet accepted is not a setting: it makes no tab unsaved, a save ignores it, and
  closing the window drops it.
- A custom agent's trash button removes its row at once; like every change of the tab, it
  applies on save. (PREFS-REMOVED)
- Under TAB, the custom agents are settings of the **Agents** tab: the list (commands, types,
  order) and each switch compare with their baseline as TAB says, so an addition, a removal, or a
  switch makes **Agents** unsaved, and removing an agent just added brings it back to its
  baseline. A check that turns a custom agent's switch off is a pending normalization, as for a
  built-in provider. A save stores the list.
- Closing the window cancels the custom agents' checks, as QTA's.

## Menu and notifications

- In the **Agent quotas** section, custom agents follow the built-in ones (Claude, Codex,
  Antigravity), in the order of the list. Each one's name takes its own line above its windows,
  as Antigravity's does. Its windows, labels, slots, colors, pace mark, dimming, causes, and
  `Updated` line follow QTA for its type. (MENU)
- A custom agent is a provider of its own: its reading, its refresh in flight, its last try, and
  its notified periods are its own, under the identifier `custom:<command>`. Two custom agents of
  the same type, or a custom agent and the built-in one of its type, read and notify separately.
- Notifications name it: `claude-work weekly quota at 84 %` / `Resets Mon 10:00`, with QTA's
  window names. (NOTIF)
- Removing a custom agent, or switching it off, forgets its reading and its marked periods, as
  switching a built-in provider off does. Adding one, or switching it on, reads it, and its first
  reading sets QTA's quiet baseline.

## Running a custom agent

- Greenlight runs the custom command where QTA runs the built-in CLI of its type, with the same
  arguments, the same timeouts, the same parsing, and the same rules: `-p /usage
  --no-session-persistence --output-format json --settings {"disableAllHooks":true}` for
  **Claude**, `app-server` and its three messages for **Codex**, `-p /usage --output-format json`
  with the no-op `xdg-open` first in `PATH` for **Antigravity**.
- The command runs from the home directory, with its own directory first in `PATH`, as QTA runs
  the built-in CLIs. Greenlight passes it no other environment: a wrapper that sets its own
  configuration directory keeps doing so.
- A command found when it was added and missing later is unavailable with the not-found message
  of **Preferences**, in the preferences and in the menu (hidden, as QTA says).
- QTA's unavailability messages name the custom command where they name the built-in one:
  `Claude Code is not signed in with a Claude subscription. Run claude-work, then /login.`,
  `Codex is not signed in. Run codex-team login.`, `This codex-team cannot report rate limits.
  Update Codex.`, `Codex reports no subscription quota. Sign in with ChatGPT: codex-team login.`,
  `Antigravity is not signed in. Run agy-alt and sign in.`, and
  `Antigravity answered /usage in an unknown form. Update agy-alt.`; the others are unchanged.

## Storage

- A new setting, `custom-agents` (JSON, `[]` by default): a list of
  `{command, type, enabled}`, `type` being `claude`, `codex`, or `agy`, in list order. Malformed
  JSON reads as no custom agent; an entry with an unknown type, an invalid command, or a
  duplicate command or name is skipped; entries past the tenth are skipped.
- `agent-quota-cache` keeps a custom agent's reading and periods under `custom:<command>`, like
  a built-in provider's; an entry whose agent is no longer listed or enabled is dropped when the
  extension loads the cache.

## Out of scope

- Agents of another type than Claude Code, Codex, and Antigravity, and quota commands of the
  user's own design.
- Arguments or environment variables entered in the preferences: a command that needs them is a
  wrapper script.
- Renaming a custom agent, or reordering the list: remove it and add it again.

## Plans

### CAG-P1: custom agents

- **Depends on**: TAB merged, since the group sits on TAB's **Agents** tab and its changes follow
  TAB's save.
- **Scope**: the whole spec. The QTA lines CAG amends are rewritten, with `v1.6` in `amended`.
  README.md describes custom agents.
- **Acceptance**:
  - Unit tests (`node --test`): the command forms (names, `/` and `~/` paths, refused forms), the
    name from a path, the clash rules (command, name, built-in), the limit, the storage reader
    (malformed JSON, unknown type, duplicates, eleventh entry), the custom provider identifier,
    the messages with a custom command, and the menu order of built-in then custom providers.
  - In the headless GNOME Shell, with fixture CLIs from `scripts/screenshots/` copied under other
    names in a scratch `~/.local/bin` (a Claude-type `claude-work`, a Codex-type `codex-team`,
    and a signed-out Claude-type one): adding each through the **Agents** tab shows `Checking…`,
    then `Uses <path>` or the signed-out message with the switch locked off; a missing command, a
    duplicate, and the built-in `claude` with **Claude** are refused with their messages; a save
    stores `custom-agents`; the menu lists `claude-work` and `codex-team` after the built-in
    agents, each on its own name line, with their own windows; a threshold crossed by
    `claude-work` notifies `claude-work … quota at …`; removing it and saving drops its lines and
    its cache entry. Screenshots, and no `JS ERROR` or `JS WARNING` in the log.
  - `scripts/screenshots.sh` shows one custom agent in `menu.png` and in
    `preferences-agents.png`.
  - `npm run lint` and `make check` pass.
- **Technical notes**:
  - `PROVIDERS` in `src/quotas.js` holds the built-in agents with a fixed `command` and `setting`;
    a custom agent is a provider built from its entry, `{name, command, type}`, whose reader is
    its type's (`readClaude`, `readCodex`, `readAgy` in `src/agents.js`, which already take the
    found path). `readQuota`, the quota state, the cache, and the menu loop over the built-in and
    the custom providers instead of `PROVIDERS` alone.
  - `findCli` takes a name; a path is expanded (`~/`) and checked with `GLib.file_test`
    (`IS_EXECUTABLE`, not `IS_DIR`).
  - The messages that name a command become functions of it in `src/quotas.js`, so the built-in
    texts stay as QTA lists them.
  - The schema gains `custom-agents` (`s`, default `'[]'`).
