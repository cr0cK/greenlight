---
code: QOP
status: done
version: v0.5
amended: [v1.2]
created: 2026-10-11
builds-on: PRM
---

# Greenlight — QOP specification

QOP covers opening any issue or pull request of a watched repository from its number, with a
keyboard shortcut, and the preview of an issue or pull request, from quick open and from the
pull request list. It builds on PRM, whose rules all still apply. It predates the spec delivery
process, so it has no plans. It gathers the rules of the former v0.5 specification and the parts
of v1.2 on quick open and previews, as the product stands.

## Quick open field

- The menu shows a quick open field under **Refresh now**, with the placeholder
  `Open issue or PR: repo #42, owner/repo#42, #42 or URL`. Opening the menu focuses it.
- Accepted input: `plat 42`, `plat#42`, `#42`, `42`, `owner/repo#42`, or a pasted GitHub issue or
  pull request URL. A number needs a `#` or a space before it, so repository names ending in
  digits stay intact.
- Suggestions rank repository name matches first, then owner matches, then subsequence matches,
  which only appear when nothing matches by substring. Ties go to the most recently opened
  repository, then alphabetical order. At most five suggestions show.
- **Enter** opens the first suggestion, **Down** moves into the suggestions, and **Escape**
  closes the menu. Closing the menu clears the field.
- Without a number, suggestions show dimmed with `add a number` and cannot be opened.
- With a number and several candidates, only repositories where that issue or pull request exists
  are listed, with its title. One `gh api graphql` request checks up to 20 ranked candidates,
  one alias per repository, 350 ms after the last change; results are cached for 60 seconds per
  repository and number. Meanwhile the menu reads `Looking up #<n> in <count> repositories…` and
  Enter does nothing. When no candidate holds the number, it reads
  `#<n> not found in <count> repositories`. If the request fails, the unfiltered candidates are
  listed. A single candidate skips this check; its preview reports a missing number.
- When no repository matches the query, the menu says so.
- Suggestions open `https://github.com/<owner>/<repo>/issues/<number>`; GitHub redirects it to
  `/pull/<number>` for a pull request, so opening makes no network request. A pasted URL keeps
  its host and its `issues` or `pull` path.

## Repository index

- Quick open suggests repositories from three local sources: recently opened repositories, the
  repositories of the pull requests in the menu, and the repositories selected for enabled
  owners. Owners in **All** or **All except…** contribute only through their pull requests and
  recent history. `owner/repo#42` typed in full always works, even for an unwatched repository.
- The ten most recently opened repositories are stored in `recent-repositories`.
- Refreshes keep the field, its text, and its focus.

## Preview

- The preview shows an issue or pull request in a panel: under a quick open suggestion (the first
  one with a number by default, or the one under the pointer or keyboard focus), or under a
  listed pull request. The pointer reaches it without crossing another suggestion. Focus changes
  retarget it after 150 ms, so a quick sweep does not reflow the menu.
- It loads 350 ms after the last change with one `gh api graphql` request
  (`issueOrPullRequest`), with `--hostname github.com` so an inherited `GH_HOST` cannot redirect
  it. Results, not-found ones included, are cached for 60 seconds per repository and number. A
  newer target or closing the menu cancels the pending request and kills its `gh` process. Only
  `github.com` targets are previewed.
- Pull requests show their state (Open, Draft, Merged, or Closed), author, up to six labels in
  their GitHub colors, `head → base` branches, and added and removed lines. A proportional bar
  shows passed, failed, pending, and skipped checks of the latest commit, followed by up to three
  failed check names. The rollup reads the first 100 contexts; any beyond show as
  `N not loaded`, and such a partial rollup is never shown as green.
- Issues show their state, author, comment count, and up to six labels.
- The preview has a fixed 20em height in every state and scrolls on its own, without an edge
  fade. The fixed height keeps hover stable: retargeting a lower suggestion lifts it by exactly
  the old preview's height.
- The description renders GitHub-flavored Markdown through `markdown.js`, which escapes text:
  headings (the top two levels larger, with a rule), paragraphs with hard line breaks, bullet,
  numbered, nested, and task lists, fenced code, quotes and GitHub alerts in their colors,
  tables, rules, and `<details>` summaries; inline bold, italic, strikethrough, underline, code,
  `<kbd>`, links, bare URLs, `@mentions`, and `#123` references. Images show as a 🖼 placeholder
  with their alt text, linking to the image. Other HTML disappears. Bodies over 6,000 characters
  are cut, with a note. Only http(s) links are clickable.
- A click on the preview opens the issue or pull request and closes the menu; a click on a link
  in the description opens that link instead.
- A missing repository or number reads `#<n> not found in <owner>/<repo>`. Other failures read
  `Preview unavailable. Check gh auth status.` Enter still opens the URL.
- Preview requests run alongside refreshes; each `gh` process has its own 30-second timeout.

## Previews in the pull request list

- A click on a pull request row toggles its preview under the row and keeps the menu open; only
  one preview exists at a time, and typing in quick open moves it back under the first
  suggestion. Hovering or focusing a row opens nothing.
- The open icon at the end of the row's first line, a double click on the row, or a click on its
  preview opens the pull request and closes the menu. With the keyboard, Space toggles the
  preview and Enter opens the pull request.
- After a click, the list waits for the double-click time before scrolling the preview into
  view, so the row stays under the pointer for a second click. The scroll is at most the preview
  height.
- The wheel over a preview scrolls its description; at either end, or when nothing overflows, it
  scrolls the list instead, so a preview never traps the list scroll.
- A refresh keeps the preview under its pull request while it is still listed, and removes it
  otherwise.

## Menu height

- Only the pull request list scrolls. **Refresh now**, quick open, its suggestions and preview,
  and **Preferences…** stay in view, and the menu never exceeds the screen height.
- Moving keyboard focus to a pull request scrolls it into view.

## Keyboard shortcut

- `quick-open-shortcut` toggles the menu with the field focused; the default is
  `<Super><Shift>g`.
- The **Quick open** group of the preferences edits it as accelerator text, validated on **Save
  preferences**: an invalid one is marked, takes the focus, and stops the save. An empty value disables the shortcut.
