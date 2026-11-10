export const DEFAULT_SETTINGS = Object.freeze({
  token: "",
  repos: [],
  intervalMin: 2,
  ignoreBots: true,
  notify: Object.freeze({
    comments: true,
    approvals: true,
    changesRequested: true,
    ciFailure: true,
    ciSuccess: false,
  }),
});

export function withDefaults(stored) {
  const s = stored ?? {};
  return {
    ...DEFAULT_SETTINGS,
    ...s,
    repos: Array.isArray(s.repos) ? s.repos : [],
    notify: { ...DEFAULT_SETTINGS.notify, ...(s.notify ?? {}) },
  };
}

const OWNER = "[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})";
const NAME = "[A-Za-z0-9._-]+";
const REPO_RE = new RegExp(`^(${OWNER})/(${NAME}|\\*)$`);

/**
 * Accepts "owner/name", "owner/*" or a github.com URL; returns "owner/name",
 * "owner/*", or null when the line is not a repository.
 */
export function normalizeRepo(line) {
  let s = line.trim();
  if (!s || s.startsWith("#")) return null;
  s = s.replace(/^https?:\/\/(www\.)?github\.com\//i, "").replace(/\.git$/i, "");
  const [owner, name] = s.split("/").filter(Boolean);
  if (!owner || !name) return null;
  const candidate = `${owner}/${name}`;
  return REPO_RE.test(candidate) ? candidate : null;
}

export function parseRepos(text) {
  const valid = [];
  const invalid = [];
  for (const raw of text.split(/[\n,]+/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const repo = normalizeRepo(line);
    if (repo) {
      if (!valid.some((r) => r.toLowerCase() === repo.toLowerCase())) valid.push(repo);
    } else {
      invalid.push(line);
    }
  }
  return { valid, invalid };
}

export function prMatchesRepo(prRepo, configured) {
  const a = prRepo.toLowerCase();
  const b = configured.toLowerCase();
  if (b.endsWith("/*")) return a.startsWith(b.slice(0, -1));
  return a === b;
}
