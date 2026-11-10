import { normalizeRepo } from "./settings.js";

const OWNER_RE = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/;

const same = (a, b) => a.toLowerCase() === b.toLowerCase();

function repoItem(repo, extra = {}) {
  const [owner, name] = repo.nameWithOwner.split("/");
  return {
    id: repo.nameWithOwner,
    owner,
    name,
    wildcard: false,
    openPrs: 0,
    archived: Boolean(repo.isArchived),
    isPrivate: Boolean(repo.isPrivate),
    description: repo.description ?? null,
    ...extra,
  };
}

function wildcardItem(owner) {
  return { id: `${owner}/*`, owner, name: "*", wildcard: true, openPrs: 0 };
}

function itemFor(id) {
  const [owner, name] = id.split("/");
  return name === "*" ? wildcardItem(owner) : { id, owner, name, wildcard: false, openPrs: 0 };
}

/**
 * Repositories worth offering without a query: those with your open PRs first,
 * then those with recent PRs, plus "owner/*" for every owner among them and you.
 */
export function buildSuggestions({ viewer, openRepos, recentRepos }) {
  const byId = new Map();
  for (const repo of openRepos) {
    const key = repo.nameWithOwner.toLowerCase();
    const item = byId.get(key) ?? repoItem(repo);
    item.openPrs++;
    byId.set(key, item);
  }
  for (const repo of recentRepos) {
    const key = repo.nameWithOwner.toLowerCase();
    if (!byId.has(key)) byId.set(key, repoItem(repo));
  }

  const repos = [...byId.values()].sort((a, b) => b.openPrs - a.openPrs);
  const owners = [];
  for (const o of [...repos.map((r) => r.owner), viewer].filter(Boolean)) {
    if (!owners.some((x) => same(x, o))) owners.push(o);
  }
  return { owners, items: [...owners.map(wildcardItem), ...repos] };
}

/** GitHub repository-search strings for what the user typed, or null when there is nothing to search. */
export function buildRepoSearch(text, owners) {
  const t = text.trim().replace(/^https?:\/\/(www\.)?github\.com\//i, "");
  if (t.includes("/")) {
    const [owner, part = ""] = t.split("/");
    if (!OWNER_RE.test(owner)) return null;
    return { scoped: part ? `user:${owner} ${part} in:name` : `user:${owner} sort:updated`, global: null };
  }
  if (t.length < 2) return null;
  const mine = owners.filter((o) => OWNER_RE.test(o)).map((o) => `user:${o}`);
  return { scoped: mine.length ? `${t} in:name ${mine.join(" ")}` : null, global: `${t} in:name` };
}

function matches(item, query) {
  if (!query) return true;
  const q = query.toLowerCase().replace(/^https?:\/\/(www\.)?github\.com\//, "");
  const id = item.id.toLowerCase();
  return item.wildcard ? id.startsWith(q.replace(/\*$/, "")) || item.owner.toLowerCase().includes(q) : id.includes(q);
}

export function coveringWildcard(id, selected) {
  const owner = id.split("/")[0];
  return selected.find((s) => s.endsWith("/*") && same(s.slice(0, -2), owner)) ?? null;
}

/**
 * Rows for the picker: what you typed as an exact repo, then your selected and
 * suggested repos that match, then GitHub search results.
 */
export function pickerItems({ query, suggestions, remote, selected }) {
  const q = query.trim();
  const seen = new Set();
  const rows = [];
  const push = (item, extra = {}) => {
    const key = item.id.toLowerCase();
    if (seen.has(key)) return;
    seen.add(key);
    const checked = selected.some((s) => same(s, item.id));
    const coveredBy = !item.wildcard && !checked ? coveringWildcard(item.id, selected) : null;
    rows.push({ ...item, ...extra, checked: checked || Boolean(coveredBy), coveredBy });
  };

  const known = [...suggestions, ...remote];
  const lookup = (id) => known.find((i) => same(i.id, id));

  const exact = q ? normalizeRepo(q) : null;
  const hit = exact ? lookup(exact) : null;
  if (hit) push(hit);
  for (const id of selected) {
    const item = lookup(id) ?? itemFor(id);
    if (matches(item, q)) push(item);
  }
  for (const item of suggestions) if (matches(item, q)) push(item);
  for (const item of remote) push(item, { remote: true });
  // A typed name nobody suggested goes last, so a prefix being typed never outranks real matches.
  if (exact && !hit) push(itemFor(exact), { manual: true });
  return rows;
}

export function toggleRepo(selected, id) {
  return selected.some((s) => same(s, id)) ? selected.filter((s) => !same(s, id)) : [...selected, id];
}

export { repoItem };
