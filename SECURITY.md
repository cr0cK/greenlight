# Security policy

## Supported versions

Only the latest release receives fixes.

## Reporting a vulnerability

Please report vulnerabilities privately through GitHub:
<https://github.com/cr0cK/greenlight/security/advisories/new>. Do not open a public issue.

Include the Greenlight version, the GNOME Shell and `gh` versions, the steps to reproduce, and
the impact you observed. You can expect an acknowledgement within a week.

## Scope

Greenlight runs inside GNOME Shell and calls the GitHub CLI with your existing authentication; it
stores no token. In scope: anything in this repository that could run unintended commands,
open unintended URLs, leak data from `gh`, or crash GNOME Shell. Vulnerabilities in GNOME Shell
or the GitHub CLI themselves belong to their upstream projects.
