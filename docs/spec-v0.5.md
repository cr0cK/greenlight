# BabysitPR v0.5 specification

## Goal

Open any issue or pull request of a watched repository from its number, and preview its description and CI without leaving the menu.

## Quick open field

- The menu shows a quick open field directly under **Refresh now**. Opening the menu focuses it.
- Accepted input: `plat 42`, `plat#42`, `#42`, `42`, `owner/repo#42`, or a pasted GitHub issue or pull request URL.
- A number needs a `#` or a space before it, so repository names ending in digits stay intact.
- Suggestions rank repository name matches first, then owner matches, then subsequence matches; subsequence matches only appear when nothing matches by substring. Ties go to the most recently opened repository, then alphabetical order. At most five suggestions are shown.
- **Enter** opens the first suggestion, **Down** moves into the suggestions, and **Escape** closes the menu. Closing the menu clears the field.
- Without a number, suggestions are shown dimmed with "add a number" and cannot be opened.
- With a number and several candidate repositories, only repositories where that issue or pull request exists are listed, with its title. One `gh api graphql` request checks up to 20 ranked candidates through one alias per repository, 350 ms after the last change. Results are cached for 60 seconds per repository and number. While it runs, the menu reads `Looking up #<n> in <count> repositories…` and Enter does nothing. When no candidate holds the number, it reads `#<n> not found in <count> repositories`. If the request fails, the unfiltered candidates are listed.
- A single candidate skips this check; its preview reports a missing number.
- When no repository matches the query, the menu says so.
- Suggestions open `https://github.com/<owner>/<repo>/issues/<number>`. GitHub redirects that URL to `/pull/<number>` when the number belongs to a pull request, so quick open makes no network request.
- A pasted URL keeps its host and its `issues` or `pull` path.

## Repository index

- Quick open suggests repositories from three local sources: recently opened repositories, repositories of the pull requests in the menu, and repositories selected for enabled owners.
- Owners in all-repositories mode contribute only through their pull requests and recent history. `owner/repo#42` typed in full always works, even for an unwatched repository.
- The ten most recently opened repositories are stored in `recent-repositories`.
- Refreshes keep the field, its text, and its focus.

## Preview

- A panel directly under a suggestion previews it: the first suggestion with a number by default, or the suggestion under the pointer or keyboard focus. The pointer reaches the preview without crossing another suggestion. Focus changes retarget the preview after 150 ms, so a quick sweep across suggestions does not reflow the menu.
- The preview loads 350 ms after the last change with one `gh api graphql` request (`issueOrPullRequest`). Results, including not-found ones, are cached for 60 seconds per repository and number. A newer target or closing the menu cancels the pending request and stops its `gh` process.
- Pull requests show their state (Open, Draft, Merged, or Closed), author, `head → base` branches, and added and removed lines. A proportional bar shows passed, failed, pending, and skipped checks from the latest commit, followed by up to three failed check names. The rollup reads the first 100 contexts; any beyond that show as `N not loaded`, and such a partial rollup is never shown as green.
- Issues show their state, author, comment count, and up to six labels.
- The preview has a fixed 20em height in every state and scrolls on its own, without an edge fade so its last lines stay readable. The fixed height keeps hover stable: retargeting a lower suggestion lifts it by exactly the old preview's height, so the pointer lands in the new preview. A click anywhere on it opens the issue or pull request and closes the menu; a click on a link in the description opens that link instead. Only http(s) links are clickable.
- The description renders GitHub-flavored Markdown in `markdown.js`: headings (the top two levels larger, with a rule), paragraphs with hard line breaks, bullet, numbered, and nested lists, task lists (☑, ☐), fenced code blocks, quotes and GitHub alerts (`[!NOTE]` and the others, in their colors), tables, horizontal rules, and `<details>` summaries. Inline, it renders bold, italic, strikethrough, underline (`<ins>`, `<u>`), `code` and `<kbd>`, links, bare URLs, `@mentions`, and `#123` references. Images show as a 🖼 placeholder with their alt text, linking to the image. HTML comments and other HTML tags disappear. Bodies over 6,000 characters are cut, with a note.
- A missing repository or number reads `#<n> not found in <owner>/<repo>`. Other failures read `Preview unavailable. Check gh auth status.` Enter still opens the URL.
- Only `github.com` suggestions are previewed, and both GraphQL requests pass `--hostname github.com` so an inherited `GH_HOST` cannot point them at another host.
- Preview requests run alongside pull request refreshes; each `gh` process has its own 30-second timeout.

## Hover preview for listed pull requests

- Hovering or focusing a listed pull request for `hover-preview-delay` milliseconds (1500 by default) opens the same preview directly under its row. A value of 0 disables it. Preferences sets it in seconds, in 0.5 s steps up to 10 s, under **Quick open and preview**.
- Only one preview exists at a time: typing in quick open moves it back under the first suggestion, and closing the menu removes it.
- When the row sits low in the list, the list scrolls to reveal the preview. The scroll is at most the preview height, so the pointer stays on the row or on its preview.
- A refresh keeps the preview under its pull request while it is still listed, and removes it otherwise.

## Menu height

- Only the pull request list scrolls. Refresh, quick open, its suggestions and preview, and Preferences stay in view, and the menu never exceeds the screen height.
- Moving keyboard focus to a pull request scrolls it into view.

## Keyboard shortcut

- `quick-open-shortcut` toggles the menu with the field focused. The default is `<Super><Shift>g`.
- Preferences edits the shortcut as accelerator text, validated on **Save preferences**. An empty value disables the shortcut.

## Verification

- `make check` also runs the quick open and preview unit tests with `node --test`.
- Update metadata to version 5 / `0.5.0`, README, and CHANGELOG.
