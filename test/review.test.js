import { test } from "node:test";
import assert from "node:assert/strict";
import {
  normalizeReviewPr,
  didReview,
  sizeOf,
  reviewKind,
  waitingSince,
  rankQueue,
  waitAge,
  formatWait,
  WEIGHTS,
} from "../lib/review.js";

const ME = "ivan";
const NOW = Date.parse("2026-11-12T12:00:00Z");
const hoursAgo = (h) => new Date(NOW - h * 3600 * 1000).toISOString();

let seq = 0;
function node(o = {}) {
  seq++;
  return {
    id: `PR_${seq}`,
    number: seq,
    title: `PR ${seq}`,
    url: `https://github.com/o/r/pull/${seq}`,
    updatedAt: "2026-11-10T00:00:00Z",
    isDraft: false,
    createdAt: "2026-11-01T00:00:00Z",
    additions: 50,
    deletions: 50,
    changedFiles: 3,
    reviewDecision: null,
    repository: { nameWithOwner: "o/r" },
    author: { __typename: "User", login: "alice" },
    commits: { nodes: [] },
    timelineItems: { nodes: [] },
    reviewRequests: { nodes: [] },
    reviews: { nodes: [] },
    reviewThreads: { nodes: [] },
    ...o,
  };
}
const review = (login, state, submittedAt, extra = {}) => ({
  state,
  body: "",
  submittedAt,
  author: { __typename: "User", login },
  commit: { oid: "abc" },
  comments: { nodes: [] },
  ...extra,
});
const request = (createdAt, reviewer = { login: ME }) => ({ createdAt, requestedReviewer: reviewer });
const commit = (committedDate, state = null) => ({
  commit: { committedDate, statusCheckRollup: state ? { state } : null },
});
const norm = (o, opts = {}) => normalizeReviewPr(node(o), ME, opts);
// pr with a fixed wait so hours are predictable
const waiting = (h, o = {}) => norm({ timelineItems: { nodes: [request(hoursAgo(h))] }, ...o });
const othersReviewed = { reviews: { nodes: [review("bob", "APPROVED", "2026-11-02T00:00:00Z")] } };

test("didReview follows the specification", () => {
  assert.equal(didReview(review(ME, "CHANGES_REQUESTED", "2026-11-01"), ME), true);
  const reply = review(ME, "COMMENTED", "2026-11-01", { comments: { nodes: [{ replyTo: { id: "c1" } }] } });
  assert.equal(didReview(reply, ME), false);
  const own = review(ME, "COMMENTED", "2026-11-01", { comments: { nodes: [{ replyTo: null }] } });
  assert.equal(didReview(own, ME), true);
  assert.equal(didReview(review("bob", "APPROVED", "2026-11-01"), ME), false);
  assert.equal(didReview(review("IVAN", "APPROVED", "2026-11-01"), ME), true);
  assert.equal(didReview(review(ME, "COMMENTED", "2026-11-01", { body: "  looks odd " }), ME), true);
});

test("a reply in someone else's thread does not make it a re-review", () => {
  const reply = review(ME, "COMMENTED", "2026-11-05T00:00:00Z", { comments: { nodes: [{ replyTo: { id: "c1" } }] } });
  const pr = norm({ reviews: { nodes: [reply] } });
  assert.equal(reviewKind(pr), "first");
  assert.equal(pr.myLastReviewAt, null);
  assert.equal(pr.myLastReviewState, null);
});

test("normalization maps the basic fields", () => {
  const pr = norm({
    commits: { nodes: [commit("2026-11-02T00:00:00Z", "SUCCESS"), commit("2026-11-03T00:00:00Z", "FAILURE")] },
    reviewDecision: "REVIEW_REQUIRED",
  });
  assert.equal(pr.key, `o/r#${pr.number}`);
  assert.equal(pr.repo, "o/r");
  assert.equal(pr.author, "alice");
  assert.equal(pr.ci, "FAILURE");
  assert.equal(pr.reviewDecision, "REVIEW_REQUIRED");
  assert.equal(norm().ci, null);
});

test("waiting falls back to createdAt without a request event", () => {
  const pr = norm();
  assert.equal(pr.requestedAt, null);
  assert.equal(waitingSince(pr), pr.createdAt);
  const [item] = rankQueue([pr], "need", NOW);
  assert.ok(Number.isFinite(item.score));
});

test("the latest request to me wins and requests to others are ignored", () => {
  const pr = norm({
    timelineItems: {
      nodes: [
        request("2026-11-02T00:00:00Z"),
        request("2026-11-04T00:00:00Z", { login: "Ivan" }),
        request("2026-11-09T00:00:00Z", { login: "bob" }),
      ],
    },
  });
  assert.equal(pr.requestedAt, "2026-11-04T00:00:00Z");
});

test("re-review waits from the first commit after my review", () => {
  const pr = norm({
    reviews: { nodes: [review(ME, "CHANGES_REQUESTED", "2026-11-01T10:00:00Z")] },
    commits: {
      nodes: [commit("2026-10-30T00:00:00Z"), commit("2026-11-03T08:00:00Z"), commit("2026-11-05T08:00:00Z")],
    },
  });
  assert.equal(reviewKind(pr), "rerequest");
  assert.equal(pr.myLastReviewState, "CHANGES_REQUESTED");
  assert.equal(pr.firstCommitAfterMyReview, "2026-11-03T08:00:00Z");
  assert.ok(waitingSince(pr).startsWith("2026-11-03"));
});

test("re-review takes the earlier of a later request and the first new commit", () => {
  const pr = norm({
    reviews: { nodes: [review(ME, "APPROVED", "2026-11-01T00:00:00Z")] },
    commits: { nodes: [commit("2026-11-05T00:00:00Z")] },
    timelineItems: { nodes: [request("2026-10-20T00:00:00Z"), request("2026-11-04T00:00:00Z")] },
  });
  assert.equal(waitingSince(pr), "2026-11-04T00:00:00Z");
  const old = norm({
    reviews: { nodes: [review(ME, "APPROVED", "2026-11-01T00:00:00Z")] },
    timelineItems: { nodes: [request("2026-10-20T00:00:00Z")] },
  });
  assert.equal(waitingSince(old), "2026-10-20T00:00:00Z");
});

test("team requests count only with includeTeams", () => {
  const n = { timelineItems: { nodes: [request("2026-11-06T00:00:00Z", { slug: "core" })] } };
  assert.equal(norm(n, { includeTeams: false }).requestedAt, null);
  assert.equal(norm(n, { includeTeams: true }).requestedAt, "2026-11-06T00:00:00Z");
});

test("threads split into resolved, answered and unanswered", () => {
  const t = (isResolved, login) => ({ isResolved, comments: { nodes: [{ author: { __typename: "User", login }, }] } });
  const pr = norm({
    reviewThreads: {
      nodes: [t(true, "bob"), t(true, "alice"), t(false, "alice"), t(false, "bob"), t(false, "carol")],
    },
  });
  assert.deepEqual(pr.threads, { resolved: 2, unresolved: 3, answered: 1, unanswered: 2 });
});

test("other reviewers: latest significant state, ignoring me, the author and bots", () => {
  const pr = norm({
    reviews: {
      nodes: [
        review("bob", "CHANGES_REQUESTED", "2026-11-02T00:00:00Z"),
        review("bob", "APPROVED", "2026-11-03T00:00:00Z"),
        review("carol", "APPROVED", "2026-11-02T00:00:00Z"),
        review("carol", "DISMISSED", "2026-11-03T00:00:00Z"),
        review("dave", "CHANGES_REQUESTED", "2026-11-04T00:00:00Z"),
        review("dave", "COMMENTED", "2026-11-05T00:00:00Z", { body: "hm" }),
        review("alice", "APPROVED", "2026-11-04T00:00:00Z"),
        review(ME, "APPROVED", "2026-11-04T00:00:00Z"),
        { ...review("ci-bot[bot]", "APPROVED", "2026-11-04T00:00:00Z"), author: { __typename: "Bot", login: "ci-bot[bot]" } },
      ],
    },
  });
  assert.deepEqual(pr.approvedBy, ["bob"]);
  assert.deepEqual(pr.changesRequestedBy, ["dave"]);
  assert.equal(pr.reviewedByOthers, true);
});

test("reviewedByOthers ignores me, the author, bots and lone thread replies", () => {
  const reply = review("bob", "COMMENTED", "2026-11-02", { comments: { nodes: [{ replyTo: { id: "x" } }] } });
  const botReview = { ...review("ci[bot]", "COMMENTED", "2026-11-02", { body: "report" }), author: { __typename: "Bot", login: "ci[bot]" } };
  const pr = norm({
    reviews: {
      nodes: [reply, botReview, review("alice", "COMMENTED", "2026-11-02", { body: "self" }), review(ME, "APPROVED", "2026-11-02")],
    },
  });
  assert.equal(pr.reviewedByOthers, false);
});

test("changesPendingAuthor clears once the author pushes a commit", () => {
  const cr = { reviews: { nodes: [review("bob", "CHANGES_REQUESTED", "2026-11-02T00:00:00Z")] } };
  assert.equal(norm({ ...cr, commits: { nodes: [commit("2026-11-01T00:00:00Z")] } }).changesPendingAuthor, true);
  assert.equal(norm({ ...cr, commits: { nodes: [commit("2026-11-03T00:00:00Z")] } }).changesPendingAuthor, false);
  assert.equal(norm({}).changesPendingAuthor, false);
});

test("sizes follow the thresholds", () => {
  const size = (n) => sizeOf({ additions: n, deletions: 0 });
  assert.equal(size(10), "XS");
  assert.equal(size(11), "S");
  assert.equal(size(100), "S");
  assert.equal(size(400), "M");
  assert.equal(size(1000), "L");
  assert.equal(size(1001), "XL");
  assert.equal(sizeOf({ additions: 600, deletions: 401 }), "XL");
});

test("tier 2 always ranks below tier 1", () => {
  const a = waiting(300, { reviewDecision: "APPROVED" });
  const b = waiting(1);
  const ranked = rankQueue([a, b], "need", NOW);
  assert.equal(ranked[0].pr.key, b.key);
  assert.equal(ranked[1].tier, 2);
  assert.equal(ranked[1].reasons[0], "уже хватает апрувов");
});

test("changes pending on the author is tier 2", () => {
  const pr = waiting(5, { reviews: { nodes: [review("bob", "CHANGES_REQUESTED", "2026-11-02T00:00:00Z")] } });
  const [item] = rankQueue([pr], "need", NOW);
  assert.equal(item.tier, 2);
  assert.equal(item.reasons[0], "ждёт автора после запроса изменений");
});

test("re-review outranks an equally old first review", () => {
  const big = { additions: 150, deletions: 150 };
  const first = waiting(10, { ...big, ...othersReviewed });
  const again = waiting(10, {
    ...big,
    reviews: { nodes: [review(ME, "APPROVED", "2026-11-01T00:00:00Z"), review("bob", "APPROVED", "2026-11-02T00:00:00Z")] },
  });
  const ranked = rankQueue([first, again], "need", NOW);
  assert.equal(ranked[0].pr.key, again.key);
  assert.equal(ranked[0].score, 10 + WEIGHTS.rerequest);
  assert.equal(ranked[0].score, 34);
  assert.ok(Math.abs(ranked[1].score - 10) < 1e-9);
});

test("failed CI does not lower the rank", () => {
  const mk = (state) => waiting(7, { commits: { nodes: [commit("2026-11-01T00:00:00Z", state)] } });
  const [bad] = rankQueue([mk("FAILURE")], "need", NOW);
  const [good] = rankQueue([mk("SUCCESS")], "need", NOW);
  assert.equal(bad.score, good.score);
});

test("reasons are capped at three", () => {
  const pr = waiting(30, { reviewDecision: "APPROVED", additions: 1, deletions: 1 });
  const [item] = rankQueue([pr], "need", NOW);
  assert.equal(item.reasons.length, 3);
  assert.deepEqual(item.reasons, ["уже хватает апрувов", "никто не смотрел", "маленький"]);
});

test("reasons for tier 1 list factors by weight, then the wait", () => {
  const pr = waiting(50, { additions: 1, deletions: 1 });
  const [item] = rankQueue([pr], "need", NOW);
  assert.deepEqual(item.reasons, ["никто не смотрел", "маленький", "ждёт 2 д"]);
  const [young] = rankQueue([waiting(6, { additions: 300, deletions: 0, ...othersReviewed })], "need", NOW);
  assert.deepEqual(young.reasons, ["ждёт 6 ч"]);
});

test("other sorts order as described", () => {
  const a = waiting(10, { additions: 500, deletions: 0, ...othersReviewed }); // old-ish, big, reviewed
  const b = waiting(2, { additions: 5, deletions: 0 }); // new, small, unreviewed
  const c = waiting(40, { additions: 100, deletions: 0 }); // oldest, unreviewed
  const keys = (sort) => rankQueue([a, b, c], sort, NOW).map((x) => x.pr.key);
  assert.deepEqual(keys("oldest"), [c.key, a.key, b.key]);
  assert.deepEqual(keys("newest"), [b.key, a.key, c.key]);
  assert.deepEqual(keys("unreviewed"), [c.key, b.key, a.key]);
  assert.deepEqual(keys("smallest"), [b.key, c.key, a.key]);
  assert.deepEqual(rankQueue([a], "oldest", NOW)[0].reasons, []);
});

test("ties break by key", () => {
  const x = norm({ repository: { nameWithOwner: "o/b" }, number: 1 });
  const y = norm({ repository: { nameWithOwner: "o/a" }, number: 1 });
  assert.deepEqual(rankQueue([x, y], "need", NOW).map((i) => i.pr.key), ["o/a#1", "o/b#1"]);
});

test("waitAge and formatWait use the documented thresholds", () => {
  assert.equal(waitAge(47.9), "normal");
  assert.equal(waitAge(48), "warn");
  assert.equal(waitAge(119.9), "warn");
  assert.equal(waitAge(120), "late");
  assert.equal(formatWait(6.4), "6 ч");
  assert.equal(formatWait(23.9), "23 ч");
  assert.equal(formatWait(24), "1 д");
  assert.equal(formatWait(100), "4 д");
});
