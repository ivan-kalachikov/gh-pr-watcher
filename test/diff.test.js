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

const inThread = (id, thread, at, author = "bob") => comment(id, author, { thread, at });
const T0 = "2026-01-01T00:00:00Z";
const T1 = "2026-01-01T01:00:00Z";
const T2 = "2026-01-01T02:00:00Z";

function poll(prev, overrides) {
  return run(prev, [pr(overrides)]);
}

test("a thread comment stops being unread once you reply in that thread", () => {
  const base = poll({}, {}).prs;
  const events = [inThread("c1", "th1", T0), inThread("c2", "th2", T0)];
  const reviewed = poll(base, { events });
  assert.equal(reviewed.prs["o/r#1"].unread.comments, 2);

  const replied = poll(reviewed.prs, { events, viewerActivity: { lastAt: T1, threads: { th1: T1 } } });
  assert.equal(replied.prs["o/r#1"].unread.comments, 1, "the other thread is still unanswered");
  assert.deepEqual(replied.changes, []);
});

test("resolving a thread clears its comments", () => {
  const base = poll({}, {}).prs;
  const events = [inThread("c1", "th1", T0), inThread("c2", "th1", T0, "carol")];
  const reviewed = poll(base, { events });
  const resolved = poll(reviewed.prs, { events, resolvedThreads: ["th1"] });
  assert.equal(totalUnread(resolved.prs), 0);
});

test("a comment newer than your reply stays unread", () => {
  const base = poll({}, {}).prs;
  const events = [inThread("c1", "th1", T0), inThread("c2", "th1", T2)];
  const out = poll(base, { events, viewerActivity: { lastAt: T1, threads: { th1: T1 } } });
  assert.equal(out.prs["o/r#1"].unread.comments, 1);
  assert.deepEqual(
    out.changes[0].events.map((e) => e.id),
    ["c2"],
    "an already answered comment is not notified",
  );
});

test("top-level comments and reviews clear after any later activity of yours", () => {
  const base = poll({}, {}).prs;
  const events = [comment("c1", "bob", { at: T0 }), { ...comment("r1", "alice", { at: T0 }), kind: "approved" }];
  const reviewed = poll(base, { events });
  assert.equal(totalUnread(reviewed.prs), 2);
  const answered = poll(reviewed.prs, { events, viewerActivity: { lastAt: T1, threads: { other: T1 } } });
  assert.equal(totalUnread(answered.prs), 0);
});

test("counters stored before this change are rebuilt from the newest events", () => {
  const events = [inThread("c1", "th1", T0), inThread("c2", "th2", T0), inThread("c3", "th3", T0)];
  const legacy = {
    "o/r#1": { ...pr(), seen: ["c1", "c2", "c3"], unread: { comments: 2, approvals: 0, changes: 0, ci: null } },
  };
  const untouched = poll(legacy, { events });
  assert.deepEqual(
    untouched.prs["o/r#1"].pending.map((p) => p.id),
    ["c2", "c3"],
  );
  const answered = poll(legacy, { events, viewerActivity: { lastAt: T1, threads: { th2: T1, th3: T1 } } });
  assert.equal(totalUnread(answered.prs), 0);
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
