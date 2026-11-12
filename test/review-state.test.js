import { test } from "node:test";
import assert from "node:assert/strict";
import {
  EMPTY_REVIEW_STATE,
  needsDetails,
  diffReviewQueue,
  reposKey,
  pruneIgnored,
} from "../lib/review-state.js";

const pr = (key, over = {}) => ({ key, requestedAt: "2026-11-01T10:00:00Z", myLastReviewAt: null, ...over });
const queueOf = (...prs) => Object.fromEntries(prs.map((p) => [p.key, p]));
const settings = (requested, rerequested) => ({
  review: { repos: [], includeTeams: false, notify: { requested, rerequested } },
});
const state = (queue, over = {}) => ({ ...EMPTY_REVIEW_STATE, queue, baselined: true, ...over });

test("first poll after enabling or changing repos is silent", () => {
  const next = queueOf(pr("a/b#1"), pr("a/b#2"), pr("a/b#3", { myLastReviewAt: "2026-10-01T00:00:00Z" }));
  const { changes } = diffReviewQueue({ ...EMPTY_REVIEW_STATE, baselined: false }, next, settings(true, true));
  assert.deepEqual(changes, []);
});

test("new first-time request notifies only when enabled", () => {
  const next = queueOf(pr("a/b#1"));
  const prev = state({});
  assert.deepEqual(diffReviewQueue(prev, next, settings(false, true)).changes, []);
  const { changes } = diffReviewQueue(prev, next, settings(true, false));
  assert.equal(changes.length, 1);
  assert.equal(changes[0].kind, "requested");
  assert.equal(changes[0].pr.key, "a/b#1");
  // already known key: no notification
  assert.deepEqual(diffReviewQueue(state(next), next, settings(true, true)).changes, []);
});

test("re-request notifies when requestedAt moves forward", () => {
  const reviewed = { myLastReviewAt: "2026-10-01T00:00:00Z" };
  const prev = state(queueOf(pr("a/b#1", { ...reviewed, requestedAt: "2026-11-01T10:00:00Z" })));
  const same = queueOf(pr("a/b#1", { ...reviewed, requestedAt: "2026-11-01T10:00:00Z" }));
  assert.deepEqual(diffReviewQueue(prev, same, settings(true, true)).changes, []);
  // different string format, same instant
  const sameInstant = queueOf(pr("a/b#1", { ...reviewed, requestedAt: "2026-11-01T10:00:00.000Z" }));
  assert.deepEqual(diffReviewQueue(prev, sameInstant, settings(true, true)).changes, []);
  const newer = queueOf(pr("a/b#1", { ...reviewed, requestedAt: "2026-11-02T10:00:00Z" }));
  assert.deepEqual(diffReviewQueue(prev, newer, settings(true, false)).changes, []);
  const { changes } = diffReviewQueue(prev, newer, settings(false, true));
  assert.equal(changes.length, 1);
  assert.equal(changes[0].kind, "rerequested");
  // key absent before, reviewed PR: also a re-request
  const fresh = diffReviewQueue(state({}), newer, settings(true, true)).changes;
  assert.deepEqual(fresh.map((c) => c.kind), ["rerequested"]);
});

test("ignored PR returns on a newer review request, not on new commits", () => {
  const ignoredAt = "2026-11-05T00:00:00Z";
  const entry = { ignoredAt, title: "t", url: "u", repo: "a/b", number: 1 };
  const ignored = { "a/b#1": entry, "a/b#2": { ...entry, number: 2 } };
  const queue = queueOf(
    pr("a/b#1", { requestedAt: "2026-11-01T10:00:00Z", updatedAt: "2026-11-10T00:00:00Z" }),
    pr("a/b#2", { requestedAt: "2026-11-06T10:00:00Z" }),
  );
  const out = pruneIgnored(ignored, queue, {});
  assert.deepEqual(Object.keys(out), ["a/b#1"]);
  const noRequest = pruneIgnored(ignored, queueOf(pr("a/b#1", { requestedAt: null })), {});
  assert.deepEqual(Object.keys(noRequest), ["a/b#1"]);
});

test("ignored PR that is gone from both lists is pruned", () => {
  const entry = { ignoredAt: "2026-11-05T00:00:00Z", title: "t", url: "u", repo: "a/b", number: 1 };
  const ignored = { "a/b#1": entry, "a/b#2": entry, "a/b#3": entry };
  const out = pruneIgnored(ignored, queueOf(pr("a/b#1")), { "a/b#2": pr("a/b#2") });
  assert.deepEqual(Object.keys(out).sort(), ["a/b#1", "a/b#2"]);
  assert.ok(ignored["a/b#3"], "input is not mutated");
});

test("details are refetched on updatedAt change or after 10 minutes", () => {
  const now = 10_000_000;
  const item = { id: "x", key: "a/b#1", updatedAt: "2026-11-01T10:00:00Z" };
  const cached = { pr: { key: "a/b#1", updatedAt: "2026-11-01T10:00:00Z" }, fetchedAt: now - 60_000 };
  assert.equal(needsDetails(item, undefined, now), true);
  assert.equal(needsDetails(item, cached, now), false);
  assert.equal(needsDetails({ ...item, updatedAt: "2026-11-01T10:05:00Z" }, cached, now), true);
  assert.equal(needsDetails(item, { ...cached, fetchedAt: now - 10 * 60_000 }, now), false);
  assert.equal(needsDetails(item, { ...cached, fetchedAt: now - 10 * 60_000 - 1 }, now), true);
});

test("reposKey is order and case insensitive and includes includeTeams", () => {
  const a = reposKey({ repos: ["Foo/Bar", "baz/qux"], includeTeams: false });
  assert.equal(a, reposKey({ repos: ["BAZ/qux", "foo/bar"], includeTeams: false }));
  assert.notEqual(a, reposKey({ repos: ["baz/qux", "foo/bar"], includeTeams: true }));
  assert.notEqual(a, reposKey({ repos: ["baz/qux"], includeTeams: false }));
});
