---
code: ORD
status: draft
version: v1.4
created: 2026-11-19
builds-on: QOP
tracking: "#47"
---

# Greenlight — ORD specification

ORD covers the order of what the menu lists: the quick open suggestions for a number, newest
activity first, so a pull request merged a minute ago is the first suggestion; and the order of
the owner sections in the pull request list, which the user can fix in the preferences. It builds
on QOP and PRM, whose rules all still apply except two it replaces: QOP's order of the suggestions
once the number lookup answered (**Quick open** section, the ranking rule as it applies to looked
up suggestions), and PRM's order of the owner sections (**Menu** section, `ordered by each owner's
newest pull request`), which becomes the default of a setting. The mockup is
[`mockups/ORD.html`](mockups/ORD.html).

## Quick open order

- When QOP's number lookup answers for several candidates, the repositories that hold the number
  are listed by the last activity of that issue or pull request, newest first: its GitHub
  `updatedAt`, the last-updated time, which a merge or a new comment normally moves. ORD sorts by
  that value as GitHub returns it, and promises nothing about which events move it. (QO-NEWEST)
- The order is taken over every candidate the lookup checked (QOP's 20 best ranked), then cut to
  the five suggestions QOP shows, so the newest among them is listed even when its repository
  ranks low. A repository ranked past those 20 is not checked, as in QOP.
- An exact repository match comes first, whatever its age: a candidate whose full name
  (`acme/web#42`) or name (`web 42`) equals the typed repository text, case-insensitively. Only a
  non-empty repository text has exact matches: `#184` has none. Several exact matches (`web 42`
  with `acme/web` and `octocat/web`) are ordered among themselves by recency. The other
  candidates follow, by recency.
- Otherwise recency wins over QOP's repository ranking: with `184`, `acme 184`, or `plat 184`, the
  newest matching issue or pull request comes first. Two equal `updatedAt` keep QOP's ranking
  order.
- The lookup reads `updatedAt` in its existing single `gh api graphql` request, on both `Issue`
  and `PullRequest`; it makes no extra request. The 60-second cache keeps it with the title.
- **Enter** opens the first suggestion and the preview targets it by default, as in QOP: both
  follow ORD's order, so they land on the exact match when there is one, else on the newest.
- Unchanged from QOP: a single candidate skips the lookup and keeps no age; a failed lookup lists
  the unfiltered candidates in QOP's ranking order, without ages (QO-FAILED); a pasted URL has one
  suggestion; the preview sits directly under its target suggestion; `Looking up #<n> in <count> repositories…`
  shows while the lookup runs, with Enter doing nothing (QO-LOADING).

## Age

- A looked up suggestion shows the age of its last activity, dimmed, between its title and its
  `#number` badge. (QO-NEWEST)
- The age reads, from the time the suggestions render: `now` under one minute; `<n> min` under
  one hour; `<n> h` under one day; `<n> d` under 30 days; then the date in the local time zone,
  `Sep 2` within the current year and `Mar 4, 2025` before it. Values round down. English month
  abbreviations, whatever the locale, like the rest of the UI.
- A date in the future, from clock skew, reads `now`. A missing or unparsable `updatedAt` shows no
  age and sorts after every dated suggestion of its group (exact matches, then the others), in
  QOP's ranking order: an exact match without a date still comes before every other candidate.
- The age does not tick while the menu stays open: it is computed when the suggestions render,
  which typing and a lookup answer do. A pull request refresh does not re-render the suggestions,
  so it leaves the ages as they are.
- The suggestion's accessible name adds the age: `Open acme/web #184, updated now`,
  `…, updated 12 min ago` (the same for `h` and `d`), or `…, updated Sep 2` for a date.

## Owner order in the menu

- **Order owners by** has two values:
  - **Newest pull request** (the default): the owner sections are ordered by each owner's newest
    pull request, as PRM had it. (MENU-ACTIVITY)
  - **Custom order**: the owner sections follow the order set in the preferences. (MENU-CUSTOM)
- In **Custom order**, an owner section whose login (case-insensitive) is not in the saved order
  comes after the ordered ones, those among themselves by newest pull request; the
  `Unknown owner` section, for a pull request without an owner, comes last.
- An owner with no open pull request has no section, in either mode, as in PRM.
- Pull requests inside a section keep PRM's order, by last update; the count in each heading is
  unchanged.
- A save that changes only the order or the mode re-sorts the list from the pull requests already
  loaded, without a `gh` call. A save that also changes what PRM refreshes for (owners,
  repositories, author) refreshes once, as PRM says, and the new order applies to its result.
  The menu can be reopened while the preferences window stays open; a re-sort keeps an open
  preview under its pull request, as a refresh does in QOP. Changing both keys in one save may
  re-sort twice, which is harmless.

## Owner order preferences

- A **Menu order** group sits between **Monitoring** and **Quick open**, described
  `The order of the owner sections in the pull request list.` (PREFS-CUSTOM)
- Its first row is **Order owners by**, a combo with **Newest pull request** and **Custom order**.
  Its subtitle reads `Newest pull request first moves an owner up with each update` in the first
  mode and `Owners without open pull requests take no room in the menu` in the second.
- Below it, one row per configured owner, enabled or paused, titled with its login and subtitled
  with its kind as the owner block names it (`Personal account`, `Organization`, `GitHub owner`),
  plus ` · Paused` for a paused owner, whose title is not dimmed in **Custom order** (in
  **Newest pull request** every owner row is insensitive, so all are dimmed alike). Each row ends with a move-up and a move-down button, with
  the accessible names `Move <login> up` and `Move <login> down`. The first row's up and the last
  row's down are insensitive.
- In **Newest pull request**, the owner rows stay visible but insensitive, so the saved custom
  order shows and survives a switch back. (PREFS-ACTIVITY)
- With no owner configured, a single dimmed row reads `Owners you add below appear here.`
  (PREFS-EMPTY)
- The list starts from the saved order. Owners configured but missing from it (an owner from
  before ORD, or one added since) follow, in the order of their blocks.
- The list follows the owner blocks live in the window: an owner added with **Add** or
  **Discover accounts** joins the end of the list; an owner removed with its trash icon leaves
  it; pausing or resuming updates its subtitle. Adding or removing an owner never reorders the
  others.
- As with every setting, nothing applies before **Save preferences**, which stores the mode and
  the list of every configured owner's login in its displayed order. Closing the window without
  saving drops the changes.
- Keyboard: the buttons are focusable in the row order; moving a row keeps the focus on the
  button just used, on the row's new position, unless that button became insensitive, in which
  case the focus goes to the row's other button.

## Storage

- `owner-order-mode` (`s`, `'newest'` or `'custom'`, default `'newest'`). Any other value reads
  as `'newest'`.
- `owner-order` (`as`, default `[]`): owner logins, in order. Reading it ignores non-string
  entries and duplicates (case-insensitive), keeping the first.
- Existing installations keep their current menu order until the user picks **Custom order**.

## Out of scope

- Reordering repositories inside an owner section, or pull requests inside a section.
- Drag and drop in the preferences; the buttons are the only way to reorder.
- Sorting quick open suggestions without a number, which make no lookup and have no date.
- Changing the order of the owner blocks in the preferences themselves (PRM's rules stay).

## Plans

### ORD-P1: Newest activity first in quick open

- **Scope**: **Quick open order** and **Age**.
- **Temporary restrictions**: none.
- **Acceptance**:
  - `npm run lint` and `make check` pass.
  - `tests/` cover, through pure functions: `lookupArguments` asking `updatedAt` on `Issue` and
    `PullRequest`; `parseLookupResponse` returning it (and `null` when absent); the order of found
    candidates (newest first, ties and missing dates in ranking order, the cut to five after the
    sort, a low-ranked newest candidate kept); and the age text at each boundary (59 s, 60 s,
    59 min, 1 h, 23 h, 1 d, 29 d, 30 d, the year change, a future date, an invalid date).
  - In a headless GNOME Shell with the fixture `gh` of `scripts/screenshots/` answering
    `updatedAt`, extended so one number exists in at least three repositories whose dates reverse
    their ranking order: typing that number lists them newest first with their ages, the preview
    shows the newest one before Enter is pressed, and Enter opens it. Greenlight opens URLs with
    `Gio.AppInfo.launch_default_for_uri`, so the scratch `XDG_DATA_HOME` registers a desktop
    entry that appends its URI to a log file, set as the `x-scheme-handler/https` default in the
    scratch `XDG_CONFIG_HOME/mimeapps.list`; the test reads that log for the expected URL, and no
    browser starts. With `acme/web` and `acme/web-client` both holding a number, the latter
    newer, typing `acme/web#<n>` lists both and keeps `acme/web` first. A lookup made to fail (a
    fixture switch that makes `gh api graphql` exit 1 with no output), for a number not looked up
    before so the 60-second cache cannot answer, lists the candidates in ranking order without
    ages, and the fixture log shows the failed call; no `JS ERROR` or `JS WARNING` in the shell log.
  - `scripts/screenshots.sh` types that number for `quick-open.png`, which shows the ages.
  - README.md describes the order, and QOP's ranking rule says that looked up suggestions follow
    ORD's order, with v1.4 added to QOP's `amended`, in the same PR.
- **Technical notes**:
  - `src/preview.js`: add `updatedAt` to both fragments of `lookupArguments`, and return it from
    `parseLookupResponse`.
  - `src/quickopen.js` (pure): add the sort of looked-up suggestions and the age formatter, with
    the current time passed in, so tests fix it.
  - `src/extension.js` `_lookupSuggestions`: store `updatedAt` in `_lookupCache`, sort the found
    candidates before `_renderQuickOpen` cuts to `MAX_SUGGESTIONS`; `_renderQuickOpen` adds a
    dimmed age label before the badge and extends `accessible_name`.
  - `scripts/screenshots/gh`: return a fictional `updatedAt` in the lookup answer, computed from
    the current time (now minus 12 minutes, 5 hours, and 3 days), so the ages show their relative
    forms and `quick-open.png` stays the same from one run to the next; the pull request search
    keeps its fixed dates. Add the shared number, `acme/web-client` with the overlapping number,
    the failure switch, and a log of every invocation.

### ORD-P2: Owner order in the menu and the preferences

- **Scope**: **Owner order in the menu**, **Owner order preferences**, and **Storage**.
- **Temporary restrictions**: none.
- **Acceptance**:
  - `npm run lint` and `make check` pass; the schema compiles with both new keys.
  - `tests/` cover, through pure functions: reading `owner-order` (non-strings, duplicates,
    case); the initial list of the preferences from the saved order and the configured owners
    (missing ones appended in block order, unknown ones dropped); and the order of the owner
    sections in both modes (listed owners, unlisted ones by newest pull request, `Unknown owner`
    last, ties).
  - In a headless GNOME Shell with the fixture `gh`: with two owners, the default mode lists them
    by newest pull request; saving only **Custom order** with the other one first re-sorts the
    list without any `gh` invocation, which the fixture `gh` proves by appending each invocation
    to a log file the test reads, with the refresh interval at 10 minutes, the log's length taken
    once the first refresh finished, and read again 2 seconds after the save (past the filter
    refresh delay); switching back restores the activity order and keeps the custom
    list in the preferences.
  - The preferences window is a separate process the shell's Eval cannot reach, so: the row
    order after each move, add, remove, and pause, and the button that takes the focus after a
    move, are pure functions covered by `node --test`; in the headless shell, the window is driven
    with the virtual keyboard (Tab to a button, Enter) and checked on screenshots. Through those:
    up and down move rows; the first up and last down are insensitive; the focus ring sits on the
    expected button after a move in the middle and after a move that makes the used button
    insensitive; after a move, adding an owner appends it without undoing the move, removing one
    keeps the others' order, pausing updates its subtitle, and switching the mode back and forth
    keeps the moves; closing without saving keeps the stored order; no `JS ERROR` or
    `JS WARNING` in the shell log.
  - `scripts/screenshots.sh` seeds `owner-order-mode` to `'custom'`, makes the window tall enough
    to keep the first owner block in view under the new group, and regenerates `preferences.png`
    with the **Menu order** group; README.md's alt text for that image names the group;
    README.md describes the setting, and PRM's menu rule says the section order follows ORD, with
    v1.4 added to PRM's `amended`, in the same PR.
- **Technical notes**:
  - `src/schemas/`: add `owner-order-mode` and `owner-order`.
  - Move the section ordering of `groupPullRequestsByOwner` (`src/extension.js`) into a pure
    module (`src/filters.js` or a new one) that takes the mode and the order, so `node --test`
    covers it. Re-render the content section on `changed::owner-order` and
    `changed::owner-order-mode`, not `menu.removeAll()` (AGENTS.md).
  - `src/prefs.js`: the new group goes between `monitoringGroup` and `quickOpenGroup`. Keep the
    unsaved row order in its own list of keys, separate from the `owners` map, whose order is the
    block order (**Add** puts a block first): an added owner is appended to that list, a removed
    one taken out, and the rows rebuilt from it with each owner's state from the map. Write both
    keys inside the existing save handler's `delay()`/`apply()` batch, on the preferences'
    own settings object, so the Shell sees one change (AGENTS.md forbids `delay()` only on the
    extension's object).
  - The save handler writes each key only when its value differs from the stored one. Today it
    writes `author-filter` and the others on every save, and the Shell refreshes on
    `changed::author-filter` without comparing values, so an order-only save would still call
    `gh`.
  - `Adw.PreferencesGroup` has only `add` and `remove`: a move rebuilds the group's owner rows
    from the list, then focuses the target button from `GLib.idle_add`, since a button
    removed and added again in the same tick may refuse the focus. Set each icon button's
    accessible name with `update_property([Gtk.AccessibleProperty.LABEL], [...])` and give it the
    same text as its tooltip.
