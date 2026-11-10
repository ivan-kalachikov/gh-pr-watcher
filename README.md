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

The token stays in `chrome.storage.local` of this Chrome profile and is sent only to `api.github.com`.

## Behaviour

- Repositories are picked from a searchable list: repositories where you have open or recent PRs, "all repositories" of each owner among them, and GitHub repository search as you type (your owners first). An exact `owner/name` or GitHub URL can be added even if search does not find it.
- One GraphQL request per poll (`search` for `is:pr is:open author:<you>`, split into chunks under the 256-character search limit).
- The first time a PR is seen its current comments and CI state are recorded silently, so adding a repository never replays history.
- One notification per PR per poll, grouping its new events. Clicking it opens the comment (or the PR) and marks the PR read.
- Your own comments are ignored; bot comments are ignored by default.
- CI is reported on a transition into success or failure for the PR's head commit. Success is off by default.
- Badge: number of unread events; red when there is a change request or a failed CI among them, `!` when the token or settings are missing.
- Popup: PRs grouped by repository with review state, CI state and unread counters. Click opens the PR and marks it read; middle-click or Ctrl+click opens it in the background and keeps the popup open.

## Tests

```bash
npm test
```
