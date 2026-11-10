import { test } from "node:test";
import assert from "node:assert/strict";
import { buildSuggestions, buildRepoSearch, pickerItems, toggleRepo, coveringWildcard } from "../lib/repos.js";
import { searchRepositories } from "../lib/github.js";

const r = (nameWithOwner, extra = {}) => ({ nameWithOwner, isArchived: false, isPrivate: false, description: null, ...extra });

const { items: suggestions, owners } = buildSuggestions({
  viewer: "ivan",
  openRepos: [r("VC/front"), r("VC/front"), r("VC/cms"), r("ivan/pet")],
  recentRepos: [r("VC/front"), r("VC/deploy", { isArchived: true }), r("Other/lib")],
});

test("suggestions rank repos by open PRs and add owner wildcards", () => {
  assert.deepEqual(owners, ["VC", "ivan", "Other"]);
  assert.deepEqual(
    suggestions.map((i) => `${i.id}:${i.openPrs}`),
    ["VC/*:0", "ivan/*:0", "Other/*:0", "VC/front:2", "VC/cms:1", "ivan/pet:1", "VC/deploy:0", "Other/lib:0"],
  );
  assert.equal(suggestions.find((i) => i.id === "VC/deploy").archived, true);
});

test("search strings scope to your owners and to an owner prefix", () => {
  assert.equal(buildRepoSearch("a", owners), null);
  assert.deepEqual(buildRepoSearch("front", owners), {
    scoped: "front in:name user:VC user:ivan user:Other",
    global: "front in:name",
  });
  assert.deepEqual(buildRepoSearch("VC/fr", owners), { scoped: "user:VC fr in:name", global: null });
  assert.deepEqual(buildRepoSearch("https://github.com/VC/", owners), { scoped: "user:VC sort:updated", global: null });
  assert.equal(buildRepoSearch("bad owner!/x", owners), null);
});

const ids = (rows) => rows.map((x) => x.id);

test("empty query lists selections first, then suggestions", () => {
  const rows = pickerItems({ query: "", suggestions, remote: [], selected: ["Elsewhere/thing", "VC/cms"] });
  assert.deepEqual(ids(rows).slice(0, 3), ["Elsewhere/thing", "VC/cms", "VC/*"]);
  assert.equal(rows.find((x) => x.id === "VC/cms").checked, true);
  assert.equal(rows.length, suggestions.length + 1);
});

test("query filters locally and appends GitHub results without duplicates", () => {
  const remote = [
    { id: "VC/front", owner: "VC", name: "front", wildcard: false, openPrs: 0 },
    { id: "X/frontier", owner: "X", name: "frontier", wildcard: false, openPrs: 0 },
  ];
  const rows = pickerItems({ query: "front", suggestions, remote, selected: [] });
  assert.deepEqual(ids(rows), ["VC/front", "X/frontier"]);
  assert.equal(rows[1].remote, true);
  assert.equal(rows[0].openPrs, 2, "the suggestion wins over the bare search hit");
});

test("a typed owner/name or URL can be added even when unknown", () => {
  const rows = pickerItems({ query: "https://github.com/New/repo", suggestions, remote: [], selected: [] });
  assert.equal(rows[0].id, "New/repo");
  assert.equal(rows[0].manual, true);

  const prefix = pickerItems({
    query: "VC/fr",
    suggestions,
    remote: [{ id: "VC/frost", owner: "VC", name: "frost", wildcard: false, openPrs: 0 }],
    selected: [],
  });
  assert.deepEqual(ids(prefix), ["VC/front", "VC/frost", "VC/fr"], "a half-typed name stays below real matches");
  const wildcard = pickerItems({ query: "VC/*", suggestions, remote: [], selected: [] });
  assert.equal(wildcard[0].id, "VC/*");
  assert.equal(wildcard[0].manual, undefined, "known wildcard is not marked manual");
});

test("repos covered by a selected wildcard are shown checked and locked", () => {
  const rows = pickerItems({ query: "", suggestions, remote: [], selected: ["vc/*"] });
  const front = rows.find((x) => x.id === "VC/front");
  assert.equal(front.checked, true);
  assert.equal(front.coveredBy, "vc/*");
  assert.equal(rows.find((x) => x.id === "VC/*").checked, true);
  assert.equal(coveringWildcard("ivan/pet", ["vc/*"]), null);
});

test("toggle adds and removes case-insensitively", () => {
  assert.deepEqual(toggleRepo(["VC/front"], "vc/FRONT"), []);
  assert.deepEqual(toggleRepo(["VC/front"], "VC/cms"), ["VC/front", "VC/cms"]);
});

test("searchRepositories sends only the present parts and dedupes", async () => {
  let body;
  const fetchImpl = async (_u, init) => {
    body = JSON.parse(init.body);
    return {
      status: 200,
      ok: true,
      headers: { get: () => null },
      json: async () => ({ data: { scoped: { nodes: [r("VC/front"), {}] }, global: { nodes: [r("vc/front"), r("X/y")] } } }),
    };
  };
  const out = await searchRepositories("t", { scoped: "a", global: "b" }, fetchImpl);
  assert.deepEqual(Object.keys(body.variables), ["scoped", "global"]);
  assert.deepEqual(out.map((x) => x.nameWithOwner), ["VC/front", "X/y"]);
  assert.deepEqual(await searchRepositories("t", { scoped: null, global: null }, fetchImpl), []);
});
