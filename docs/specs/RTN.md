---
code: RTN
status: draft
version: v1.6
created: 2026-11-24
builds-on: TAB
tracking: "#59"
---

# Greenlight — RTN specification

RTN shows the routines that run on this computer, the user's systemd timers, in the Greenlight
menu next to the pull requests and the agent quotas: when each one last ran, whether that run
succeeded, and when it runs next. It notifies a failed run, marks the panel indicator while a
watched routine is failed, and lets the user run a routine now or read its logs. The user picks
the routines to watch in a new **Routines** tab of the preferences. It builds on TAB, PRM, QOP,
and QTA, whose rules all still apply except three it changes, which RTN-P1 rewrites in those
specs: TAB's list of tabs (a **Routines** tab before **About**), PRM's menu order and QOP's menu
height (a **Routines** section after the agent quotas section, which stays in view), and PRM's
panel indicator (a red dot while a watched routine is failed, RTN-P3). The mockup is
[`mockups/RTN.html`](mockups/RTN.html).

## Scope

- A routine is a timer unit of the user's systemd instance (`systemctl --user`), with the service
  it activates. System timers (`systemctl` without `--user`), services without a timer, cron,
  and timers of other users are out of scope.
- Greenlight reads systemd through its D-Bus API on the session bus, never by parsing
  `systemctl` output. It never creates, edits, enables, disables, or stops a unit: its only write
  is **Run now**, which starts the routine's service once.
- Nothing is watched by default. With no watched routine, Greenlight makes no systemd call
  outside the preferences window.

## Reading systemd

- The bus name is `org.freedesktop.systemd1` on the session bus, object
  `/org/freedesktop/systemd1`, interface `org.freedesktop.systemd1.Manager`.
- The timers are the units that `ListUnitsByPatterns([], ['*.timer'])` returns: every timer the
  user instance has loaded, active or not. A timer file that is not loaded (never enabled nor
  started) is not listed.
- A routine's name is its timer unit name without `.timer` (`nightly-report`); its description is
  the timer's `Description`.
- From the timer (`org.freedesktop.systemd1.Timer`): `Unit` (the service it activates),
  `NextElapseUSecRealtime`, `NextElapseUSecMonotonic`, and `LastTriggerUSec`; from its unit
  interface, `ActiveState`.
- From the service (`org.freedesktop.systemd1.Service` and `Unit`): `ActiveState`, `Result`,
  `ExecMainStatus`, `ExecMainCode`, and `InactiveEnterTimestamp`.
- **Next run**: `NextElapseUSecRealtime` when it is not 0; otherwise, when
  `NextElapseUSecMonotonic` is not 0, now plus its distance from the current monotonic time;
  otherwise none, which reads `not scheduled`. A timer whose `ActiveState` is not `active`
  has no next run either.
- **Last run**: `LastTriggerUSec`; 0 means the routine never ran, which reads `never ran`.
- **State** of a routine, from its service:
  - **Running** when the service's `ActiveState` is `activating`, `active`, `reloading`, or
    `deactivating`.
  - otherwise **Failed** when its `ActiveState` is `failed`;
  - otherwise **Never ran** when the last run is none;
  - otherwise **Succeeded**.
- The **cause** of a failure, from the service's `Result`: `exit-code` reads `exit code <N>`
  (`ExecMainStatus`); `signal` and `core-dump` read `killed by signal <N>` (`ExecMainStatus`);
  `timeout` reads `timed out`; `oom-kill` reads `out of memory`; `start-limit-hit` reads
  `start limit hit`; any other value reads as itself.
- A failure stays **Failed** until systemd clears it: the next run, a manual start, or
  `systemctl --user reset-failed`. Greenlight never clears it.
- Updates: once at least one routine is watched, Greenlight calls the manager's `Subscribe()`,
  listens to `PropertiesChanged` on the object paths of the watched timers and their services,
  and to the manager's `UnitNew`, `UnitRemoved`, and `Reloading`, and re-reads the watched
  routines on each, at most once per second. It also re-reads them when the menu opens. It
  calls `Unsubscribe()` when the last routine stops being watched, and when the extension is
  disabled.
- Every D-Bus call has a 5-second timeout. A failed read keeps the last state of each routine,
  dimmed, as QTA does for a quota.

## Preferences

- A **Routines** tab, between **Agents** and **About**, uses the `alarm-symbolic` icon. It holds
  one **Routines** group, described `Show your systemd user timers in the menu. Greenlight reads
  them from systemd and never changes a unit.` (PREFS-ROUTINES)
- Opening the window lists the timers, sorted by name, one switch row each: the title is the
  routine's name, the subtitle its description, then ` · next <time>` with the next run as the
  menu shows it. While the list loads, the group shows one row `Reading systemd timers…`.
- A switch on means watched. The watched routines are stored in `watched-routines`, a list of
  timer unit names (`nightly-report.timer`), on **Save** as TAB says; the **Routines** tab has
  unsaved changes when the set of switches on differs from the stored list, whatever the order.
- A stored timer that the list does not return keeps a row, its switch on, subtitled
  `Not loaded by systemd`, so it can be switched off. (PREFS-ROUTINES)
- No timer at all: one row, `No systemd user timers`, subtitled
  `Create one with systemctl --user, then reopen Preferences.` (PREFS-EMPTY)
- systemd unreachable (no `org.freedesktop.systemd1` on the session bus, or a failed call): one
  row, `Could not read systemd timers`, subtitled with the D-Bus error message; stored routines
  keep their rows, switches on, subtitled `Stored; not read from systemd`, so a save keeps them.
  (PREFS-ERROR)
- The list is read once per window; there is no refresh button.

## Menu

- A **Routines** section sits below the agent quotas section, or below the pull request list
  when that section is absent, and above **Preferences…**, with a separator above it. It shows
  when at least one routine is watched, and hides while quick open has text, as the quota
  section does. It does not scroll: on a short screen the pull request list gives way, as QOP's
  menu height says. (MENU-ROUTINES, MENU-TYPING)
- A heading reads `Routines`, then one row per watched routine, sorted by name. A watched
  routine whose timer is no longer loaded is left out of the menu.
- Each row holds, from left to right: a status icon, the name, the status text, the next run,
  and two icon buttons, **Run now** and **View logs**. (MENU-ROUTINES)
  - **Succeeded**: a green check (`#26a269`) and `ran <age>`.
  - **Failed**: a red cross (`#c01c28`) and `failed <age> · <cause>`, in red. (MENU-FAILED)
  - **Running**: a yellow dot (`#e5a50a`) and `running since <time>`.
  - **Never ran**: a grey dash (`#77767b`) and `never ran`.
  - The next run reads `next in <duration>` under a day away, else `next <weekday> <HH:MM>`, or
    `not scheduled`. Ages read as ORD's ages do (`now`, `12 min`, `5 h`, `3 d`, then a date),
    followed by ` ago`, except a date.
- Times use the local time zone and 24-hour `HH:MM`. They are computed when the section renders:
  on each re-read and each time the menu opens.
- The row's accessible name reads `<name>, <status text>, <next run>`.
- A failed read dims every row and adds a dimmed line under the heading:
  `Could not read systemd: <cause>`.
- A click on a row opens nothing. The section has no **Updated** line.

## Run now

- **Run now** (`media-playback-start-symbolic`, accessible name `Run <name> now`) calls the
  manager's `StartUnit(<service>, 'replace')`. The menu stays open. (MENU-RUNNING)
- It is insensitive while the routine is **Running**.
- The row turns **Running** from the re-read that follows. When the call fails, the row shows a
  dimmed line under it, `Could not start <name>: <D-Bus error message>`, until the next
  successful start or the menu closes.
- Starting the service does not move the timer's next run; systemd decides that.

## View logs

- **View logs** (`utilities-terminal-symbolic`, accessible name `View <name> logs`) opens a
  terminal that runs `journalctl --user -u <service> -e`, which opens the pager at the end of
  the routine's logs. The menu closes. (MENU-FAILED)
- The terminal is the first one found in `PATH`: `xdg-terminal-exec <command…>`, then
  `ptyxis -- <command…>`, `kgx -- <command…>`, `gnome-terminal -- <command…>`. Every command is an
  argument array, never a shell string.
- No terminal found: the row shows a dimmed line under it,
  `No terminal found. Run: journalctl --user -u <service> -e`, until the menu closes.

## Failure notifications

- A watched routine that turns **Failed** notifies once: the title `<name> failed`, the body
  `<cause> · <HH:MM>`, the time being the service's `InactiveEnterTimestamp`. (NOTIF)
- A failed run is identified by its routine and its `InactiveEnterTimestamp`, so a re-read does
  not notify it twice, and a later failed run notifies again.
- When the extension starts, and when a routine starts being watched, its current state is a
  quiet baseline: a routine already **Failed** does not notify. A restart of the extension or
  the session sets a new baseline; nothing is stored.
- Clicking the notification opens the logs, as **View logs** does.
- A failed read never notifies.

## Panel indicator

- While at least one watched routine is **Failed**, a red dot (`#c01c28`, 6 px) sits on the top
  right corner of the panel icon, and the indicator's accessible name reads
  `Greenlight, a routine failed`. (MENU-FAILED)
- The dot follows the state: it goes away once no watched routine is **Failed** (a successful
  run, `reset-failed`, or the routine no longer watched). Opening the menu does not clear it.
- The `PR <n>` label and PRM's `PR !` are unchanged. A failed read keeps the dot as it was.

## Out of scope

- System timers, services without a timer, and routines from other schedulers (cron, at).
- Creating, editing, enabling, disabling, or stopping a unit, and `reset-failed`.
- Reading or showing log lines inside Greenlight.
- A setting to turn the failure notifications or the dot off.

## Plans

### RTN-P1: watched routines in the menu

- **Depends on**: TAB merged (TAB-P1 and TAB-P2), since the **Routines** tab and its unsaved
  changes use TAB's tabs and **Save**.
- **Scope**: **Scope**, **Reading systemd**, **Preferences**, and **Menu**, without the two
  buttons. The TAB, PRM, and QOP rules RTN changes are rewritten in those specs (the **Routines**
  tab, the menu order, the menu height), each with `v1.6` in `amended`. README.md describes the
  routines.
- **Temporary restrictions**: no **Run now** or **View logs** button (RTN-P2); no notification and
  no panel dot (RTN-P3).
- **Prototype first** (throwaway): from GJS in the user's real session, call
  `ListUnitsByPatterns`, read the properties above for one timer and its service, `Subscribe()`,
  and receive a `PropertiesChanged` when the service is started with `systemctl --user start`.
  Pass: every property reads with the types above and the signal arrives within 2 seconds. Fail:
  without the signal, re-read the watched routines every 30 seconds and when the menu opens, and
  say so in the PR.
- **Acceptance**:
  - Unit tests (`node --test`) for a pure `src/routines.js`: the state from each
    `ActiveState`/`Result` pair, each cause text, the next run from the realtime value, the
    monotonic value, and neither, the age and next-run texts across a day and a week, the sort,
    and the accessible name.
  - In the headless GNOME Shell, against a mock `org.freedesktop.systemd1` on its private bus
    (see the technical notes) with one succeeded, one failed, one running, and one never-run
    timer: the **Routines** tab lists them, a switch saved through TAB's **Save** stores
    `watched-routines`, the menu shows the four rows with their texts, typing in quick open hides
    the section, a property change on the mock updates the row within 2 seconds, and stopping the
    mock dims the rows with the cause. Screenshots, and no `JS ERROR` or `JS WARNING` in the
    log.
  - `scripts/screenshots.sh` runs the same mock with fictional timers; `menu.png` shows the
    section, and a new `preferences-routines.png` the tab.
  - `npm run lint` and `make check` pass.
- **Technical notes**:
  - The private `dbus-run-session` of the headless shell has no systemd, so the tests and the
    screenshots run a mock: a small script under `scripts/screenshots/` that owns
    `org.freedesktop.systemd1` on that bus and serves the manager and unit interfaces above from
    a JSON fixture, written with `Gio` (in GJS, or in `python3` with `gi.repository.Gio`, so no
    new dependency), and can change a property and emit `PropertiesChanged` on request.
  - `Gio.DBusProxy` per unit, created with `Gio.DBusProxyFlags.DO_NOT_AUTO_START` so a session
    without systemd fails fast; the unit object path comes from `ListUnitsByPatterns`, or from
    the manager's `GetUnit` for the service.
  - `GLib.get_monotonic_time()` is `CLOCK_MONOTONIC` in microseconds, the clock of
    `NextElapseUSecMonotonic`.
  - Keep the parsing and texts in `src/routines.js`, which imports nothing from `gi://`, as
    AGENTS.md asks; the D-Bus client goes in its own module shared by the extension and the
    preferences, as `src/agents.js` is for the quota CLIs.
  - The new key `watched-routines` (`as`, default `[]`) goes in the GSettings schema.

### RTN-P2: Run now and View logs

- **Scope**: **Run now** and **View logs**.
- **Acceptance**:
  - Unit tests for the terminal choice (each candidate missing in turn, none found) and the
    argument arrays.
  - In the headless GNOME Shell with the mock: **Run now** calls `StartUnit` with the service
    and `replace` (the mock logs the call), turns the row **Running**, and is insensitive while
    it runs; a mock that answers an error shows the `Could not start` line; **View logs** starts
    the first terminal of a scratch `PATH` holding stub terminals that log their arguments, and
    with none, shows the `No terminal found` line. Screenshots, and no `JS ERROR` or
    `JS WARNING` in the log.
  - `npm run lint` and `make check` pass.
- **Technical notes**: start the terminal with `Gio.Subprocess` and an argument array, with the
  extension's lookup in `PATH` (and `~/.local/bin`, as `findCli` does in `src/agents.js`).

### RTN-P3: failure notifications and the panel dot

- **Scope**: **Failure notifications** and **Panel indicator**.
- **Acceptance**:
  - Unit tests for the run identity, the baseline at start and when a routine starts being
    watched, a second failed run, and the dot from a set of states.
  - In the headless GNOME Shell with the mock: a routine already failed at start shows the dot
    and does not notify; a watched routine that turns failed notifies once with its title and
    body, and a re-read does not notify again; clicking the notification starts the logs
    terminal stub; a successful run removes the dot; the indicator's accessible name follows.
    Screenshots, and no `JS ERROR` or `JS WARNING` in the log.
  - `npm run lint` and `make check` pass.
- **Technical notes**:
  - A `MessageTray.Notification` on Greenlight's own source, whose `activated` signal opens the
    logs; `Main.notify` cannot carry the action.
  - The dot is a small `St.Widget` over the panel icon, in a `St.Widget` with a
    `Clutter.BinLayout`, aligned to the top right, hidden when no watched routine is **Failed**.
