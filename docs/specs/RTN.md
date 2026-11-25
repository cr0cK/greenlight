---
code: RTN
status: active
version: v1.6
created: 2026-11-24
builds-on: TAB
tracking: "#59"
---

# Greenlight — RTN specification

RTN shows the routines that run on this computer, the user's systemd timers, in the Greenlight
menu next to the pull requests and the agent quotas: how each one's last run ended and when it
runs next. It notifies a failed run, marks the panel indicator while a watched routine is
failed, and lets the user run a routine now or read its logs. The user picks the routines to
watch in a new **Routines** tab of the preferences. It builds on TAB, PRM, QOP, and QTA, whose
rules all still apply except the ones it changes: TAB's list of tabs and its banner text naming the
unsaved tabs (a **Routines** tab before **About**), PRM's menu order, QTA's separators, and QOP's
menu height (a **Routines** section after the agent quotas section, which stays in view), all
rewritten by RTN-P1; and PRM's panel indicator (a red dot while a watched routine is failed),
rewritten by RTN-P3. The mockup is [`mockups/RTN.html`](mockups/RTN.html).

## Scope

- A routine is a timer unit of the user's systemd instance (`systemctl --user`) that activates a
  `.service` unit. System timers (`systemctl` without `--user`), timers that activate another
  kind of unit, services without a timer, cron, and timers of other users are out of scope.
- Greenlight reads systemd through its D-Bus API on the session bus, never by parsing
  `systemctl` output. It never creates, edits, enables, disables, or stops a unit: its only write
  is **Run now**, which asks systemd for one start of the routine's service, under the unit's own
  dependency, conflict, and restart rules.
- Nothing is watched by default. With no watched routine, Greenlight makes no systemd call
  outside the preferences window.
- systemd keeps a routine's history in memory: after the user's systemd instance restarts (a new
  login without lingering), a routine shows **No run recorded** until it runs.

## Reading systemd

- The bus name is `org.freedesktop.systemd1` on the session bus, object
  `/org/freedesktop/systemd1`, interface `org.freedesktop.systemd1.Manager`. Every call is
  asynchronous and has a 5-second timeout, except **Run now**'s `StartUnit`, which has 30
  seconds.
- Greenlight talks to systemd over its own connection to the session bus, opened when the first
  routine is watched and closed when the last one stops being watched or the extension is
  disabled, not over GNOME Shell's shared one: systemd counts subscribers by bus name, so a
  connection of its own keeps Greenlight's `Subscribe()` and `Unsubscribe()` from touching other
  code's, and closing it ends the subscription.
- The timers are the units that `ListUnitsByPatterns([], ['*.timer'])` returns (every timer the
  user instance has loaded, active or not) whose `Timer.Unit` ends with `.service`. A timer file
  that is not loaded is not listed.
- A routine's name is its timer unit name without `.timer` (`nightly-report`); its description is
  the timer's `Description`.
- Properties are read with `org.freedesktop.DBus.Properties.GetAll`, once per interface:
  - the timer (`org.freedesktop.systemd1.Timer`): `Unit`, `NextElapseUSecRealtime`,
    `NextElapseUSecMonotonic`, `LastTriggerUSec`, and `Result`; its `Unit` interface:
    `ActiveState`, `StateChangeTimestamp`, and `StateChangeTimestampMonotonic`;
  - the service, whose object path comes from the manager's `GetUnit(<Timer.Unit>)`
    (`org.freedesktop.systemd1.Service`): `Result`, `ExecMainCode`, `ExecMainStatus`,
    `ExecMainStartTimestamp`, and `ExecMainExitTimestamp`; its `Unit` interface: `ActiveState`,
    `SubState`, `InactiveExitTimestamp`, `StateChangeTimestamp`,
    `StateChangeTimestampMonotonic`, `ConditionResult`, and `ConditionTimestamp`.
- Only systemd's `org.freedesktop.systemd1.NoSuchUnit` answer to the service's `GetUnit` marks
  that routine **Service not loaded**: its row reads `service not loaded`, with no button, and it
  never counts as failed. Any other error systemd or the bus returns to that `GetUnit` (a
  timeout, access denied, another bus error) is a failed read of that routine, as **Updates**
  says. A lost connection fails the read as a whole.

### Next run

- `NextElapseUSecRealtime` and `NextElapseUSecMonotonic` are each unset when they are 0 or
  2^64 − 1. A set monotonic value converts to a date as now plus its distance from the current
  monotonic time. The next run is the earlier of the set values; with none, or when the timer's
  `ActiveState` is not `active`, the routine is not scheduled, which reads `not scheduled`.
- A next run at or before now reads `next now` (the timer has elapsed and systemd has not set the
  next one yet). A **Running** routine shows no next run: its row reads `running since <HH:MM>`
  only.
- Greenlight leaves the schedule to systemd: a manual start can move the next run (a timer with
  `OnUnitActiveSec=` or `OnUnitInactiveSec=`), and the row shows the value systemd reports on the
  next read.

### State

A routine's state is the first of these that applies, from its timer and its service:

1. **Failed** when the service's `ActiveState` is `failed`, or the timer's `Result` is not
   `success` (systemd could not start the service).
2. **Running** when the service's `ActiveState` is `activating`, `deactivating`, or
   `reloading`, or it is `active` with a `SubState` other than `exited`. Its time is
   `InactiveExitTimestamp`.
3. **Skipped** when the service's `ConditionResult` is false and its `ConditionTimestamp` is
   later than its `ExecMainStartTimestamp`: the last start was skipped by a `Condition…=`.
4. **No run recorded** when `ExecMainStartTimestamp` is 0.
5. **Succeeded** when `ExecMainCode` is 1 (exited) and `ExecMainStatus` is 0, the service being
   `inactive`, or `active` with the `SubState` `exited` (`RemainAfterExit=yes`).
6. otherwise **Unknown**: a run ended without a failed state that Greenlight cannot read as a
   success, such as a failure cleared by `systemctl --user reset-failed`.

- The time of **Failed**, **Skipped**, **Succeeded**, and **Unknown** is the service's
  `StateChangeTimestamp`, or the timer's own `StateChangeTimestamp` for a timer failure.
- The **cause** of a failure:
  - a timer failure reads `timer failed: <Timer.Result>`;
  - `exit-code` with `ExecMainCode` 1 and a non-zero `ExecMainStatus` reads
    `exit code <ExecMainStatus>`;
  - `signal` or `core-dump` with `ExecMainCode` 2 or 3 reads
    `killed by signal <ExecMainStatus>`;
  - `exit-code`, `signal`, or `core-dump` otherwise (a failed `ExecStartPre=` or another control
    command) reads `a start command failed`;
  - `timeout` reads `timed out`; `oom-kill` reads `out of memory`; `start-limit-hit` reads
    `start limit hit`; any other value reads as itself.
- A failure stays **Failed** until systemd clears it: the next run, a manual start, or
  `systemctl --user reset-failed`. Greenlight never clears it.

### Updates

- Once at least one routine is watched, Greenlight watches the owner of
  `org.freedesktop.systemd1`. While it has one, Greenlight calls the manager's `Subscribe()`,
  listens to `PropertiesChanged` on the object paths of the watched timers and their services,
  and to the manager's `UnitNew`, `UnitRemoved`, `JobRemoved`, and `Reloading`. These manager
  signals concern every unit of the session, so only those whose unit (`UnitNew` and
  `UnitRemoved`'s id, `JobRemoved`'s unit) is a watched timer or its service count, and
  `Reloading` always does. After each signal that counts, Greenlight re-reads the watched
  routines only (not the whole timer list), at most once per second, with a trailing read for
  every signal that arrives during that second.
- It also re-reads them when the menu opens, and after `Reloading(false)` resolves the unit and
  service paths again.
- When the name loses its owner, every row turns stale (dimmed, see **Menu**). When it gets one
  back, Greenlight subscribes again, resolves the paths again, and re-reads. A reply that arrives
  after the owner changed or after the watched list changed is dropped.
- A `Subscribe()` error switches to the polling of RTN-P1's fallback, without marking rows
  stale. systemd sends `JobRemoved` to the caller of a job even without a subscription, so
  **Run now** works the same under that fallback.
- A failed read keeps the last state of the routines it concerned, marked stale. Only the
  routines whose read failed turn stale; the others stay as read.

## Preferences

- A **Routines** tab, between **Agents** and **About**, uses the `alarm-symbolic` icon. It holds
  one **Routines** group, described `Show your systemd user timers in the menu. Greenlight reads
  them from systemd and never changes a unit.` (PREFS-ROUTINES)
- The tab starts from the stored `watched-routines`, a list of timer unit names
  (`nightly-report.timer`). Opening the window reads the timers once, over the preferences
  process's own session bus connection, without `Subscribe()`; while the read runs, the
  group shows one row `Reading systemd timers…` and the stored routines stay watched.
- Once read, the group lists the timers, sorted by name, one switch row each: the title is the
  routine's name, the subtitle its description, then ` · next <time>` with the next run as the
  menu shows it, or nothing more when the menu shows none. A switch on means watched.
- A stored timer that the list does not return keeps a row, its switch on, subtitled
  `Not loaded by systemd`, so it can be switched off. (PREFS-ROUTINES)
- No timer at all: one row, `No systemd user timers`, subtitled
  `Create one with systemctl --user, then reopen Preferences.`, after the stored rows if any.
  (PREFS-EMPTY)
- systemd unreachable (no owner for `org.freedesktop.systemd1`, or a failed call): one row,
  `Could not read systemd timers`, subtitled with the D-Bus error message; stored routines keep
  their rows, switches on, subtitled `Stored; not read from systemd`. (PREFS-ERROR)
- The list is read once per window; there is no refresh button.
- Under TAB, the **Routines** tab's setting is the set of watched timers. Its baseline is the
  stored list, and it has unsaved changes when the set of switches on differs from it, whatever
  the order. A read that is still running or that failed changes nothing, so saving another tab
  meanwhile keeps `watched-routines` as stored. A save stores the watched names sorted.
- TAB's banner names up to three unsaved tabs: `Unsaved changes in Pull requests, Agents, and
  Routines`.

## Menu

- A **Routines** section sits below the agent quotas section, or below the pull request list
  when that section is absent, and above **Preferences…**. It shows when at least one routine is
  watched, and hides while quick open has text, as the quota section does. (MENU-ROUTINES,
  MENU-TYPING)
- Separators: one separator between two shown neighbors among the pull request list, the quota
  section, the **Routines** section, and **Preferences…**, never two in a row. With both sections
  hidden, one separator stays between the list and **Preferences…**, as QTA says.
- A heading reads `Routines`, then one row per watched routine, sorted by name. A watched
  routine whose timer is no longer loaded is left out; when none is left, a dimmed line reads
  `No watched routine is loaded by systemd.`
- Until the first read answers, a dimmed line under the heading reads `Reading systemd…`. When
  the first read fails as a whole, it reads `Could not read systemd: <cause>`.
- Height: the routine rows and the lines attached to them (read, start, and terminal errors) sit
  in a scroll area as tall as six single-line rows at most; with more, it scrolls on its own, and
  moving keyboard focus to a row scrolls it into view. The heading and the section-level lines
  (`Reading systemd…`, read errors) stay outside it. Beyond that, on a short screen, the pull
  request list gives way first, as QOP's menu height says; then the scroll area shrinks too, but
  never below min(rows, 3) single-line rows. **Preferences…** stays in view whenever the screen
  holds the menu with that floor. On a shorter screen (under about 570 px with the three quota
  providers and no line under the heading; more with CAG's custom agents or heading lines), GNOME Shell's menu height limit cuts the menu, as
  QOP's menu height says.
- Each row holds, from left to right: a status icon, the name, the status text, the next run,
  and two icon buttons, **Run now** and **View logs**. (MENU-ROUTINES)
  - **Succeeded**: a green check (`#26a269`) and `ran <age>`.
  - **Failed**: a red cross (`#c01c28`) and `failed <age> · <cause>`, in red. (MENU-FAILED)
  - **Running**: a yellow dot (`#e5a50a`) and `running since <HH:MM>`.
  - **Skipped**: a grey dash (`#77767b`) and `skipped <age> · condition not met`.
  - **No run recorded**: a grey dash and `no run recorded`.
  - **Unknown**: a grey dash and `last run <age> · result unknown`.
  - **Service not loaded**: a grey dash and `service not loaded`, without buttons.
  - The next run reads `next in <duration>` under a day away (`next in 11 min`,
    `next in 6 h 20 min`), else `next <weekday> <HH:MM>`, or `not scheduled`. Ages read as ORD's
    ages do (`now`, `12 min`, `5 h`, `3 d`, then a date), followed by ` ago`, except a date.
- Times use the local time zone and 24-hour `HH:MM`. They are computed when the section renders:
  on each read and each time the menu opens.
- A stale row (its last read failed, or systemd lost its bus name) is dimmed, and its **Run now**
  is insensitive. (MENU-READ-ERROR)
  - A routine whose own read failed shows a dimmed line under its row,
    `Could not read <name>: <cause>`, with the cause of that routine's failure, until a read of
    it succeeds. Each routine shows its own cause, so two routines that fail differently show two
    causes.
  - A watched routine with no state read yet, whose read fails, has no row: a dimmed line under
    the heading reads `Could not read <name>: <cause>`, one per such routine, sorted by name.
    That line goes once a read of the routine succeeds, or the routine stops being watched.
  - A failure of the read as a whole (a lost connection, or a manager call that concerns every
    routine) shows one line under the heading, `Could not read systemd: <cause>`, in place of
    every `Could not read <name>` line, under the heading or under a row.
  - After the name lost its owner, the line under the heading reads `systemd is not running`, in
    place of every `Could not read <name>` line the same way.
  - A `Could not read <name>` line replaced so shows again only after a new failed read of that
    routine. Start and terminal lines follow their own rules.
- Keyboard: a row is a static item (it takes no focus and a click on it opens nothing); its two
  buttons take the focus in order with Tab and act on Enter or Space. A read updates the rows in
  place: a focused button keeps the focus while its row and action still exist.
- The row's accessible name reads `<name>, <status text>, <next run>`, without the next run when
  the row shows none (**Running**).
- The section has no **Updated** line.

## Run now

- **Run now** (`media-playback-start-symbolic`, accessible name `Run <name> now`) calls the
  manager's `StartUnit(<service>, 'fail')`, which refuses to replace a job already queued for a
  conflicting unit. The menu stays open. (MENU-RUNNING)
- It is insensitive while the routine is **Running**, while its row is stale, and from the call
  until its reply, or 30 seconds without one. Greenlight listens to `JobRemoved` before it sends
  the call.
- The `JobRemoved` of the job the call returned re-reads the routine, which then shows how the
  run is going or how it ended (a quick oneshot can already read **Succeeded** or **Failed**); a
  start job of a oneshot service ends only when its process exits, so the wait for it has no
  limit and shows nothing.
- A dimmed line under the row reports a start that did not happen, until the next successful
  start or the menu closes. A start is successful when systemd accepts the call (its reply
  returns a job): the old line goes then, and a job result that later reports a start that did
  not happen brings a new line. The line reads `Could not start <name>: <D-Bus error message>`
  for a refused call,
  `Could not start <name>: no answer from systemd` for no reply within 30 seconds, and
  `Could not start <name>: job <result>` for any job result other than `done` and `failed`
  (`dependency`, `canceled`, `timeout`, `skipped`, `assert`, and the others). A result of `failed` shows no line: the row's **Failed** state says it.

## View logs

- **View logs** (`utilities-terminal-symbolic`, accessible name `View <name> logs`) opens a
  terminal that runs `env SYSTEMD_PAGERSECURE=0 SYSTEMD_PAGER=less SYSTEMD_LESS=RSXMK journalctl --user -u <service> -e`, which opens the
  pager at the end of the routine's logs and keeps it open until `q`, even when the logs fit one
  screen (systemd's default `SYSTEMD_LESS` holds `F`, which quits at once then, and an inherited
  `SYSTEMD_PAGER` or `PAGER` such as `cat` would not page at all; systemd honors
  `SYSTEMD_PAGER` only with `SYSTEMD_PAGERSECURE` set). Without `less` installed, journalctl
  may use another pager or print the logs and let the terminal close; that is out of scope. The variables are
  part of the command because ptyxis and gnome-terminal run it in an already-running server that
  ignores the caller's environment. The menu closes. (MENU-FAILED)
- The terminal is the first of these found, each looked up in `PATH`, then in `~/.local/bin`:
  `xdg-terminal-exec <command…>`, `ptyxis -- <command…>`, `kgx -- <command…>`,
  `gnome-terminal -- <command…>`. Greenlight starts the path it found, with an argument array,
  never a shell string.
- No terminal found, or the one found fails to start: from the menu, the row shows a dimmed line
  under it, `No terminal found. Run: journalctl --user -u <service> -e` or
  `Could not open a terminal: <error>. Run: journalctl --user -u <service> -e`, and the menu
  stays open; from a notification, a notification `Could not open the logs of <name>` carries the
  same text.
- That line has its own place beside the start line, and lasts until the next **View logs** of the
  row starts a terminal, or the menu closes.
- When the process Greenlight started (the terminal command found, such as a wrapper like
  `xdg-terminal-exec` with no usable terminal) exits with a non-zero status or is killed by a
  signal, and Greenlight learns it within 5 seconds of starting it, a notification
  `Could not open the logs of <name>` shows, whether **View logs** or a notification started it.
  What that process starts in turn (a terminal server, the `journalctl` inside it) is not
  watched. It reads `<terminal> exited with status <n>. Run: journalctl --user -u <service> -e`,
  or `<terminal> was killed by signal <n>. Run: journalctl --user -u <service> -e`, `<terminal>`
  being the command found. A menu that started it has already closed. Greenlight watches for no
  exit after those 5 seconds, never kills the terminal, and stops watching when the extension is
  disabled.
- Clicking a `Could not open the logs of <name>` notification only dismisses it.

## Failure notifications

- A watched routine notifies once per **observed** failed run: the title `<name> failed`, the
  body `<cause> · <HH:MM>`, the time being the state's time. (NOTIF)
- A failed run is identified by its service and the service's `StateChangeTimestampMonotonic`,
  and a timer failure by the timer's unit name and its own `StateChangeTimestampMonotonic`, so a re-read does not notify it twice,
  and a later failed run notifies again. Two watched timers that activate the same service share
  its failed runs: such a run notifies once, under a name chosen as the rules below say. A timer
  failure belongs to its timer alone and notifies under its name.
- Greenlight reads states, not events: a run that fails and is followed by another run before
  Greenlight reads (with D-Bus signals, within the same second; with the polling fallback of
  RTN-P1, within 30 seconds) is not observed and does not notify.
- When the extension starts, and when a routine starts being watched, the routine's first
  successful read is a quiet baseline: a routine already **Failed** then does not notify, even
  when earlier reads failed. After a stale period, a failed run whose identity is newer than the
  last one read notifies; one already known does not. A restart of the extension or
  the session sets a new baseline; nothing is stored.
- Each routine keeps the identities of the runs it has read, and Greenlight keeps the identities
  it has notified until the extension restarts. A run shared by two watched timers notifies once,
  under the first name by sort order among the timers whose read first shows it after their
  baseline; a timer stale at that read, which sees the run later, does not notify it again. A timer
  that starts being watched on a service already watched gets its own quiet baseline. A run
  already notified does not notify again, even when the watched list empties and fills again.
- Each observed failed run gets its own notification, on Greenlight's one notification source.
  GNOME Shell keeps ten notifications per source, so a burst of more than ten in one read drops
  the oldest; their runs stay known and do not notify again. The dot and the menu still show
  every failure.
- Clicking the notification opens the logs, as **View logs** does.
- A failed read never notifies.

## Panel indicator

- While at least one watched routine is **Failed**, a red dot (`#c01c28`, 6 px) sits on the top
  right corner of the panel icon, and the indicator's accessible name reads
  `Greenlight, a routine failed`. (MENU-FAILED)
- The dot follows the state: it goes away once no watched routine is **Failed** (a successful
  run, `reset-failed`, or the routine no longer watched). Opening the menu does not clear it.
- The `PR <n>` label and PRM's `PR !` are unchanged. A stale row keeps the dot as it was.

## Out of scope

- System timers, timers that activate something other than a service, services without a timer,
  and routines from other schedulers (cron, at).
- Creating, editing, enabling, disabling, or stopping a unit, and `reset-failed`.
- Reading or showing log lines inside Greenlight, and a history of past runs.
- A setting to turn the failure notifications or the dot off.

## Plans

### RTN-P1: watched routines in the menu

- **Depends on**: TAB merged (TAB-P1 and TAB-P2), since the **Routines** tab and its unsaved
  changes use TAB's tabs and save.
- **Scope**: **Scope**, **Reading systemd**, **Preferences**, and **Menu**, without the two
  buttons. The TAB, PRM, QTA, and QOP rules RTN changes here (the **Routines** tab and TAB's
  three-tab banner text, the menu order, the separators, the menu height) are rewritten in those
  specs, each with `v1.6` in `amended`. README.md describes the routines.
- **Temporary restrictions**: no **Run now** or **View logs** button (RTN-P2); no notification
  and no panel dot (RTN-P3). P1 does not listen to `JobRemoved`.
- **Prototype first** (throwaway): from GJS in the user's real session, with a disposable
  `greenlight-probe.timer` and `greenlight-probe.service` written to a scratch directory and
  linked with `systemctl --user link`, then removed: call `ListUnitsByPatterns`, `GetAll` for each
  interface above, `Subscribe()`, and receive `PropertiesChanged` when the service is started with
  `systemctl --user start`. Each check passes or fails on its own:
  1. every property reads, with the D-Bus types `t` for timestamps and `NextElapse…`, `i` for
     `ExecMainCode` and `ExecMainStatus`, `b` for `ConditionResult`, and `s` for the rest;
  2. a `PropertiesChanged` arrives within 2 seconds for each of: a manual start, a failed run
     (the probe service runs `false`), `systemctl --user reset-failed`, the timer elapsing, and
     the timer's next run moving to a new future deadline after a run: a recurring timer
     (`OnActiveSec=10s` with `OnUnitActiveSec=20s`) whose own `PropertiesChanged`, on the
     `Timer` interface, carries a `NextElapseUSecMonotonic` that is set (neither 0 nor 2^64 − 1), in the future, and
     later than the one read before;
  3. `NextElapseUSecMonotonic` converted with `GLib.get_monotonic_time()` matches
     `systemctl --user list-timers` within a second.
  A check of 2 that fails makes Greenlight also re-read the watched routines every 30 seconds
  (and when the menu opens, as always), and the acceptance below then expects that update within
  30 seconds; the PR says which. A failure of 1 or 3 is reported to the owner before going
  further.
- **Acceptance**:
  - Unit tests (`node --test`) for a pure `src/routines.js`: each state of **State** from its
    properties (a `RemainAfterExit` service, a skipped start, a timer failure, a pre-start
    failure, a cleared failure reading **Unknown**); each cause text; the next run with each
    value unset as 0 and as 2^64 − 1, with both set in each order, a value in the past
    (`next now`), and a **Running** routine (no next run); the age and next-run texts
    across a day and a week; the sort; the accessible name; the three-tab TAB texts.
  - In the headless GNOME Shell, against a mock `org.freedesktop.systemd1` on its private bus
    (see the technical notes) with timers in each state: the **Routines** tab lists them sorted;
    saving **Agents** while the read is held pending keeps `watched-routines`; a switch saved
    through TAB's save stores `watched-routines`; the menu shows each row with its text; seven
    watched routines make the section scroll with **Preferences…** in view on a 1280×600
    monitor; the four combinations of the quota and routine sections show one separator between
    neighbors; typing in quick open hides the section; a property change on the mock updates
    its row within 2 seconds (30 in the polling fallback); dropping the mock's bus name dims the
    rows with `systemd is not running`, and bringing it back restores them. Screenshots, and no
    `JS ERROR` or `JS WARNING` in the log.
  - `scripts/screenshots.sh` runs the same mock with fictional timers; `menu.png` shows the
    section, and a new `preferences-routines.png` the tab.
  - `npm run lint` and `make check` pass.
- **Technical notes**:
  - The private `dbus-run-session` of the headless shell has no systemd, so the tests and the
    screenshots run a mock: a small script under `scripts/screenshots/` that owns
    `org.freedesktop.systemd1` on that bus and serves the manager, unit, timer, and service
    interfaces above from a JSON fixture, written with `Gio` (in GJS, or in `python3` with
    `gi.repository.Gio`, so no new dependency). It emits `PropertiesChanged`, `UnitNew`,
    `UnitRemoved`, and `Reloading` only after `Subscribe()`, and `JobRemoved` to a job's caller
    whether or not it subscribed, as systemd does; it can refuse `Subscribe()` on request, can
    change a property and emit `PropertiesChanged` on request, can hold a reply, and can release
    and take back its bus name.
  - Call `GetAll` with `Gio.DBusConnection.call` and a cancellable per read rather than
    `Gio.DBusProxy`, whose cache holds one interface and is invalidated without values. Watch
    the name with `Gio.bus_watch_name_on_connection` on Greenlight's own connection
    (`Gio.DBusConnection.new_for_address` with `Gio.dbus_address_get_for_bus_sync(SESSION)` and
    the `AUTHENTICATION_CLIENT | MESSAGE_BUS_CONNECTION` flags). RTN-P2 listens to `JobRemoved`
    whether or not `Subscribe()` succeeded.
  - `GLib.get_monotonic_time()` is `CLOCK_MONOTONIC` in microseconds, the clock of
    `NextElapseUSecMonotonic` (systemd's `dbus-timer.c` converts its boottime deadline with
    `timer_next_elapse_monotonic()`) and of `StateChangeTimestampMonotonic`; prototype check 3
    confirms it.
  - Keep the state, the texts, and the next-run choice in `src/routines.js`, which imports
    nothing from `gi://`, as AGENTS.md asks; the D-Bus client goes in its own module shared by
    the extension and the preferences, as `src/agents.js` is for the quota CLIs.
  - The routine rows are `PopupBaseMenuItem`s with `{activate: false, hover: false,
    can_focus: false}` (AGENTS.md); the buttons are focusable `St.Button`s. The six-row cap is a
    `St.ScrollView` around a box that holds only the routine rows and their attached lines; the
    heading and the section-level lines sit outside it.
  - The new key `watched-routines` (`as`, default `[]`) goes in the GSettings schema.

### RTN-P2: Run now and View logs

- **Depends on**: RTN-P1.
- **Scope**: **Run now** and **View logs**, with the `JobRemoved` listening.
- **Acceptance**:
  - Unit tests for the terminal choice (each candidate missing in turn, a candidate only in
    `~/.local/bin`, none found), the argument arrays, and the job result texts.
  - In the headless GNOME Shell with the mock: **Run now** calls `StartUnit` with the service and
    `fail` (the mock logs the call) and is insensitive until the reply; a job that the mock keeps
    running turns the row **Running** with no error line, even past 30 seconds; a quick oneshot
    that ends before the re-read reads **Succeeded**; a `failed` job result shows **Failed** and no
    `Could not start` line; a `dependency` job result, a refused call, and a held reply each
    show their `Could not start` line, also with the mock refusing `Subscribe()`, under which a
    `done` job also updates the row before the next poll; a timer with `OnUnitActiveSec=` shows the next run the mock reports
    after the start; **View logs** starts the first terminal of a scratch `PATH` holding stub
    terminals that log their arguments, which include `env SYSTEMD_PAGERSECURE=0 SYSTEMD_PAGER=less SYSTEMD_LESS=RSXMK journalctl`, a stub that fails to start shows the
    `Could not open a terminal` line, and with none, the `No terminal found` line. Screenshots,
    and no `JS ERROR` or `JS WARNING` in the log.
  - `scripts/screenshots.sh` regenerates `menu.png` with the buttons.
  - `npm run lint` and `make check` pass.
- **Technical notes**: start the terminal with `Gio.Subprocess` and an argument array whose first
  item is the path found, with the lookup of `findCli` in `src/agents.js`. Check each terminal's
  argument form against its `--help` where it is installed (`kgx` documents `-e` as well as
  `--`); a form that differs is corrected in the spec through the outbox.

### RTN-P3: failure notifications and the panel dot

- **Depends on**: RTN-P2, whose terminal launcher (in the D-Bus client's module, shared with the
  preferences) the notification uses.
- **Scope**: **Failure notifications** and **Panel indicator**. PRM's panel indicator rule is
  rewritten for the dot, with `v1.6` in `amended`.
- **Acceptance**:
  - Unit tests for the run identity (a service failure, a timer failure, a direct inactive to
    failed change, two timers on one service), the baseline at start and when a routine starts
    being watched, a second failed run, and the dot from a set of states.
  - In the headless GNOME Shell with the mock: a routine already failed at start shows the dot
    and does not notify; a watched routine that turns failed notifies once with its title and
    body, and a re-read does not notify again; dismissing that notification, then a second
    failed run, notifies again, and clicking the second one starts the logs terminal stub;
    without a terminal, clicking it shows the `Could not open the logs` notification; a
    successful run removes the dot; the indicator's accessible name follows. Screenshots, and no
    `JS ERROR` or `JS WARNING` in the log.
  - `scripts/screenshots.sh` regenerates `menu.png` with a failed routine and the dot.
  - `npm run lint` and `make check` pass.
- **Technical notes**:
  - A `MessageTray.Notification` on Greenlight's own `MessageTray.Source`, whose `activated`
    signal opens the logs; `Main.notify` cannot carry the action. The source destroys itself
    with its last notification: create it again when it is gone, and destroy it when the
    extension is disabled.
  - The dot is a small `St.Widget` over the panel icon, in a `St.Widget` with a
    `Clutter.BinLayout`, aligned to the top right, hidden when no watched routine is **Failed**.
