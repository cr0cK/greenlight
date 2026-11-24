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
and the version), with one save that applies every tab, offered by a banner at the top of every
tab while changes are unsaved, and a confirmation before unsaved changes are dropped. Greenlight
is growing from a pull request monitor into a view of what the agents do, and one long page no
longer scales. TAB builds on PRM, QOP, QTA, ORD, and ABT, whose rules all still apply except the
ones it replaces, which TAB-P1 and TAB-P2 rewrite in those specs: PRM's **Save preferences** rule
(it applies every setting and closes the window), PRM's and ORD's mentions of **Save
preferences**, ORD's rules on closing without saving and on pending focus moves, QOP's shortcut
validation (which field takes the focus), QTA's placement of the **Agent quotas** group and its
save during a check (which closes the window), and ABT's **About** group at the bottom of the
window. The settings, their keys, their values, and what each row does are unchanged. The mockup
is [`mockups/TAB.html`](mockups/TAB.html).

## Window

- The preferences window has three tabs, in this order: **Pull requests**, **Agents**, and
  **About**. A later spec that adds a tab inserts it before **About**. (PREFS-PR)
- The tabs are the pages of GNOME Shell's own preferences window (`Adw.PreferencesWindow`, one
  `Adw.PreferencesPage` per tab added with `window.add()`), so the tab switcher, its place in the
  header bar, and the bottom bar it moves to in a narrow window are Adwaita's own, at Adwaita's
  own width threshold. (PREFS-NARROW)
- Each tab has a title and a symbolic icon: **Pull requests** uses the extension's own
  `greenlight-pr-symbolic` icon, the one of the panel indicator; **Agents** uses
  `power-profile-balanced-symbolic`; **About** uses `help-about-symbolic`.
- The window always opens on **Pull requests**. It does not remember the last tab.
- Each tab scrolls on its own. Switching tabs keeps each tab's scroll position and every unsaved
  value in it, except as **Save** says for an invalid shortcut.
- The window has no search, as GNOME Shell opens it today.

## Tabs

- **Pull requests** holds, from top to bottom, the groups PRM, QOP, and ORD describe:
  **Monitoring** (**Author**, **Refresh interval**), **Quick open** (the keyboard shortcut),
  **Accounts and organizations**, then one block per owner. Their rows, texts, and behavior are
  unchanged. (PREFS-PR)
- **Agents** holds QTA's **Agent quotas** group: the **Claude**, **Codex**, and **Antigravity**
  switches, **Refresh every**, and **Notify at**, with their availability checks, which still
  start when the window opens, whatever tab is shown. (PREFS-AGENTS)
- **About** holds ABT's **Version** and **Source code** rows. It has no setting. (PREFS-ABOUT)
- The **Save preferences** row at the bottom of the page is gone: the banner below replaces it.
- ORD's focus moves after **Add**, **Discover accounts**, a move, or a trash icon apply only
  while **Pull requests** is the visible tab: switching to another tab cancels a pending one, and
  a `gh` answer that lands while another tab is shown moves no focus.

## Save

- While at least one tab has unsaved changes (see **Unsaved changes**), every tab shows a banner
  at its top, outside its scrolled content (`Adw.PreferencesPage`'s `banner`), titled
  `Unsaved changes in Pull requests` or `Unsaved changes in Pull requests and Agents`, the tabs
  named in tab order (with three, `Pull requests, Agents, and Routines`), with a
  **Save** button in the suggested style. Without unsaved changes, no banner shows. (PREFS-DIRTY)
- The banner's **Save** is insensitive while a `gh` task of the **Pull requests** tab runs (PRM:
  only one runs at a time, and its buttons and the save wait for it); the banner stays.
  (PREFS-BUSY)
- `Ctrl+S`, inside the window, saves when the banner's **Save** is sensitive, and does nothing
  otherwise. A quick open shortcut (QOP) set to `<Control>s` is GNOME Shell's and takes the keys
  first; Greenlight does not change it.
- Before anything is read, a save commits a value still being typed in **Notify at**: valid text
  becomes its value, as leaving the field would do, and invalid text falls back to the field's
  last value.
- An invalid keyboard shortcut stops the save before anything is written, from any tab: the
  window switches to **Pull requests**, scrolls the shortcut field into view, marks it, and gives
  it the focus, as QOP says. Editing the field clears the mark. (PREFS-SHORTCUT)
- A save writes the settings whose value, as the window shows it, differs from its baseline (see
  **Unsaved changes**), plus the pending normalizations listed there, and nothing else, in one
  batch: a fresh settings object in delay-apply mode, every write checked, then one `apply()`.
  A setting nobody changed in the window is never written, so a change made elsewhere while the
  window is open (another `gsettings` write) survives a save that does not touch it; one changed
  on both sides takes the window's value.
- When a write is refused (a locked key), the save reverts the batch, writes nothing, keeps every
  unsaved change, and shows a toast `Could not save: <key> is not writable`.
- After a successful save, the window stays open. The banner hides, and a toast reads
  `Preferences saved`. The values saved become the baseline. The owner blocks keep their state on
  screen (discovered repositories, filter text, open lists, scroll position). (PREFS-SAVED)
- As in PRM and ORD, a save that changes nothing PRM refreshes for (owners, repositories,
  author) starts no refresh, and one that changes only the owner order re-sorts the menu without
  a `gh` call.

## Unsaved changes

- A tab has unsaved changes when one of its settings, as the window shows it, differs from its
  baseline. Setting a value back to its baseline clears the change.
- The baseline of a setting is its value as the window shows it when the window opens, then the
  value each save writes. The window's own adjustments change what the window shows, but also
  the baseline, so they alone never make a tab unsaved; they are **pending normalizations**,
  written by the next successful save of any tab:
  - a provider switch that its availability check turns off and locks (QTA): the switch and its
    baseline turn off, and the next save stores it off. A check still running, or one that failed
    with `Could not check`, keeps the saved choice and normalizes nothing;
  - a **Refresh every** stored outside the list and shown as 1 hour (QTA): the next save stores
    60;
  - the owner order, which ORD completes when the window opens (owners missing from
    `owner-order` added in ORD's kind-then-login order, unknown logins dropped): the baseline is
    that completed order, and the next save stores it, as ORD's save does.
- A check that answers after a save updates the switch and the baseline the same way, and adds
  its normalization for the next save.
- The settings of **Pull requests** compare as follows:
  - **Author**: the text, trimmed.
  - **Refresh interval**: the selected value.
  - **Keyboard shortcut**: classified as blank (disabled), valid (it parses and names a key,
    so `<Control>` alone is invalid), or invalid. Two valid values are equal when they name the
    same accelerator, so `<Shift><Super>g` equals a stored `<Super><Shift>g`; blank equals blank;
    an invalid text differs from any stored value, so the save can report it. A stored value
    that is itself invalid opens as the window shows it and is its own baseline, so it opens
    clean.
  - The owners: every configured owner, enabled or paused, with its kind and repository scope,
    compared as PRM compares them (logins and repository names case-insensitively, the mode
    kept, since **All except…** and **Only…** treat new repositories differently), and their
    block order. A **Discover** of repositories that leaves the scope as saved, even with a
    different spelling of a name, is not a change, and a save then keeps the stored spelling; an
    owner added by **Add** or **Discover accounts**, a removed one, a paused or resumed one, a
    mode or a repository switch that changes the stored scope, and a move are changes. A filter
    text, an open or closed list, and a scroll position are not settings.
- The settings of **Agents** are the three switches, **Refresh every**, and **Notify at**.
- **About** never has unsaved changes.

## Closing

- Closing the window without unsaved changes closes it at once, and cancels the `gh` task and
  the availability checks still running, as PRM and QTA say. (PREFS-CLOSE)
- Closing it with unsaved changes, by any means the window offers (its close button or a
  keyboard shortcut), keeps it open and shows a dialog instead: the heading `Save changes?`, the
  body `Pull requests has unsaved changes.` or `Pull requests and Agents have unsaved changes.`,
  the tabs named in tab order, and three responses: **Cancel**, **Discard** (destructive), and
  **Save** (suggested, the default). `Escape` is **Cancel**. (PREFS-CLOSE)
- Only one dialog exists at a time. While it is open, its body and its **Save** follow the window:
  a `gh` answer that changes which tabs are unsaved updates the body, and **Save** is insensitive
  while a `gh` task runs, as the banner's is. **Discard** and **Cancel** stay available.
- **Cancel** closes the dialog and leaves the window, its unsaved changes (owner moves included),
  and its running tasks as they were.
- **Discard** closes the window without writing anything, and cancels the running tasks.
- **Save** saves as the banner does, then closes the window. When the save stops on an invalid
  shortcut or a refused write, the dialog closes, the window stays open, and the save's own rule
  applies (the shortcut field takes the focus once the dialog has released it, or the toast
  shows).
- While the dialog is open, Greenlight keeps the preferences service running, so the window
  cannot close under it.

## Out of scope

- Applying a setting as soon as it changes, without a save.
- Remembering the last tab, a search over the settings, and a mark on the tab switcher's buttons.
- Moving a setting to another tab, or changing a row's text, beyond the **Save preferences** row
  removed.

## Plans

### TAB-P1: tabs and the save banner

- **Scope**: **Window**, **Tabs**, and **Save**, except what TAB-P2 delivers below. The PRM, QOP,
  QTA, ORD, and ABT rules that TAB replaces are rewritten in those specs to describe the tabbed
  window and the save that keeps it open, and each spec's `amended` gets `v1.5`. README.md's
  preferences steps and screenshots follow.
- **Temporary restrictions**, delivered by TAB-P2: there is no unsaved-change tracking, so the
  banner shows on every tab at all times, titled `Save your changes to apply them`, its **Save**
  sensitive whenever no `gh` task runs; a save writes every setting whose value differs from the
  stored one, as PRM's save does today, with the batch, the refused-write rule, and the toast of
  **Save**; closing the window drops unsaved changes without a dialog, as before TAB.
- **Prototype first** (throwaway, in the headless GNOME Shell of AGENTS.md, opened with
  `gnome-extensions prefs`): `fillPreferencesWindow` adds three `Adw.PreferencesPage`s with
  `window.add()`, each with an `Adw.Banner` as its `banner`, whose button activates a
  `prefs.save` action on the window. Pass: the window opens with its three tabs, the banner shows
  above each page's scrolled content and stays while it scrolls, disabling the action makes every
  banner's button insensitive, the custom icon resolves, and the logs have no GTK critical or JS
  error. Fail: report to the owner before going further; there is no silent fallback.
- **Acceptance**:
  - `npm run lint` and `make check` pass.
  - In the headless GNOME Shell: the window opens on **Pull requests** with the tabs in order
    and their icons; each tab holds exactly the groups **Tabs** lists; one save applies a changed
    author, a moved owner block, and a changed **Notify at**, the window stays open, and the toast
    shows; an invalid shortcut saved from **Agents**, with **Pull requests** scrolled past the
    field, switches to **Pull requests** with the field in view, marked, and focused, and writes
    nothing; a save with a locked key (`gsettings` lock through a keyfile `locks` directory)
    writes nothing and shows the refused-write toast; the banner's **Save** is insensitive while
    **Discover accounts** runs; a **Discover accounts** answer that lands while **Agents** is shown
    moves no focus; a narrow window shows Adwaita's bottom switcher. Screenshots of each, and no
    `JS ERROR` or `JS WARNING` in the log.
  - `scripts/screenshots.sh` captures each tab: `preferences.png` stays the **Pull requests**
    tab; `preferences-agents.png` and `preferences-about.png` are new; README.md shows them.
- **Technical notes**:
  - GNOME Shell's preferences window (`extensionPrefsDialog.js` in GNOME Shell 49 and 50)
    requires a `visible_page` after `fillPreferencesWindow()` returns, so the pages go through
    `window.add()`; replacing the window's content fails to load.
  - `src/prefs.js` builds one `Adw.PreferencesPage` today and adds every group to it, the save
    group and the about group re-added after the owner blocks by `renderOwners()`; with tabs,
    `renderOwners()` lays out the **Pull requests** page only, and the save group goes away.
  - The banner's button and `Ctrl+S` both go through one `Gio.SimpleAction` (`save`, in a `prefs`
    action group inserted on the window); its `enabled` property is the button's sensitivity.
    `Adw.Banner` is a `Gtk.Actionable`. `Ctrl+S` is a `Gtk.ShortcutController` on the window,
    scope `managed`, activating `prefs.save`.
  - `Adw.PreferencesPage` takes an `icon-name` only: add the extension directory to the icon
    theme with `Gtk.IconTheme.get_for_display(window.get_display()).add_search_path(this.path)`
    so `greenlight-pr-symbolic` resolves from `src/greenlight-pr-symbolic.svg`.
  - Each save takes a fresh `this.getSettings()` and calls `delay()` on it; AGENTS.md warns that
    `delay()` is permanent, so that object is never used after its `apply()` or `revert()`. Each
    `set_*` returns `false` for a refused write: revert then.
  - **Notify at** is an `Adw.SpinRow`: call its `update()` before reading its value.
  - ORD's `focusLater()` checks the target's root; it also needs **Pull requests** to be the
    window's `visible_page`, and `notify::visible-page` cancels the pending move.

### TAB-P2: unsaved changes and the close dialog

- **Scope**: **Unsaved changes**, **Closing**, and the parts of **Save** that TAB-P1 left out:
  the banner shown only with unsaved changes and its title, a save that writes only the changed
  settings and the pending normalizations, and the baseline after a save and after a check. The
  PRM, QTA, and ORD lines TAB-P1 rewrote with its restrictions are updated to the final behavior,
  ORD's included: **Cancel** keeps unsaved moves, **Discard** drops them.
- **Prototype first** (throwaway): in the headless GNOME Shell, a `close-request` handler that
  returns `true`, holds the application (`Gio.Application.get_default().hold()`) while an
  `Adw.AlertDialog` is open, and releases it when the dialog answers. GNOME Shell's own handler
  runs first and forgets the window, so check: after **Cancel**, the window stays usable for 60
  seconds (longer than the service's inactivity timeout), a second **Preferences…** from the
  menu meanwhile does not open a second window or does no harm, and closing again shows the
  dialog again; after **Discard**, the window closes and the service exits as usual. Pass: all
  of these hold on GNOME Shell 49. Fail: closing with unsaved changes discards them without a
  dialog, as before TAB, the **Closing** rules on the dialog are left out, and the PR says so for
  the owner to decide.
- **Acceptance**:
  - Unit tests (`node --test`) for the pure comparison: author trimming; the three shortcut
    classes, equivalence, and an invalid stored value that opens clean; an owner configuration
    equal after a **Discover** that changed only a spelling, a move and a move back, a completed
    order on open (missing and stale logins) that is clean, a paused owner, a mode change that
    keeps the stored scope and one between **All except…** and **Only…**; the pending
    normalizations; the banner and dialog texts for one, two, and three tabs.
  - In the headless GNOME Shell: a changed author shows the banner on every tab and its title
    names **Pull requests**; typing it back hides it; a changed **Notify at** adds **Agents** to
    the title; typing `83` in **Notify at** and pressing `Ctrl+S` with the focus still in it saves
    83; an external `gsettings set` of the author followed by an **Agents**-only save keeps the
    external author; an unavailable provider whose check turns its switch off shows no banner,
    and the next save stores it off; closing with changes shows the dialog, **Cancel** keeps them
    (an owner move included), **Discard** closes without writing (checked with `gsettings` on the
    keyfile), **Save** writes and closes; a dialog opened with **Agents** only unsaved updates its
    body when a **Discover accounts** answer adds an owner. Screenshots, and no `JS ERROR` or
    `JS WARNING` in the log.
  - `scripts/screenshots.sh` regenerates the three preferences captures, and README.md follows.
  - `npm run lint` and `make check` pass.
- **Technical notes**:
  - Put the comparison in a pure module, next to `src/order.js`, which already holds the unsaved
    row order: it takes the shown values (the shortcut already classified in GJS, since
    `Gtk.accelerator_parse` is GTK) and the baselines, and returns the tabs with changes and the
    keys to write. `ownerFiltersToSave()` in `src/filters.js` already returns `null` when the
    owners would be saved as they are; check that it compares names case-insensitively and keeps
    the stored spelling, and make it do so.
  - Recompute the banner on every change signal of the rows (`changed`, `notify::selected`,
    `notify::active`, `notify::value`, and the **Notify at** text) and after every owner block
    change (`renderOwners()`, `fillOwnerGroup()`, a move, a trash icon).
  - The running tasks are cancelled at the final close only, no longer in every `close-request`.
