# GitHub PR Watcher

Chrome extension (MV3) that watches your open pull requests in chosen repositories and sends a system notification when someone comments, approves, requests changes, or CI finishes.

## Install

1. `chrome://extensions` → enable **Developer mode** → **Load unpacked** → pick this folder.
2. The settings page opens on install. Paste a token, list repositories, save.

## Token

Read-only is enough. The "Create fine-grained token" link on the settings page pre-fills
`Pull requests`, `Commit statuses` and `Checks` (read). For public organization repositories pick
**Public repositories**: no organization approval is needed. A classic token works too:
no scopes for public repositories, `repo` for private ones.

The token stays in `chrome.storage.local` of this Chrome profile and is sent only to `api.github.com`.

## Behaviour

- Repositories: `owner/name`, a GitHub URL, or `owner/*` for every repository of a user or organization.
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
