import { test } from "node:test";
import assert from "node:assert/strict";
import { diffPullRequests, markRead, markAllRead, totalUnread } from "../lib/diff.js";
import { withDefaults } from "../lib/settings.js";

const settings = withDefaults({});

function pr(overrides = {}) {
  return {
    key: "o/r#1",
    repo: "o/r",
    number: 1,
    title: "Fix",
    url: "https://github.com/o/r/pull/1",
    isDraft: false,
    reviewDecision: "REVIEW_REQUIRED",
    ci: { sha: "a", state: "PENDING" },
    events: [],
    ...overrides,
  };
}

const comment = (id, author = "bob", extra = {}) => ({
  id,
  kind: "comment",
  author,
  isBot: false,
  url: `u/${id}`,
  at: "2026-01-01T00:00:00Z",
  ...extra,
});

function run(prev, prs, s = settings) {
  return diffPullRequests(prev, prs, s);
}

test("a PR seen for the first time is recorded without changes", () => {
  const { prs, changes } = run({}, [pr({ events: [comment("c1")], ci: { sha: "a", state: "FAILURE" } })]);
  assert.deepEqual(changes, []);
  assert.deepEqual(prs["o/r#1"].seen, ["c1"]);
  assert.equal(totalUnread(prs), 0);
});

test("new comments are reported once and counted as unread", () => {
  const first = run({}, [pr({ events: [comment("c1")] })]).prs;
  const second = run(first, [pr({ events: [comment("c1"), comment("c2", "carol")] })]);
  assert.equal(second.changes.length, 1);
  assert.deepEqual(
    second.changes[0].events.map((e) => e.id),
    ["c2"],
  );
  assert.equal(second.prs["o/r#1"].unread.comments, 1);

  const third = run(second.prs, [pr({ events: [comment("c1"), comment("c2", "carol")] })]);
  assert.deepEqual(third.changes, []);
  assert.equal(third.prs["o/r#1"].unread.comments, 1, "unread persists until read");
});

test("bot comments are skipped when ignoreBots is on but still marked seen", () => {
  const first = run({}, [pr()]).prs;
  const bot = comment("b1", "sonar[bot]", { isBot: true });
  const second = run(first, [pr({ events: [bot] })]);
  assert.deepEqual(second.changes, []);
  assert.deepEqual(second.prs["o/r#1"].seen, ["b1"]);

  const withBots = withDefaults({ ignoreBots: false });
  const third = run(first, [pr({ events: [bot] })], withBots);
  assert.equal(third.changes.length, 1);
});

test("approvals and change requests respect their toggles", () => {
  const first = run({}, [pr()]).prs;
  const events = [
    { ...comment("r1", "alice"), kind: "approved" },
    { ...comment("r2", "dan"), kind: "changes_requested" },
  ];
  const on = run(first, [pr({ events })]);
  assert.equal(on.prs["o/r#1"].unread.approvals, 1);
  assert.equal(on.prs["o/r#1"].unread.changes, 1);
  assert.deepEqual(on.prs["o/r#1"].approvedBy, ["alice"]);
  assert.deepEqual(on.prs["o/r#1"].changesRequestedBy, ["dan"]);

  const off = run(first, [pr({ events })], withDefaults({ notify: { approvals: false, changesRequested: false } }));
  assert.deepEqual(off.changes, []);
});

test("a reviewer's latest decision wins", () => {
  const events = [
    { ...comment("r1", "alice"), kind: "changes_requested" },
    { ...comment("r2", "alice"), kind: "approved" },
  ];
  const { prs } = run({}, [pr({ events })]);
  assert.deepEqual(prs["o/r#1"].approvedBy, ["alice"]);
  assert.deepEqual(prs["o/r#1"].changesRequestedBy, []);
});

test("CI failure is reported on transition, not on every poll", () => {
  const first = run({}, [pr({ ci: { sha: "a", state: "PENDING" } })]).prs;
  const failed = run(first, [pr({ ci: { sha: "a", state: "FAILURE" } })]);
  assert.equal(failed.changes[0].ci, "failure");
  assert.equal(failed.prs["o/r#1"].unread.ci, "failure");

  const again = run(failed.prs, [pr({ ci: { sha: "a", state: "FAILURE" } })]);
  assert.deepEqual(again.changes, []);

  const newPush = run(again.prs, [pr({ ci: { sha: "b", state: "ERROR" } })]);
  assert.equal(newPush.changes[0].ci, "failure", "a new commit that fails is reported");
});

test("CI success is silent by default and clears a stale failure flag", () => {
  const first = run({}, [pr({ ci: { sha: "a", state: "PENDING" } })]).prs;
  const failed = run(first, [pr({ ci: { sha: "a", state: "FAILURE" } })]).prs;
  const fixed = run(failed, [pr({ ci: { sha: "b", state: "SUCCESS" } })]);
  assert.deepEqual(fixed.changes, []);
  assert.equal(fixed.prs["o/r#1"].unread.ci, null);

  const loud = run(failed, [pr({ ci: { sha: "b", state: "SUCCESS" } })], withDefaults({ notify: { ciSuccess: true } }));
  assert.equal(loud.changes[0].ci, "success");
});

test("PRs that are no longer open are dropped", () => {
  const first = run({}, [pr(), pr({ key: "o/r#2", number: 2 })]).prs;
  const second = run(first, [pr()]);
  assert.deepEqual(Object.keys(second.prs), ["o/r#1"]);
});

test("markRead and markAllRead reset unread counters", () => {
  const first = run({}, [pr(), pr({ key: "o/r#2", number: 2 })]).prs;
  const second = run(first, [
    pr({ events: [comment("c1")] }),
    pr({ key: "o/r#2", number: 2, events: [comment("c2")] }),
  ]).prs;
  assert.equal(totalUnread(second), 2);
  assert.equal(totalUnread(markRead(second, "o/r#1")), 1);
  assert.equal(totalUnread(markAllRead(second)), 0);
});
