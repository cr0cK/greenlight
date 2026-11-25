---
code: CAG
status: active
version: v1.5
created: 2026-11-24
builds-on: QTA, TAB
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
amends QTA's **Agent quotas** preferences (a **Custom agents** group), its provider order, its
unavailability messages (which name the custom command), its menu row padding, its `PATH`
rule, and its storage (the
`custom-agents` key and the cache keys); and TAB's list of the **Agents** settings. CAG-P1
rewrites those lines. The mockup is [`mockups/CAG.html`](mockups/CAG.html).

## Custom agents

- A custom agent is a **command** and a **quota type**: **Claude**, **Codex**, or
  **Antigravity**. Its **name**, in the menu, the preferences, and the notifications, is the
  command's last path component (`claude-work`, or `codex-team` for `~/bin/codex-team`).
- A command is either a name, made of letters, digits, `.`, `_`, `+`, and `-`, found as QTA finds
  the built-in CLIs (in `PATH`, then in `~/.local/bin`), or a path that starts with `/` or `~/`
  (`~/` is the home directory) to a regular file, or a link to one, that is executable. A path
  holding `:` is refused, since it could not go in `PATH`.
- The user can add up to 5 custom agents, so the **Agent quotas** section still fits the menu of
  a 1280x800 screen without scrolling, as QTA says. They keep the order they were added in.
- Two custom agents cannot share a command, compared as typed after trimming, nor a name,
  compared case-insensitively, so the menu and notifications tell them apart; nor can a name be
  `Claude`, `Codex`, or `Antigravity`, in any case. A custom agent cannot be the built-in agent of its
  type: a command whose found file, links resolved, is the one the built-in `claude`, `codex`,
  or `agy` resolves to, for the same type, is refused; that one is the built-in switch.
- Each custom agent has its own enabled switch, like a built-in provider. A new one is enabled.

## Preferences

- TAB's **Agents** tab holds, after QTA's **Agent quotas** group, a **Custom agents** group
  described `Another command that runs Claude Code, Codex, or Antigravity, such as a wrapper on
  another subscription. Greenlight reads its quota the way it reads that agent's.`
  (PREFS-EMPTY)
- The group's header holds a **+** button (`list-add-symbolic`, accessible name and tooltip
  `Add a custom agent`). With 5 custom agents, it is insensitive and its tooltip reads
  `5 custom agents at most`. (PREFS-FULL)
- Without any custom agent, the group shows one row: `No custom agent. Add one with +.`
  That row is hidden while a new row exists. (PREFS-EMPTY)
- The group lists the custom agents, one row each: the title is the name, the subtitle
  `<type> quota · <availability>`, a trash button (`user-trash-symbolic`, accessible name
  `Remove <name>`), then the switch. The availability text and the switch follow QTA's
  availability rules for the agent's type: `Checking…` while its check runs, `Uses <path>` when
  available (the found file, with the home directory shown as `~`: `Uses
  ~/.local/bin/claude-work`; a path outside the home in full), the unavailability message otherwise (switch off and locked),
  `Could not check: <cause>. Reopen Preferences to try again.` on a failed check. Only the
  switch is ever locked: the trash button stays usable in every state. (PREFS-LIST,
  PREFS-CHECKING, PREFS-UNAVAILABLE)
- Commands, paths, and messages are shown as plain text, never as markup, so a path holding `&`
  or `<` reads as typed.
- **+** adds a new row at the end of the list, which takes the focus: an entry (placeholder
  `claude-work or ~/bin/codex-team`) with a hint under it, `Type a command, pick its quota type,
  then press Enter`, a **Quota type** drop-down (**Claude**, **Codex**, **Antigravity**; **Claude** by
  default), and a trash button (`Cancel`) that drops the row. Only one new row exists at a time:
  **+** is insensitive while it does. (PREFS-NEW, PREFS-TYPED)
- The group description also says what the type means for the command:
  `Greenlight runs it as it runs that agent, so pick the type of the agent it runs.`
  A command given the wrong type receives arguments it does not know, and may start a session.
- Keyboard: the entry, then the drop-down, then the trash button. Enter in the entry or on the
  closed drop-down accepts; Escape in the entry or on the closed drop-down drops the new row and
  goes no further, so it never closes the window. While the drop-down's list is open, Enter only
  picks the type and Escape only closes the list. After a row is dropped or removed, the focus
  goes to **+**, or to the new row's entry while one exists (**+** is then insensitive). After
  Enter accepts a new row, the focus goes to **+**, or, with 5 custom agents (**+** then
  insensitive), to the new agent's row.
- Enter checks the command without running it. An accepted command turns the new
  row into a custom agent row, enabled, whose availability check starts at once (it runs the
  command, as QTA's check runs the built-in CLI). A refused one keeps the row, marks the entry
  and the hint as errors, and shows the reason in place of the hint until the entry or the type
  changes, or a save writes a setting (see below); the hint, the reason, and every text of the new row are plain text, never markup. The first rule that fails,
  in this order, gives the reason:
  1. `Enter a command name or a path.` for a command of another form;
  2. `A path cannot hold ":".`;
  3. `<name> is a built-in agent's name.` for `Claude`, `Codex`, or `Antigravity` in any case
     (so `claude` with any type);
  4. `<command> is already listed.`, then `<name> is already listed.`; (PREFS-DUPLICATE)
  5. `<command> not found in PATH or ~/.local/bin` for a name, `<path> is not an executable
     file` for a path; (PREFS-NOT-FOUND)
  6. `<command> is the built-in <type> agent.` for a command whose file is the built-in's,
     `<type>` being the label of the **Quota type** drop-down (`Claude`, `Codex`, or
     `Antigravity`).
- A new row not yet accepted is not a setting: it makes no tab unsaved and closing the window
  drops it. A save leaves it as it is and writes the rest; when that save writes a setting and
  the entry holds text, its hint then reads `Not added yet: press Enter to add it`, no longer
  marked as an error.
- A custom agent's trash button removes its row at once and cancels its check; like every change
  of the tab, the removal applies on save. (PREFS-REMOVED, PREFS-REMOVED-SAVED)

## Unsaved changes

- Under TAB, the custom agents are one more setting of the **Agents** tab, the list: commands,
  types, order, and switches, compared as a whole with its baseline. An addition, a removal, or
  a switch makes **Agents** unsaved; removing an agent just added, or switching one back, brings
  it back to its baseline. A save writes `custom-agents` only when the list differs from its
  baseline or carries a pending normalization, as TAB says for every key.
- A custom agent added in this window has no saved choice yet. A save while its check runs, or
  after a check that could not finish, stores it enabled; after a check that finds it
  unavailable, its switch is off, and a save stores it off.
- A check that turns off the switch of a custom agent already saved is a pending normalization,
  as for a built-in provider: it shows no banner, and the next save stores the list with that
  switch off.
- Closing the window drops unsaved additions and removals, and cancels every check, as TAB and
  QTA say.

## Menu and notifications

- In the **Agent quotas** section, custom agents follow the built-in ones (Claude, Codex,
  Antigravity), in the order of the list. Each one's name takes its own line above its windows,
  as Antigravity's does. Its windows, labels, slots, colors, pace mark, dimming, and causes
  follow QTA for its type. The section keeps one `Updated` line, from the oldest successful
  reading shown, built-in and custom providers alike. (MENU)
- Every row of the **Agent quotas** section, custom agents' included, has QTA's 1 px of padding
  above and below, so the section with the three built-in agents and five two-window custom
  ones, one of them dimmed with its cause, fits a 1280x800 screen with **Refresh now**, quick
  open, and **Preferences…** in view. Rows outside
  the section, such as RTN's routines, keep their own padding.
- A custom agent is a provider of its own: its reading, its refresh in flight, its last try, and
  its notified periods are its own, under the identifier `custom:<type>:<command>`. Two custom
  agents, or a custom agent and the built-in one of its type, read and notify separately, and
  an agent removed and added again with another type starts as a new provider.
- Notifications name it: `claude-work weekly quota at 84 %` / `Resets Mon 10:00`, with QTA's
  window names. (NOTIF)
- When a save removes a custom agent or switches it off, the extension cancels its refresh,
  drops any result that lands after, and forgets its reading and its marked periods, as
  switching a built-in provider off does. When a save adds one or switches it on, the extension
  reads it, and its first reading sets QTA's quiet baseline. The other providers keep their
  readings and their work in flight.

## Running a custom agent

- Greenlight runs the custom command where QTA runs the built-in CLI of its type, with the same
  arguments, the same timeouts, the same parsing, and the same rules: `-p /usage
  --no-session-persistence --output-format json --settings {"disableAllHooks":true}` for
  **Claude**, `app-server` and its three messages for **Codex**, `-p /usage --output-format json`
  for **Antigravity**.
- It runs from the home directory with the extension's environment, `PATH` put in this order:
  the no-op `xdg-open` directory (Antigravity type only), the command's own directory,
  `~/.local/bin`, then the inherited `PATH`. Greenlight passes it no other variable: a wrapper
  that sets its own configuration directory keeps doing so, and an Antigravity-type wrapper must
  not put its own directory before the no-op `xdg-open`.
- A wrapper is expected to end by `exec`ing its agent with the arguments it received. On a
  timeout, Greenlight stops the process it started, as QTA says; an agent that a wrapper started
  without `exec` can outlive it.
- A command found when it was added and missing later is unavailable: the preferences show the
  not-found message of **Preferences**, and the menu hides the agent, as QTA hides an
  unavailable provider.
- QTA's unavailability messages name the custom command, as the user typed it, where they name
  the built-in one: `Claude Code is not signed in with a Claude subscription. Run claude-work,
  then /login.`, `Codex is not signed in. Run ~/bin/codex-team login.`, `This codex-team cannot
  report rate limits. Update Codex.`, `Codex reports no subscription quota. Sign in with ChatGPT:
  ~/bin/codex-team login.`, `Antigravity is not signed in. Run agy-alt and sign in.`, and
  `Antigravity answered /usage in an unknown form. Update agy-alt.` (`codex-team` there is the
  name; every other message names the command as typed, a path included: `Update
  ~/bin/agy-alt.`); the others are unchanged.

## Storage

- A new setting, `custom-agents` (`s`, a JSON array, `[]` by default), holds the list in order,
  each entry `{"command": <string>, "type": "claude" | "codex" | "agy", "enabled": <boolean>}`.
  Text that is not a JSON array reads as no custom agent. An entry that is not such an object,
  whose command has none of the forms of **Custom agents**, whose name is a built-in agent's,
  or whose command or name clashes with
  an earlier entry, is skipped; after five kept entries, the rest are skipped. Reading never looks
  at the files: a command missing on disk stays listed, so it can be removed.
- The list the window shows is the baseline: skipped entries are not a pending normalization,
  stay stored while nothing writes the list, and are dropped the next time it is written.
- `agent-quota-cache` keeps a custom agent's reading under its identifier, like a built-in
  provider's, and its notified periods as `<identifier>:<slot>:<reset time>`, read from the
  right: the last two fields are the slot and the reset time, and the rest is the identifier,
  compared whole. Built-in periods keep their form. When the extension loads the cache, a
  reading or a period whose provider is not a listed and enabled agent is dropped.

## Out of scope

- Agents of another type than Claude Code, Codex, and Antigravity, and quota commands of the
  user's own design.
- Arguments or environment variables entered in the preferences: a command that needs them is a
  wrapper script.
- Renaming a custom agent, or reordering the list: remove it and add it again.
- Ending the processes a wrapper starts without `exec`.
- A screen too short for the whole section with every agent shown (about 600 px tall with the
  five custom agents): GNOME Shell's menu height limit cuts the menu, as for any menu taller
  than the screen.
- Limiting how many CLIs read at once: with the three built-in agents and five custom ones, up
  to eight run together, each under its own timeout.
- Checking that a command matches its quota type.

## Plans

### CAG-P1: custom agents

- **Depends on**: TAB-P2 merged, since the group sits on TAB's **Agents** tab and its changes
  follow TAB's unsaved changes and save.
- **Scope**: the whole spec. The QTA and TAB lines CAG amends are rewritten, with `v1.5`
  in `amended`. README.md describes custom agents.
- **Prototype first** (throwaway, in the headless GNOME Shell of AGENTS.md, opened with
  `gnome-extensions prefs`): on the **Agents** page, an `Adw.ActionRow` whose prefix is a
  `Gtk.Entry` and whose suffixes are a `Gtk.DropDown` and a trash `Gtk.Button`, and an agent row
  with a trash button and a `Gtk.Switch` in a suffix box. Pass: the Tab order is entry,
  drop-down, trash; Enter in the entry and on the closed drop-down reaches the handler; Escape in
  the entry and on the closed drop-down reaches the handler and does not close the window; Enter
  and Escape in the open list only pick a type and close the list; the switch
  made insensitive leaves the trash button usable; the focus moves to **+** after a removal; no
  GTK critical or JS error. Fail: report to the owner before going further.
- **Acceptance**:
  - Unit tests (`node --test`): the command forms (names, `/` and `~/` paths, refused forms), the
    name from a path, a path with `:`, the clash rules (command, name in any case, built-in
    names), the limit, the storage reader (not an array, a non-object entry, an unknown type, a
    string `"false"` for `enabled`, an invalid entry before the fifth valid one, duplicates, a
    sixth entry, skipped entries dropped when the list is written), the identifier with its
    type, period keys of custom agents (kept across a reload; removing `/bin/team` keeps the
    marks of `/bin/team-work`; built-in marks unchanged), the messages
    with a custom command, the list comparison and its pending normalization, and the menu order
    of built-in then custom providers.
  - In the headless GNOME Shell, with a temporary home shared by the shell and the preferences
    service, and stub CLIs written by the test in that home's `~/.local/bin`, each answering from
    a file the test rewrites between steps (signed in, signed out, a usage, a delay), not shipped:
    - adding `claude-work` (Claude), `codex-team` (Codex), and a signed-out `claude-alt` (Claude)
      through the **Agents** tab, by keyboard only in a narrow window (Escape in a new row drops
      it and leaves the window open), shows `Checking…`, then
      `Uses <path>` or the signed-out message with the switch locked off and the trash button
      still usable; a missing command, a duplicate, `claude` with **Claude**, and a link to the
      built-in `claude` with **Claude** are refused with their messages; a path holding `&`
      reads as typed;
    - a save stores `custom-agents`; an external change of the author followed by an
      **Agents**-only save keeps it; the menu lists `claude-work` and `codex-team` after the
      built-in agents, each on its own name line, with their own windows;
    - raising `claude-work`'s usage across the threshold notifies `claude-work … quota at …`
      and nothing for `claude-alt` or the built-in `claude`;
    - removing a row whose check is delayed, then adding it again, shows only the new check's
      result; removing `claude-work` and saving drops its lines and its cache entries;
    - a save with text typed in a new row keeps that row and its text, and writes the rest;
    - on the 1280x800 virtual monitor of AGENTS.md with the three built-in agents and five
      two-window custom agents, one of them dimmed with its cause, the section is whole, and
      **Refresh now**, quick open, and **Preferences…** stay in view, as QTA and QOP say.
    Screenshots, and no `JS ERROR` or `JS WARNING` in the log.
  - `scripts/screenshots.sh` shows one custom agent in `menu.png` and in
    `preferences-agents.png`.
  - `npm run lint` and `make check` pass.
- **Technical notes**:
  - The command forms, the name, the clash rules, the storage reader, the identifier, and the list
    comparison go in a new pure module, `src/customagents.js`, added to AGENTS.md's layout table.
    The list is a list-valued setting of TAB-P2's comparison module, which CAG-P1 extends.
  - `PROVIDERS` in `src/quotas.js` holds the built-in agents with a fixed `command` and
    `setting`; a custom agent is a provider built from its entry, `{id, name, command, type}`,
    whose reader is its type's (`readClaude`, `readCodex`, `readAgy` in `src/agents.js`, which
    already take the found path), and whose slots, labels, and messages are its type's.
    `readQuota` takes the provider object itself, so the preferences check every listed agent,
    off ones included. `readQuotaCache` (`validWindow`, `validPeriod`), the quota state, the
    cache, and the menu take the list of providers, built-in and enabled custom ones, as an
    argument instead of reading `PROVIDERS` alone; the extension's `_loadQuotaCache` passes it.
  - `forgetPeriods` matches by `startsWith(provider + ':')` and `validPeriod` splits on `:` into
    exactly three fields; a custom identifier holds `:` itself, so both parse from the right
    instead, and compare the identifier whole.
  - `findCli` takes a name; a path is expanded (`~/`) and checked with two `GLib.file_test`
    calls, `IS_REGULAR` and `IS_EXECUTABLE`, since flags combined in one call are ORed. The
    built-in clash compares the files' `unix::device` and `unix::inode` from
    `Gio.File.query_info`, which follows links.
  - `spawn` in `src/agents.js` already puts `leadingDirs`, the command's directory,
    `~/.local/bin`, then `PATH`, in that order.
  - Each custom row is an `Adw.ActionRow` (`use-markup` false, `subtitle-selectable` off) with a
    suffix box holding the trash `Gtk.Button` and a `Gtk.Switch`, so only the switch is made
    insensitive. The new row is an `Adw.ActionRow` whose prefix is a vertical box holding the
    `Gtk.Entry` and the hint label under it, and whose suffixes are a `Gtk.DropDown` and the
    trash button. Each row's check has its own
    cancellable, cancelled on removal; a result for a row no longer listed is dropped.
  - The extension follows `changed::custom-agents` and reconciles: providers removed, switched
    off, or whose type changed are cancelled and forgotten; unchanged ones keep their state.
  - The messages that name a command become functions of it in `src/quotas.js`, so the built-in
    texts stay as QTA lists them.
  - The schema gains `custom-agents` (`s`, default `'[]'`).
