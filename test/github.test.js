import { test } from "node:test";
import assert from "node:assert/strict";
import {
  buildSearchQueries,
  buildPullRequestsQuery,
  normalizePullRequest,
  graphql,
  fetchPullRequests,
  reviewPrefixes,
  fetchReviewList,
  fetchReviewDetails,
  fetchReviewRepoSuggestions,
  GitHubError,
} from "../lib/github.js";

test("search queries stay under the length limit and cover every repo", () => {
  const repos = Array.from({ length: 20 }, (_, i) => `VirtoCommerce/vc-module-something-${i}`);
  const queries = buildSearchQueries(repos, "is:pr is:open archived:false author:ivan");
  assert.ok(queries.length > 1);
  for (const q of queries) {
    assert.ok(q.length <= 256, `${q.length} chars`);
    assert.ok(q.startsWith("is:pr is:open archived:false author:ivan "));
  }
  for (const r of repos) assert.ok(queries.some((q) => q.includes(`repo:${r}`)));
});

test("owner wildcard becomes a user: qualifier", () => {
  assert.deepEqual(buildSearchQueries(["acme/*", "x/y"], "is:pr is:open archived:false author:me"), [
    "is:pr is:open archived:false author:me user:acme repo:x/y",
  ]);
  assert.deepEqual(buildSearchQueries([], "is:pr is:open archived:false author:me"), []);
});

test("query has one aliased search per chunk", () => {
  const q = buildPullRequestsQuery(2);
  assert.match(q, /\$q0: String!, \$q1: String!/);
  assert.match(q, /s0: search\(query: \$q0/);
  assert.match(q, /s1: search\(query: \$q1/);
});

const node = {
  number: 7,
  title: "Add thing",
  url: "https://github.com/o/r/pull/7",
  isDraft: false,
  updatedAt: "2026-01-02T00:00:00Z",
  reviewDecision: "APPROVED",
  repository: { nameWithOwner: "o/r" },
  commits: { nodes: [{ commit: { oid: "abc", statusCheckRollup: { state: "SUCCESS" } } }] },
  reviews: {
    nodes: [
      { id: "R1", state: "APPROVED", body: "", url: "r1", submittedAt: "2026-01-01T03:00:00Z", author: { __typename: "User", login: "alice" } },
      { id: "R2", state: "COMMENTED", body: "", url: "r2", submittedAt: "2026-01-01T02:00:00Z", author: { __typename: "User", login: "bob" } },
      { id: "R3", state: "COMMENTED", body: "looks off", url: "r3", submittedAt: "2026-01-01T01:00:00Z", author: { __typename: "User", login: "bob" } },
      { id: "R4", state: "PENDING", body: "", url: "r4", submittedAt: null, author: { __typename: "User", login: "carol" } },
      { id: "R5", state: "APPROVED", body: "", url: "r5", submittedAt: "2026-01-01T04:00:00Z", author: { __typename: "User", login: "Me" } },
    ],
  },
  comments: {
    nodes: [
      { id: "C1", url: "c1", createdAt: "2026-01-01T00:30:00Z", author: { __typename: "Bot", login: "sonarqubecloud" } },
      { id: "C2", url: "c2", createdAt: "2026-01-01T00:40:00Z", author: null },
    ],
  },
  reviewThreads: {
    nodes: [
      {
        id: "TH1",
        isResolved: false,
        comments: {
          nodes: [
            { id: "T1", url: "t1", createdAt: "2026-01-01T00:10:00Z", state: "SUBMITTED", author: { __typename: "User", login: "bob" } },
            { id: "T2", url: "t2", createdAt: "2026-01-01T00:20:00Z", state: "PENDING", author: { __typename: "User", login: "bob" } },
            { id: "T3", url: "t3", createdAt: "2026-01-01T00:25:00Z", state: "SUBMITTED", author: { __typename: "User", login: "me" } },
          ],
        },
      },
      {
        id: "TH2",
        isResolved: true,
        comments: {
          nodes: [
            { id: "T4", url: "t4", createdAt: "2026-01-01T00:05:00Z", state: "SUBMITTED", author: { __typename: "User", login: "bob" } },
          ],
        },
      },
    ],
  },
};

test("normalize keeps others' reviews and comments, sorted by time", () => {
  const pr = normalizePullRequest(node, "me");
  assert.equal(pr.key, "o/r#7");
  assert.deepEqual(pr.ci, { sha: "abc", state: "SUCCESS" });
  assert.deepEqual(
    pr.events.map((e) => `${e.id}:${e.kind}`),
    ["T4:comment", "T1:comment", "C1:comment", "C2:comment", "R3:comment", "R1:approved"],
  );
  assert.equal(pr.events.find((e) => e.id === "C1").isBot, true);
  assert.equal(pr.events.find((e) => e.id === "C2").author, "ghost");
});

test("normalize records threads, resolved threads and your own latest activity", () => {
  const pr = normalizePullRequest(node, "me");
  assert.equal(pr.events.find((e) => e.id === "T1").thread, "TH1");
  assert.equal(pr.events.find((e) => e.id === "C1").thread, undefined);
  assert.deepEqual(pr.resolvedThreads, ["TH2"]);
  assert.deepEqual(pr.viewerActivity, {
    lastAt: "2026-01-01T04:00:00Z",
    threads: { TH1: "2026-01-01T00:25:00Z" },
  });
});

test("normalize tolerates a PR without commits or checks", () => {
  const pr = normalizePullRequest({ ...node, commits: { nodes: [] }, reviewDecision: null }, "me");
  assert.deepEqual(pr.ci, { sha: null, state: null });
  assert.equal(pr.reviewDecision, null);
});

function fakeFetch(status, body, headers = {}) {
  return async () => ({
    status,
    ok: status >= 200 && status < 300,
    headers: { get: (h) => headers[h] ?? null },
    json: async () => body,
  });
}

test("graphql maps HTTP failures to typed errors", async () => {
  await assert.rejects(graphql("t", "q", {}, fakeFetch(401, {})), (e) => e instanceof GitHubError && e.kind === "auth");
  await assert.rejects(graphql("t", "q", {}, fakeFetch(403, {}, { "x-ratelimit-reset": "0" })), (e) => e.kind === "rate");
  await assert.rejects(
    graphql("t", "q", {}, async () => {
      throw new Error("offline");
    }),
    (e) => e.kind === "network",
  );
  await assert.rejects(graphql("t", "q", {}, fakeFetch(200, { errors: [{ message: "bad" }] })), /bad/);
});

test("fetchPullRequests merges chunks and dedupes PRs", async () => {
  const repos = Array.from({ length: 20 }, (_, i) => `VirtoCommerce/vc-module-something-${i}`);
  let sent;
  const fetchImpl = async (_url, init) => {
    sent = JSON.parse(init.body);
    const data = { rateLimit: { cost: 1, remaining: 99, resetAt: "x" } };
    for (const k of Object.keys(sent.variables)) data[`s${k.slice(1)}`] = { issueCount: 1, nodes: [node, {}] };
    return fakeFetch(200, { data })();
  };
  const result = await fetchPullRequests("t", "me", repos, fetchImpl);
  assert.ok(Object.keys(sent.variables).length > 1);
  assert.equal(result.prs.length, 1);
  assert.equal(result.rateLimit.remaining, 99);
});

const reply = (data) => async () => ({
  ok: true,
  status: 200,
  headers: new Headers(),
  json: async () => ({ data }),
});

test("review prefixes switch between direct and team requests", () => {
  assert.ok(reviewPrefixes("me", false).queue.includes("user-review-requested:me"));
  const teams = reviewPrefixes("me", true).queue;
  assert.ok(teams.includes("review-requested:me"));
  assert.ok(!teams.includes("user-review-requested"));
  assert.ok(reviewPrefixes("me", false).waiting.includes("reviewed-by:me -author:me"));
});

test("review prefixes sort by update time so a capped result is the most recent window", () => {
  for (const teams of [false, true]) {
    const p = reviewPrefixes("me", teams);
    assert.ok(p.queue.includes("sort:updated-desc"));
    assert.ok(p.waiting.includes("sort:updated-desc"));
    const repos = Array.from({ length: 30 }, (_, i) => `SomeOrganization/some-repository-${i}`);
    for (const q of buildSearchQueries(repos, p.waiting)) assert.ok(q.length <= 256, q);
  }
});

test("review list requests issueCount and reports truncation", async () => {
  const pr = (n) => ({ id: `P${n}`, number: n, updatedAt: "2026-01-01T00:00:00Z", repository: { nameWithOwner: "o/r" } });
  let body;
  const respond = (data) => async (url, init) => {
    body = JSON.parse(init.body);
    return reply(data)();
  };
  const settings = { repos: ["o/r"], includeTeams: false };
  const full = await fetchReviewList("t", "me", settings, respond({
    q0: { issueCount: 1, nodes: [pr(1)] },
    w0: { issueCount: 2, nodes: [pr(2), pr(3)] },
  }));
  assert.equal(full.truncated, false);
  assert.match(body.query, /q0: search\([^)]*\) \{ issueCount nodes/);
  assert.match(body.query, /w0: search\([^)]*\) \{ issueCount nodes/);
  const cut = await fetchReviewList("t", "me", settings, respond({
    q0: { issueCount: 1, nodes: [pr(1)] },
    w0: { issueCount: 120, nodes: [pr(2), pr(3)] },
  }));
  assert.equal(cut.truncated, true);
  const empty = await fetchReviewList("t", "me", { repos: [], includeTeams: false }, async () => {
    throw new Error("network must not be called");
  });
  assert.equal(empty.truncated, false);
});

test("review list puts a PR in the queue only, never in both", async () => {
  const pr = { id: "P1", number: 5, updatedAt: "2026-01-01T00:00:00Z", repository: { nameWithOwner: "o/r" } };
  const fetchImpl = reply({
    rateLimit: { cost: 1, remaining: 4999, resetAt: "x" },
    q0: { nodes: [pr] },
    w0: { nodes: [pr] },
  });
  const res = await fetchReviewList("t", "me", { repos: ["o/r"], includeTeams: false }, fetchImpl);
  assert.equal(res.queue.length, 1);
  assert.equal(res.waiting.length, 0);
  assert.deepEqual(res.queue[0], { id: "P1", key: "o/r#5", updatedAt: "2026-01-01T00:00:00Z" });
});

test("review list skips the network when no review repos are set", async () => {
  const fetchImpl = async () => {
    throw new Error("network must not be called");
  };
  const res = await fetchReviewList("t", "me", { repos: [], includeTeams: false }, fetchImpl);
  assert.deepEqual(res.queue, []);
  assert.deepEqual(res.waiting, []);
});

test("details are fetched in batches of 20 ids", async () => {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push(JSON.parse(init.body).variables.ids);
    return reply({ rateLimit: { cost: 1 }, nodes: [{ id: "x" }] })();
  };
  const ids = Array.from({ length: 45 }, (_, i) => `P${i}`);
  const res = await fetchReviewDetails("t", ids, fetchImpl);
  assert.deepEqual(calls.map((c) => c.length), [20, 20, 5]);
  assert.equal(res.nodes.length, 3);
});

test("review repo suggestions use review-requested and reviewed-by searches", async () => {
  let body;
  const fetchImpl = async (_url, init) => {
    body = JSON.parse(init.body).query;
    return fakeFetch(200, {
      data: {
        viewer: { login: "me" },
        open: { nodes: [{ repository: { nameWithOwner: "o/a" } }, null] },
        recent: { nodes: [{ repository: { nameWithOwner: "o/b" } }] },
      },
    })();
  };
  const res = await fetchReviewRepoSuggestions("t", fetchImpl);
  assert.ok(body.includes("is:pr is:open archived:false review-requested:@me"));
  assert.ok(body.includes("is:pr reviewed-by:@me sort:updated-desc"));
  assert.equal(res.viewer, "me");
  assert.deepEqual(res.openRepos.map((r) => r.nameWithOwner), ["o/a"]);
  assert.deepEqual(res.recentRepos.map((r) => r.nameWithOwner), ["o/b"]);
});
