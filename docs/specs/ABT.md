---
code: ABT
status: done
version: v1.1
created: 2026-10-12
builds-on: PRM
---

# Greenlight — ABT specification

ABT shows which version of Greenlight is installed, so a bug report can name it without opening
the Extensions app. It builds on PRM, whose rules all still apply. It predates the spec delivery
process, so it has no plans. It is the former v1.1 specification.

## Preferences

- An **About** group at the bottom of the preferences window shows a **Version** row with the
  `version-name` from `metadata.json`, such as `1.1.0`. The value is selectable, so it can be
  copied into an issue.
- A **Source code** row below it shows the `url` from `metadata.json` and opens it in the
  default browser.
- Both rows are read-only and are not part of **Save preferences**.
