# GitHub PR Watcher

Chrome extension (MV3) that watches your open pull requests in chosen repositories and sends a system notification when someone comments, approves, requests changes, or CI finishes.

## Install

1. `chrome://extensions` → enable **Developer mode** → **Load unpacked** → pick this folder.
2. The settings page opens on install. Paste a token, list repositories, save.

## Token

Read-only is enough. The "Create fine-grained token" link on the settings page opens GitHub's form.

- Public repositories: under **Repository access** pick **Public repositories**. There are no permissions
  to choose: every fine-grained token can read all public repositories, and no organization approval is needed.
- Private repositories: pick **Only select repositories** and grant `Pull requests` and `Commit statuses`
  (Read-only). The organization has to allow fine-grained tokens.

A classic token works too: no scopes for public repositories, `repo` for private ones.

The review queue needs nothing more: reading pull requests is enough.

The token stays in `chrome.storage.local` of this Chrome profile and is sent only to `api.github.com`.

## Behaviour

- Repositories are picked from a searchable list: repositories where you have open or recent PRs, "all repositories" of each owner among them, and GitHub repository search as you type (your owners first). An exact `owner/name` or GitHub URL can be added even if search does not find it.
- One GraphQL request per poll (`search` for `is:pr is:open author:<you>`, split into chunks under the 256-character search limit).
- The first time a PR is seen its current comments and CI state are recorded silently, so adding a repository never replays history.
- One notification per PR per poll, grouping its new events. Clicking it opens the comment (or the PR) and marks the PR read.
- Your own comments are ignored; bot comments are ignored by default.
- CI is reported on a transition into success or failure for the PR's head commit. Success is off by default.
- Badge: number of unread events in «Мои PR»; red when there is a change request or a failed CI among them, `!` when the token or settings are missing. The review queue is not counted.
- Popup: PRs grouped by repository with review state, CI state and unread counters. Click opens the PR and marks it read; middle-click or Ctrl+click opens it in the background and keeps the popup open.

### Review queue

- **На ревью** tab: open, non-draft PRs in the repositories listed under «Репозитории для ревью» in settings, where your review is requested. Team requests count only with «Учитывать запросы на мои команды» on.
- Default sort «Нужнее всего»: tier 1 (your move) is always above tier 2 (approved, or changes requested with no commits since). Within a tier: hours waiting, plus bonuses for a re-review (+24 h), nobody having reviewed yet (+12 h) and XS/S size (+8 h). Each row shows its reason. Other sorts: longest waiting, newest, nobody reviewed, smallest first. Filters: all, first review, re-review.
- Row: size (XS–XL by changed lines), waiting time, approvals and changes requested by others, threads resolved/total, unanswered and answered open threads. Zero values are hidden.
- «Ждут автора» (collapsed): PRs you already reviewed where your review is no longer requested. Approved-by-you PRs are not shown.
- Hide with the eye icon (on hover): the row goes away with an undo toast. A hidden PR returns on its own when a new review request for you arrives. Hidden PRs are listed under settings, with «Вернуть» / «Вернуть все».
- Notifications, both off by default: a new review request, and a re-review request on a PR you already reviewed.

### Open in Claude

- Button on both tabs. Opens a new Claude Code session in Claude Desktop via `claude://code/new?q=…`. The prompt is pasted into the input, not sent.
- Two prompts in settings: one for others' PRs (default `Сделай ревью pull request {url}`), one for your own PRs. Placeholders: `{url}`, `{title}`, `{repo}`, `{number}`, `{author}`; unknown ones stay as written.
- Optional folder per repository (absolute path). It adds `folder=` to the link, and Claude Desktop asks to confirm it. Without a folder the parameter is omitted.
- Chrome asks once to allow opening Claude (tick "always allow"). The link opens in the current tab, so no blank tab is left behind.

## Tests

```bash
npm test
```
