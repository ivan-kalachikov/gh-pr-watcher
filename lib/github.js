export const API_URL = "https://api.github.com/graphql";

const SEARCH_LIMIT = 50;
const MAX_QUERY_LENGTH = 240;

const PR_FIELDS = `
  ... on PullRequest {
    id
    number
    title
    url
    isDraft
    updatedAt
    reviewDecision
    repository { nameWithOwner }
    commits(last: 1) {
      nodes { commit { oid statusCheckRollup { state } } }
    }
    reviews(last: 30) {
      nodes { id state body url submittedAt author { __typename login } }
    }
    comments(last: 30) {
      nodes { id url createdAt author { __typename login } }
    }
    reviewThreads(last: 30) {
      nodes {
        comments(last: 10) {
          nodes { id url createdAt state author { __typename login } }
        }
      }
    }
  }`;

export class GitHubError extends Error {
  constructor(message, { status, kind } = {}) {
    super(message);
    this.name = "GitHubError";
    this.status = status;
    this.kind = kind ?? "api";
  }
}

function repoQualifier(repo) {
  return repo.endsWith("/*") ? `user:${repo.slice(0, -2)}` : `repo:${repo}`;
}

/** Splits repos into search strings that stay under GitHub's 256-char limit. */
export function buildSearchQueries(repos, login) {
  const prefix = `is:pr is:open archived:false author:${login}`;
  const queries = [];
  let current = prefix;
  for (const repo of repos) {
    const qualifier = ` ${repoQualifier(repo)}`;
    if (current !== prefix && current.length + qualifier.length > MAX_QUERY_LENGTH) {
      queries.push(current);
      current = prefix;
    }
    current += qualifier;
  }
  if (current !== prefix) queries.push(current);
  return queries;
}

export function buildPullRequestsQuery(count) {
  const vars = [];
  const fields = [];
  for (let i = 0; i < count; i++) {
    vars.push(`$q${i}: String!`);
    fields.push(
      `s${i}: search(query: $q${i}, type: ISSUE, first: ${SEARCH_LIMIT}) { issueCount nodes { ${PR_FIELDS} } }`,
    );
  }
  return `query PrWatcher(${vars.join(", ")}) {
  rateLimit { cost remaining resetAt }
  ${fields.join("\n  ")}
}`;
}

export async function graphql(token, query, variables, fetchImpl = fetch) {
  let res;
  try {
    res = await fetchImpl(API_URL, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ query, variables }),
    });
  } catch (e) {
    throw new GitHubError(`Сеть недоступна: ${e.message}`, { kind: "network" });
  }

  if (res.status === 401) {
    throw new GitHubError("Токен не принят GitHub (401)", { status: 401, kind: "auth" });
  }
  if (res.status === 403 || res.status === 429) {
    const reset = res.headers.get("x-ratelimit-reset");
    const at = reset ? new Date(Number(reset) * 1000).toLocaleTimeString() : "";
    throw new GitHubError(`Лимит запросов GitHub исчерпан${at ? `, сброс в ${at}` : ""}`, {
      status: res.status,
      kind: "rate",
    });
  }
  if (!res.ok) {
    throw new GitHubError(`GitHub ответил ${res.status}`, { status: res.status });
  }

  const json = await res.json();
  if (json.errors?.length && !json.data) {
    throw new GitHubError(json.errors.map((e) => e.message).join("; "));
  }
  return { data: json.data, errors: json.errors ?? [] };
}

export async function fetchViewer(token, fetchImpl) {
  const { data } = await graphql(token, "query { viewer { login } }", {}, fetchImpl);
  return data.viewer.login;
}

export async function checkRepos(token, repos, fetchImpl) {
  const exact = repos.filter((r) => !r.endsWith("/*"));
  const owners = repos.filter((r) => r.endsWith("/*")).map((r) => r.slice(0, -2));
  const parts = [
    ...exact.map((r, i) => {
      const [owner, name] = r.split("/");
      return `r${i}: repository(owner: ${JSON.stringify(owner)}, name: ${JSON.stringify(name)}) { nameWithOwner }`;
    }),
    ...owners.map((o, i) => `o${i}: repositoryOwner(login: ${JSON.stringify(o)}) { login }`),
  ];
  if (!parts.length) return {};
  const { data } = await graphql(token, `query { ${parts.join("\n")} }`, {}, fetchImpl);
  const result = {};
  exact.forEach((r, i) => (result[r] = Boolean(data?.[`r${i}`])));
  owners.forEach((o, i) => (result[`${o}/*`] = Boolean(data?.[`o${i}`])));
  return result;
}

const REPO_FIELDS = "nameWithOwner isArchived isPrivate description";

/** Repositories where the viewer has open or recent pull requests. */
export async function fetchRepoSuggestions(token, fetchImpl) {
  const query = `query {
  viewer { login }
  open: search(query: "is:pr is:open archived:false author:@me", type: ISSUE, first: 100) {
    nodes { ... on PullRequest { repository { ${REPO_FIELDS} } } }
  }
  recent: search(query: "is:pr author:@me sort:updated-desc", type: ISSUE, first: 100) {
    nodes { ... on PullRequest { repository { ${REPO_FIELDS} } } }
  }
}`;
  const { data } = await graphql(token, query, {}, fetchImpl);
  const repos = (s) => (s?.nodes ?? []).map((n) => n?.repository).filter(Boolean);
  return { viewer: data.viewer?.login ?? null, openRepos: repos(data.open), recentRepos: repos(data.recent) };
}

/** Runs the strings from buildRepoSearch; scoped results come first. */
export async function searchRepositories(token, { scoped, global }, fetchImpl) {
  const parts = [];
  const variables = {};
  if (scoped) {
    parts.push(`scoped: search(query: $scoped, type: REPOSITORY, first: 20) { nodes { ... on Repository { ${REPO_FIELDS} } } }`);
    variables.scoped = scoped;
  }
  if (global) {
    parts.push(`global: search(query: $global, type: REPOSITORY, first: 10) { nodes { ... on Repository { ${REPO_FIELDS} } } }`);
    variables.global = global;
  }
  if (!parts.length) return [];
  const defs = Object.keys(variables).map((k) => `$${k}: String!`).join(", ");
  const { data } = await graphql(token, `query(${defs}) { ${parts.join("\n")} }`, variables, fetchImpl);
  const seen = new Set();
  return [...(data.scoped?.nodes ?? []), ...(data.global?.nodes ?? [])].filter((r) => {
    const key = r?.nameWithOwner?.toLowerCase();
    if (!key || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function isBot(author) {
  return author?.__typename === "Bot" || /\[bot\]$/.test(author?.login ?? "");
}

function event(kind, node, at) {
  return {
    id: node.id,
    kind,
    author: node.author?.login ?? "ghost",
    isBot: isBot(node.author),
    url: node.url,
    at,
  };
}

const REVIEW_KINDS = {
  APPROVED: "approved",
  CHANGES_REQUESTED: "changes_requested",
};

/** Flattens a PullRequest node into the shape the watcher stores and diffs. */
export function normalizePullRequest(node, viewerLogin) {
  const viewer = viewerLogin.toLowerCase();
  const events = [];

  for (const r of node.reviews?.nodes ?? []) {
    if (!r?.submittedAt) continue;
    const kind = REVIEW_KINDS[r.state] ?? (r.state === "COMMENTED" && r.body?.trim() ? "comment" : null);
    if (kind) events.push(event(kind, r, r.submittedAt));
  }
  for (const c of node.comments?.nodes ?? []) {
    if (c) events.push(event("comment", c, c.createdAt));
  }
  for (const thread of node.reviewThreads?.nodes ?? []) {
    for (const c of thread?.comments?.nodes ?? []) {
      if (c && c.state !== "PENDING") events.push(event("comment", c, c.createdAt));
    }
  }

  const commit = node.commits?.nodes?.[0]?.commit;
  const repo = node.repository.nameWithOwner;

  return {
    key: `${repo}#${node.number}`,
    repo,
    number: node.number,
    title: node.title,
    url: node.url,
    isDraft: node.isDraft,
    updatedAt: node.updatedAt,
    reviewDecision: node.reviewDecision ?? null,
    ci: { sha: commit?.oid ?? null, state: commit?.statusCheckRollup?.state ?? null },
    events: events
      .filter((e) => e.author.toLowerCase() !== viewer)
      .sort((a, b) => a.at.localeCompare(b.at)),
  };
}

export async function fetchPullRequests(token, login, repos, fetchImpl) {
  const queries = buildSearchQueries(repos, login);
  if (!queries.length) return { prs: [], rateLimit: null, warnings: [] };

  const variables = Object.fromEntries(queries.map((q, i) => [`q${i}`, q]));
  const { data, errors } = await graphql(token, buildPullRequestsQuery(queries.length), variables, fetchImpl);

  const byKey = new Map();
  for (let i = 0; i < queries.length; i++) {
    for (const node of data?.[`s${i}`]?.nodes ?? []) {
      if (!node?.number) continue;
      const pr = normalizePullRequest(node, login);
      byKey.set(pr.key, pr);
    }
  }
  return {
    prs: [...byKey.values()],
    rateLimit: data?.rateLimit ?? null,
    warnings: errors.map((e) => e.message),
  };
}
