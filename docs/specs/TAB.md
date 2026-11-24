---
code: TAB
status: draft
version: v1.5
created: 2026-11-24
builds-on: PRM
tracking: "#57"
---

# Greenlight — TAB specification

TAB splits the preferences window into tabs, one per part of Greenlight (pull requests, agents,
and the version), with one **Save** button in the header bar that applies every tab together,
a dot on each tab that holds unsaved changes, and a confirmation before unsaved changes are
dropped. Greenlight is growing from a pull request monitor into a view of what the agents do,
and one long page no longer scales. TAB builds on PRM, QOP, QTA, ORD, and ABT, whose rules all
still apply except the ones it replaces, which TAB-P1 and TAB-P2 rewrite in those specs: PRM's
**Save preferences** rule (it applies every setting and closes the window), PRM's and ORD's
mentions of **Save preferences**, QOP's shortcut validation (which field takes the focus), QTA's
placement of the **Agent quotas** group and its save during a check (which closes the window),
and ABT's **About** group at the bottom of the window. The settings, their keys, their values,
and what each row does are unchanged. The mockup is [`mockups/TAB.html`](mockups/TAB.html).

## Window

- The preferences window has three tabs, in this order: **Pull requests**, **Agents**, and
  **About**. A later spec that adds a tab inserts it before **About**. (PREFS-PR)
- Each tab has a title and a symbolic icon: **Pull requests** uses the extension's own
  `greenlight-pr-symbolic` icon, the one of the panel indicator; **Agents** uses
  `power-profile-balanced-symbolic`; **About** uses `help-about-symbolic`.
- The tab switcher sits in the center of the header bar. When the window is narrower than
  550 sp, it moves to a bar at the bottom of the window, as Adwaita applications do, and the
  header bar shows the window title instead. (PREFS-NARROW)
- The window always opens on **Pull requests**. It does not remember the last tab.
- Each tab scrolls on its own. Switching tabs keeps each tab's scroll position and every unsaved
  value in it.
- The window has no search. The repository filter of each owner block stays (PRM).

## Tabs

- **Pull requests** holds, from top to bottom, the groups PRM, QOP, and ORD describe:
  **Monitoring** (**Author**, **Refresh interval**), **Quick open** (the keyboard shortcut),
  **Accounts and organizations**, then one block per owner. Their rows, texts, and behavior are
  unchanged. (PREFS-PR)
- **Agents** holds QTA's **Agent quotas** group: the **Claude**, **Codex**, and **Antigravity**
  switches, **Refresh every**, and **Notify at**, with their availability checks, which still
  start when the window opens, whatever tab is shown. (PREFS-AGENTS)
- **About** holds ABT's **Version** and **Source code** rows. It has no setting. (PREFS-ABOUT)
- The **Save preferences** row at the bottom of the page is gone: **Save** is in the header bar.

## Save

- A **Save** button, styled as the suggested action, sits at the end of the header bar, in every
  tab. (PREFS-DIRTY)
- **Save** is sensitive only when at least one tab has unsaved changes (see **Unsaved changes**)
  and no `gh` task of the **Pull requests** tab runs (PRM: only one runs at a time, and its
  buttons and the save wait for it). (PREFS-PR, PREFS-BUSY)
- `Ctrl+S` activates **Save** when it is sensitive, from any tab, and does nothing otherwise.
- Its tooltip names the tabs with unsaved changes, in tab order: `Save changes to Pull requests`,
  `Save changes to Pull requests and Agents`. With none, it reads `No unsaved changes`.
- **Save** applies the settings of every tab together, in one batch that writes only the keys
  whose value changed, as PRM's save does today, so a save that changes nothing PRM refreshes
  for starts no refresh.
- The window stays open after a save. The dots clear, **Save** turns insensitive, and a toast
  reads `Preferences saved`. (PREFS-SAVED)
- After a save, the owner blocks keep their state on screen (discovered repositories, filter
  text, open lists, scroll position); the saved configuration becomes the new baseline.
- An invalid keyboard shortcut stops the save before anything is written, in any tab: the window
  switches to **Pull requests**, marks the shortcut field, and gives it the focus, as QOP says.
  Editing the field clears the mark. (PREFS-SHORTCUT)
- A save while a provider's availability check still runs keeps that provider's saved choice
  (QTA). When the check then reports the provider unavailable, its switch turns off without
  making **Agents** unsaved, and the stored value stays on until a later save stores it off; the
  menu hides an unavailable provider anyway (QTA).

## Unsaved changes

- A tab has unsaved changes when one of its settings, as the window shows it, differs from its
  baseline. Setting a value back to its baseline clears the change.
- The baseline is each setting as stored when the window opens, as the window shows it, then as
  stored by each save. The window's own adjustments update the baseline instead of making a
  change: a provider switch that its check turns off and locks (QTA), and a **Refresh every**
  stored outside the list and shown as 1 hour (QTA).
- The settings of **Pull requests** compare as follows:
  - **Author**: the text, trimmed.
  - **Refresh interval**: the selected value.
  - **Keyboard shortcut**: the trimmed text, as an accelerator when it parses, so
    `<Shift><Super>g` equals a stored `<Super><Shift>g`; a text that does not parse differs from
    any stored value, so **Save** can report it.
  - The owners: the configuration a save would store, the same one ORD's save writes: every
    configured owner, enabled or paused, with its kind and repository scope (`owner-filters`),
    and their block order (`owner-order`). A **Discover** of repositories that leaves the scope
    as saved is not a change; an owner added by **Add** or **Discover accounts**, a removed one, a
    paused or resumed one, a mode or a repository switch that changes the stored scope, and a move
    are. A filter text, an open or closed list, and a scroll position are not settings.
- The settings of **Agents** are the three switches, **Refresh every**, and **Notify at**.
- **About** never has unsaved changes.
- A tab with unsaved changes shows a dot on its button in the tab switcher, Adwaita's attention
  indicator, in the header bar and in the bottom bar alike. (PREFS-DIRTY)

## Closing

- Closing the window without unsaved changes closes it at once, and cancels the `gh` task and
  the availability checks still running, as PRM and QTA say. (PREFS-CLOSE)
- Closing it with unsaved changes, by any means the window offers (its close button or a
  keyboard shortcut), opens a dialog instead: the heading `Save changes?`, the body
  `Pull requests has unsaved changes.` or `Pull requests and Agents have unsaved changes.`, and
  three responses: **Cancel**, **Discard** (destructive), and **Save** (suggested, the default).
  (PREFS-CLOSE)
- **Cancel**, or `Escape`, closes the dialog and keeps the window and its changes as they were.
- **Discard** closes the window without writing anything.
- **Save** saves as the header bar button does, then closes the window. When the shortcut is
  invalid, the save stops as **Save** says and the window stays open on the field.
- While a `gh` task runs, **Save** in the dialog is insensitive, as in the header bar; **Discard**
  and **Cancel** stay available.

## Out of scope

- Applying a setting as soon as it changes, without **Save**.
- Remembering the last tab, and a search over the settings.
- Moving a setting to another tab, or changing a row's text, beyond the **Save preferences** row
  removed.

## Plans

### TAB-P1: tabs and the header bar Save

- **Scope**: **Window**, **Tabs**, and **Save**, except what TAB-P2 delivers below. The PRM, QOP,
  QTA, ORD, and ABT rules that TAB replaces are rewritten in those specs to describe the tabbed
  window and the header bar **Save** that stays open, and each spec's `amended` gets `v1.5`.
  README.md's preferences steps and screenshot follow.
- **Temporary restrictions**, delivered by TAB-P2: there is no unsaved-change tracking, so
  **Save** is sensitive whenever no `gh` task runs, its tooltip reads `Save preferences`, no tab
  shows a dot, and closing the window drops unsaved changes without a dialog, as before TAB.
- **Prototype first** (throwaway, in the headless GNOME Shell of AGENTS.md): in
  `fillPreferencesWindow`, replace the window's content with an `Adw.ToastOverlay` holding an
  `Adw.ToolbarView`, whose top bar is an `Adw.HeaderBar` with an `Adw.ViewSwitcher`
  (`policy: wide`) as its title widget and a **Save** button packed at the end, whose bottom bar
  is an `Adw.ViewSwitcherBar`, and whose content is an `Adw.ViewStack` of three
  `Adw.PreferencesPage`s; an `Adw.Breakpoint` (`max-width: 550sp`) reveals the bottom bar and
  swaps the title widget for an `Adw.WindowTitle`. Pass: the window opens with the three tabs
  and the button, switches tabs, shows the bottom bar when narrowed, `ViewStackPage`
  `needs-attention` shows a dot, a toast shows, the custom icon resolves, and the shell and
  preferences logs have no GTK critical or JS error. Fail fallback: keep the native
  multi-page `Adw.PreferencesWindow` (`window.add(page)` per tab, which shows its own view
  switcher) and add **Save** to its header bar and `needs-attention` to its pages through the
  window's widget tree, guarded so a missing widget leaves a **Save** row at the bottom of each
  tab instead; report which path shipped.
- **Acceptance**:
  - `npm run lint` and `make check` pass.
  - In the headless GNOME Shell: the window opens on **Pull requests** with the tabs in order
    and their icons; each tab holds exactly the groups **Tabs** lists; **Save** in the header bar
    applies a changed author, a moved owner block, and a changed **Notify at** in one save, the
    window stays open, and the toast shows; an invalid shortcut saved from **Agents** switches to
    **Pull requests** with the field marked and focused, and writes nothing; **Save** is
    insensitive while **Discover accounts** runs; at 500 px wide the switcher is a bottom bar.
    Screenshots of each, and no `JS ERROR` or `JS WARNING` in the log.
  - `scripts/screenshots.sh` captures each of the three tabs (`preferences.png` stays the
    **Pull requests** tab; `preferences-agents.png` is new), and README.md shows them.
- **Technical notes**:
  - `src/prefs.js` builds one `Adw.PreferencesPage` today and adds every group to it, the save
    group and the about group re-added after the owner blocks by `renderOwners()`; with tabs,
    `renderOwners()` lays out the **Pull requests** page only, and the save group goes away.
  - `Adw.ViewStackPage` takes an `icon-name` only: add the extension directory to the icon theme
    with `Gtk.IconTheme.get_for_display(window.get_display()).add_search_path(this.path)` so
    `greenlight-pr-symbolic` resolves from `src/greenlight-pr-symbolic.svg`.
  - Keep the save's one-batch, changed-keys-only writing, and never call `settings.delay()` on a
    settings object that is used after the batch, as AGENTS.md warns; the window now stays open
    after a save, so the batch must use its own `this.getSettings()` object, or apply its writes
    without `delay()`.
  - The `close-request` handler keeps cancelling the `gh` task, the quota checks, and the pending
    focus moves.
  - `Ctrl+S`: a `Gtk.ShortcutController` on the window with a `Gtk.CallbackAction` that runs the
    save only when the button is sensitive.

### TAB-P2: unsaved changes, dots, and the close dialog

- **Scope**: **Unsaved changes**, **Closing**, and the parts of **Save** that TAB-P1 left out:
  the sensitivity that follows unsaved changes, the tooltip, and the baseline after a save and
  after a check. The rewritten PRM and QTA lines of TAB-P1 that state the restrictions are
  updated to the final behavior.
- **Acceptance**:
  - Unit tests (`node --test`) for the pure comparison: author trimming, shortcut equivalence and
    an invalid shortcut, an owner configuration equal after a **Discover** that changed nothing,
    a move and a move back, a paused owner, a mode change that keeps the stored scope, and the
    tooltip and dialog texts for one and two tabs.
  - In the headless GNOME Shell: a changed author shows the dot on **Pull requests** and
    sensitizes **Save**; typing it back clears both; a changed **Notify at** adds the dot on
    **Agents**; the tooltip names both; a save clears them; closing with changes shows the dialog,
    **Cancel** keeps them, **Discard** closes without writing (checked with `gsettings` on the
    keyfile), **Save** writes and closes; an unavailable provider whose check turns its switch
    off shows no dot. Screenshots, and no `JS ERROR` or `JS WARNING` in the log.
  - `npm run lint` and `make check` pass.
- **Technical notes**:
  - Put the comparison in a pure module, next to `src/order.js`, which already holds the unsaved
    row order: it takes the shown values and the baseline and returns the tabs with changes. It
    reuses `ownerFiltersToSave()` from `src/filters.js`, which already returns `null` when the
    owners would be saved as they are, and compares the block order separately.
  - The window's `close-request` handler returns `true` to keep the window while the
    `Adw.AlertDialog` is open, and closes it after **Discard** or a successful **Save** with a flag
    that lets the next `close-request` through.
  - Recompute the dots and the button on every change signal of the rows (`changed`,
    `notify::selected`, `notify::active`, `notify::value`) and after every owner block change
    (`renderOwners()`, `fillOwnerGroup()`, a move, a trash icon).
