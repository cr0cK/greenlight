# BabysitPR

A small GNOME Shell extension that watches your open GitHub pull requests and notifies you when their checks pass. It uses your existing local GitHub CLI authentication and stores no GitHub token.

## Features

- Shows your open pull requests in the GNOME top bar menu.
- Displays each pull request's check status and check count.
- Opens a pull request in your browser when selected.
- Sends a desktop notification when a pull request reaches a new green check run.
- Lets you set the polling interval from 30 seconds to 10 minutes.

The initial refresh establishes a baseline, so pull requests that are already green do not trigger startup notifications. Draft pull requests are included. The search is capped at the 30 most recently updated open pull requests.

## Requirements

- GNOME Shell 49
- GitHub CLI (gh), authenticated for the account and host you want to monitor

Check the GitHub CLI session with:

~~~sh
gh auth status
~~~

For development checks and packaging, install Node.js, GLib schema tools, and the GNOME extension CLI.

## Install

From the repository root:

~~~sh
make install
gnome-extensions enable babysitpr@alexis
~~~

On Wayland, log out and back in if GNOME does not load the extension immediately.

## Use

The panel indicator shows how many pull requests BabysitPR is monitoring, up to 30. Open its menu to review their statuses and click one to open it in your browser. The preferences menu lets you change the refresh interval.

BabysitPR runs one gh search for the account's open pull requests, then reads each pull request's checks sequentially. This avoids overlapping refreshes. A refresh normally runs every two minutes; the interval can be set to 30, 60, 120, 300, or 600 seconds.

Skipped checks are treated as non-blocking when at least one check has passed. A pull request with no checks is not considered green.

## Check and package

~~~sh
make check
make pack
~~~

The check validates the GSettings schema, parses both JavaScript modules, and builds the GNOME extension bundle in dist/. Node.js is not needed at runtime.

To remove an installed copy:

~~~sh
gnome-extensions uninstall babysitpr@alexis
~~~

See docs/spec-v0.1.md for the v0.1 contract and CHANGELOG.md for release notes.
