---
code: QTA
status: active
version: v1.3
created: 2026-11-12
builds-on: PRM
tracking: "#36"
---

# Greenlight — QTA specification

QTA shows how much of the Claude, Codex, and Antigravity subscription quotas is used, in the Greenlight menu
next to the pull requests the agents open, so their use can be spread over the week instead of
hitting a limit on Thursday. It covers the **Agent quotas** preferences, when a provider is
available, the menu section with its gauges and pace mark, threshold notifications, and how
Greenlight asks each agent's own CLI. It builds on PRM, whose rules all still apply. It amends
PRM's menu order, since the section sits between the pull request list and **Preferences…**, and
QOP's menu height: the section stays in view, and hides while quick open has text. The mockup is
[`mockups/QTA.html`](mockups/QTA.html).

## Scope

- Three providers: Claude (Claude Code on a Claude subscription), Codex (ChatGPT sign-in), and
  Antigravity (the `agy` CLI, signed in with Google), for its Gemini models only. All are off by
  default. Other agents, Antigravity's Claude and GPT quota, API-key billing, per-model windows,
  and a panel indicator are out of scope.
- Greenlight never reads, stores, or sends a credential. Each provider asks its own CLI, the way
  pull requests ask `gh`.

## Preferences

- A new **Agent quotas** group, after **Quick open** and before **Accounts and organizations**,
  holds (state `PREFS-READY`):
  - A **Claude**, a **Codex**, and an **Antigravity** switch (see Availability).
  - **Refresh every**: 15 minutes, 30 minutes, 1 hour (default), 2 hours, or 4 hours.
  - **Notify at**, in percent: 50 to 100 by steps of 5, default 80.
- Every row applies on **Save preferences**. The timer uses any stored interval from 15 to 240
  minutes; the preferences show one outside the list as 1 hour, and saving stores 60. **Notify
  at** applies any stored value from 50 to 100, on the grid or not.

## Availability

- A provider is available when its CLI is found and answers with at least one quota window. It
  is unavailable when the CLI is missing, is not signed in, is not on a subscription, or answers
  in a form Greenlight does not recognize.
- Opening the preferences window checks each provider with the same command the menu uses.
  While it runs, the switch is insensitive and subtitled `Checking…`. An available provider's
  switch is subtitled `Uses the claude CLI`, `Uses the codex CLI`, or `Uses the agy CLI`. An unavailable provider's
  switch turns off and stays insensitive, and its subtitle says why and what to do; saving then
  stores it off. A check that fails for another reason (timeout, crash) keeps the saved choice,
  locked, with `Could not check: <cause>. Reopen Preferences to try again.`
- **Save preferences** during a check keeps the saved choice of a provider still checking, and
  closes the window like any save. Closing the window cancels the checks still running.
- Outside the preferences window, a disabled provider starts no process.
- In the menu, an enabled provider that turns out unavailable is hidden, never shown as a broken
  row; the next quota refresh tries again. Without any provider left to show, the section is
  absent. An unavailable answer forgets the provider's reading and marked periods, so its next
  reading sets a quiet baseline (see Notifications).
- A transient failure (timeout, crash, a CLI that cannot start, any failure the Claude and Codex
  sections below do not call unavailable) keeps the last reading, dimmed, with the cause and its age. A provider without any
  reading is hidden.
- A restart shows the cached readings as they were read, undimmed, until the refresh at start
  answers; a failure's cause is not cached.

## Menu

- An **Agent quotas** section sits below the pull request list, right above **Preferences…**,
  when at least one enabled provider has a reading to show (see Availability), with a separator
  on each side. Quick open stays right above the list.
  It hides while quick open has text, so the suggestions, the preview, and the list keep their
  room. It does not scroll: on a short screen the pull request list gives way, as QOP's menu
  height says. A result that lands while the menu is open redraws the section in place.
- Each provider gets one line per quota window it reports, labelled `5 h` or `Week`; another
  duration is labelled by its length (`1 d`, `30 d`, `90 min`), and a window without a duration reads
  `Quota`. A window is identified by its slot, not its label: `session` or `week` for Claude's
  lines, `primary` or `secondary` for Codex's windows, `gemini-5h` or `gemini-weekly` for Antigravity's.
  Providers follow the order Claude, Codex, Antigravity, and lines follow that slot order:

  ```text
  Claude  5 h   ███░░|░░░  38 %  resets in 2 h 10 min
          Week  █████░|░░  61 %  resets Sat 09:00
  Codex   Week  █░░░|░░░░  16 %  resets Tue 09:30
  Antigravity
          5 h   █░░░░|░░░   4 %  resets in 4 h 50 min
          Week  ░░░|░░░░░   0 %  resets Thu 11:53
  ```

  A provider name that does not fit the name column takes its own line above its windows.

- The bar fills with the used share. A pace mark (`|` above) shows the even-spending budget:
  `clamp(1 − (resetsAt − now) / duration, 0, 1)`. A fill past the mark means usage runs ahead of
  an even spread over the window. A window without a duration or a reset time has no mark.
- The bar is green (`#26a269`) below **Notify at**, yellow (`#e5a50a`) at or above it, red
  (`#c01c28`) at 100 %, and grey (`#77767b`) while dimmed. The pace mark is `#9a9996`.
- A reset under a day away reads as a duration; later ones as a weekday and time. A window whose
  reset time has passed reads `reset · waiting for a new reading`, without a percentage, a bar
  fill, or a mark.
- A dimmed `Updated 12 min ago` line closes the section, from the oldest successful reading
  shown.
- Quotas are read when the extension starts and when a provider is switched on. The last try is
  kept in memory only, so the read at start counts as one. **Refresh now**
  refreshes them along with the pull requests. Opening the menu refreshes
  a provider last tried more than 5 minutes ago; otherwise they follow their own timer,
  independent of `refresh-interval`.
- Each provider has at most one refresh in flight; a refresh asked meanwhile joins it. Disabling
  a provider or the extension cancels its refresh, and a cancelled result is dropped.

## Notifications

- A window notifies once per period, when a reading of that period is at or above **Notify at**
  and the period has not notified yet. A period is identified by provider, window slot, and
  reset time. The notification names the provider, the window, the percentage, and the reset
  time: `Claude weekly quota at 82 %` / `Resets Sat 09:00`. The window's name comes from its
  label: `weekly` for `Week`, and `<N>-day`, `<N>-hour`, or `<N>-minute` for `N d`, `N h`, or
  `N min` (`5-hour`, `90-minute`); a `Quota` window is not named (`Codex quota at 90 %`).
- The first reading after a provider is switched on, or after an unavailable answer, sets a
  quiet baseline: it marks the periods
  already at or above the threshold as notified. A period that crosses it later, or starts later
  above it, notifies. A restart of the extension or the session keeps the cached reading and the
  marked periods, so it sets no baseline; switching a provider off forgets both.
- A window without a reset time is shown but never notifies, since it has no period.
- Changing **Notify at** does not notify periods already marked.
- Errors never notify.

## Finding the CLIs

- GNOME Shell does not inherit the login shell's `PATH`, which usually lacks `~/.local/bin`,
  where both CLIs install. Greenlight looks for `claude` and `codex` in `PATH`, then in
  `~/.local/bin`, and runs them with their own directory first in `PATH`.

## Claude

- Runs `claude -p /usage --no-session-persistence --output-format json --settings
  {"disableAllHooks":true}` with an argument array and a 30-second timeout. The command costs
  no tokens, saves no session, and runs none of the user's hooks.
- Reads stdout before the exit code: JSON with `is_error` true is a transient failure whose
  cause is the first line of its `result`; otherwise a non-zero exit, or output that is not JSON,
  is a transient failure. In `result`, the line `Current session: N% used · resets <time> (<zone>)`
  is the `5 h` window, and `Current week (all models): N% used · resets <date>, <time> (<zone>)`
  is the `Week` window, such as `resets 2pm (Europe/Paris)` and `resets Nov 16, 7am
  (Europe/Paris)`. Per-model lines and the usage advice are ignored.
- A reset is read in the named IANA zone. With only a time, it is the next occurrence of that
  time: today, or tomorrow when today's is more than a minute past. With a month and a day, it
  falls in the current year, or the next one when that date is more than a day past. A reset
  that does not parse, or names an unknown zone, reads as none.
- Unavailable: a `result` that does not start with `You are currently using your subscription`
  (signed out or on an API key, `/usage` then prints session costs), or one without any window
  line.

## Codex

- Runs `codex app-server` with an argument array and keeps stdin open: closing it makes the
  server quit before answering. Messages are one JSON object per line, written at once, since
  the server handles them in order:
  1. request `initialize` (id 1) with `clientInfo` `{name: "greenlight", version}`;
  2. notification `initialized`;
  3. request `account/rateLimits/read` (id 2).
- Greenlight reads lines until the response with id 1, then the one with id 2; other messages
  are skipped. An error response to `initialize` is a transient failure.
- After that response, or after 15 seconds, Greenlight closes the pipes, which ends the server
  even behind a launcher that runs it as a child, and sends SIGTERM. Codex handles its own sign-in
  and token refresh.
- Reads the `codex` bucket from `result.rateLimitsByLimitId`, or `result.rateLimits` when that
  map is absent; with the map but no `codex` bucket, Codex is unavailable. Its `primary` and `secondary` windows (`usedPercent`, `windowDurationMins`,
  `resetsAt`) are the `primary` and `secondary` slots, labelled by their duration; a null window
  is not shown.
- Unavailable: an error response about authentication (`codex account authentication required
  to read rate limits`) or an unknown method, or an answer without any window. Other error
  responses are transient failures.

## Antigravity

- Runs `agy -p /usage --output-format json` with an argument array, a 30-second timeout, and
  `BROWSER` set to `true`, so a signed-out run cannot open a browser. `/usage` in print mode
  answers without an agent turn: it costs no tokens and leaves no conversation.
- Reads stdout as it arrives. A line that starts with `Authentication required` (a signed-out
  run waits for a browser sign-in) ends the process at once: Antigravity is unavailable.
- Otherwise reads the JSON answer once the process exits. A `status` other than `SUCCESS` is a
  transient failure whose cause is the first line of `response`, or the status when it is empty.
  Output that is not JSON is a transient failure after a non-zero exit, and unavailable after a
  zero one.
- In `command.data.groups`, the group named `Gemini Models` holds the windows: its buckets with
  `window` `5h` and `weekly` are the `gemini-5h` and `gemini-weekly` slots, labelled `5 h` (5
  hours) and `Week` (7 days). The used share is `(1 − remaining_fraction) × 100`, and
  `reset_time` is an ISO 8601 time. A bucket without a numeric `remaining_fraction`, such as a
  disabled one, is not shown. Other groups are ignored.
- Unavailable: the sign-in line, a JSON answer without a `Gemini Models` group holding a window,
  or a zero exit with output that is not JSON.

## Units

- Percentages are percentage points from 0 to 100; Codex `resetsAt` is in epoch seconds. All
  providers normalize to `{slot, label, usedPercent, durationSeconds, resetsAt}`, times in epoch seconds,
  before display, notification, or storage. A window without a numeric percentage is skipped;
  a missing or invalid length or reset reads as none.

## Errors

- Unavailability messages, in the preferences: `claude not found in PATH or ~/.local/bin`,
  `Claude Code is not signed in with a Claude subscription. Run claude, then /login.`,
  `Claude Code answered /usage in an unknown form. Update Claude Code.`,
  `codex not found in PATH or ~/.local/bin`, `Codex is not signed in. Run codex login.`,
  `This codex cannot report rate limits. Update Codex.`,
  `Codex reports no subscription quota. Sign in with ChatGPT: codex login.`,
  `agy not found in PATH or ~/.local/bin`, `Antigravity is not signed in. Run agy and sign in.`,
  `Antigravity answered /usage in an unknown form. Update agy.`,
  `Antigravity reports no Gemini quota. Update agy.`
- Transient causes, once per provider under its last dimmed line, as `<Provider>: <cause> ·
  last reading <age>`, the cause being `timed out`, `exited with code N`, `killed by signal N`,
  `could not start: <reason>`, or the CLI's own error message. A process ended at the timeout
  reads `timed out`. A codex that exits before answering, an old one
  without `app-server` included, reads `exited with code N`.
- One provider failing never hides the others, nor the pull requests.

## Storage

- New settings: `claude-quota-enabled`, `codex-quota-enabled`, and `agy-quota-enabled`
  (booleans, false),
  `agent-quota-interval` (minutes, 60), `agent-quota-threshold` (percent, 80), and
  `agent-quota-cache` (JSON: each provider's last normalized reading, its time, and the periods
  already notified, pruned once their reset has passed).
- Parsing the answers, window labels, pace, period tracking, and messages live in a pure
  `src/quotas.js` covered by `node --test`; the extension only finds and runs the CLIs.

## Plans

### QTA-P1: Agent quotas for Claude and Codex

- **Scope**: the whole spec except Antigravity, which is QTA-P2.
- **Temporary restrictions**: no **Antigravity** switch, section lines, or `agy-quota-enabled`
  setting yet.
- **Acceptance**:
  - `npm run lint` and `make check` pass; `tests/quotas.test.js` covers parsing both answers
    (subscription, signed out or API key, unknown form, error, and their slots), reset times across zones and
    years, window labels, pace, reset and age texts, notification titles, period tracking with
    its baseline and windows without a reset, the `codex` bucket choice, and the cache reader.
  - In a headless GNOME Shell with the real CLIs and a `PATH` without `~/.local/bin`: both
    providers read and drawn; with Codex signed out (`CODEX_HOME` pointing at an empty
    directory), Codex hidden in the menu and its switch off and locked with its message.
  - In a headless GNOME Shell with scripted `claude` and `codex` in a scratch directory first in
    the shell's `PATH`, each answering from a file the test rewrites between steps, and refreshes
    driven through Eval or by opening the menu, with each script logging its runs:
    - a failed Claude refresh (`is_error` JSON, exit 1) dims the last reading with the CLI's
      message;
    - Codex crossing **Notify at** after a reading under it sends one notification; an
      unavailable answer then a reading above it sends none;
    - typing in quick open hides the section, and clearing it shows it again;
    - a reading past its reset shows `reset · waiting for a new reading`, without a percentage;
    - opening the menu reruns a provider whose last try the test ages past 5 minutes through
      Eval, and not one tried within them; two refreshes asked at once run one process;
    - a result landing while the menu is open redraws the section in place;
    - after a restart of the shell, the cached reading shows undimmed before the refresh at start
      answers;
    - an unavailable answer hides the provider, and its next reading is a quiet baseline;
    - on a 1280x600 virtual monitor with a row preview open, the section stays whole, the list
      scrolls, and the menu fits the monitor;
    - switching a provider off during a slow refresh ends its process and drops its result;
    - in the preferences: a missing CLI locks its switch off with its message, a check that times
      out locks it with `Could not check`, and saving during a check keeps the saved choice;
    - no `JS ERROR` in the shell log, and no `codex app-server` left running.
  - `scripts/screenshots.sh` serves fictional quotas through `scripts/screenshots/claude` and
    `codex`, and the regenerated screenshots show the section and the preferences group.
- **Technical notes**:
  - Pure logic in `src/quotas.js` (no `gi://` import); the Gio runners in `src/agents.js`,
    shared by `extension.js` and `prefs.js`.
  - `claude -p /usage` exits 0 and prints session costs when signed out or on an API key; only
    the subscription first line means quotas follow. Check `--no-session-persistence` and
    `--settings` against the installed version.
  - `codex app-server` quits when stdin closes, before answering: write the three messages at
    once and keep stdin open. GNOME Shell ignores SIGPIPE.
  - Menu sections are persistent (PRM): add the quota section and its own separator in
    `_buildMenu()`, never `menu.removeAll()`. The pace mark overlays the bar through a
    `Clutter.BinLayout`; sizes go through St CSS, like the preview's CI bar.

### QTA-P2: Antigravity's Gemini quota

- **Scope**: the Antigravity provider: its switch, its lines, its messages, the `## Antigravity`
  rules, and `agy-quota-enabled`.
- **Temporary restrictions**: none; it lifts QTA-P1's.
- **Acceptance**:
  - `npm run lint` and `make check` pass; `tests/quotas.test.js` covers parsing the agy answer:
    signed in, a disabled bucket, no `Gemini Models` group, a `status` other than `SUCCESS`, and
    output that is not JSON after a zero and a non-zero exit, with the slots, labels, used share,
    and reset times; and the `Antigravity weekly quota at 82 %` title.
  - In a headless GNOME Shell with the real `agy` and a `PATH` without `~/.local/bin`:
    Antigravity read and drawn after Claude and Codex, and its switch subtitled `Uses the agy
    CLI`.
  - With a scripted `agy` that prints the sign-in prompt and waits: Antigravity hidden in the
    menu and its switch off and locked with `Antigravity is not signed in. Run agy and sign in.`
    within 2 seconds, no browser started, and no `agy` process left.
  - `scripts/screenshots.sh` serves a fictional Gemini quota through `scripts/screenshots/agy`,
    and the regenerated screenshots show the Antigravity lines and switch.
- **Technical notes**:
  - Read stdout line by line (`Gio.DataInputStream.read_line_async`), like the Codex runner,
    so the sign-in line ends the process without waiting for the timeout.
  - `agy` installs in `~/.local/bin` like the other CLIs; `findCli` already looks there.
  - Run `agy`, never a shell alias: the user's shell may alias it with
    `--dangerously-skip-permissions`, which `/usage` does not need.
