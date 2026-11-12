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
  review: Object.freeze({
    repos: Object.freeze([]),
    includeTeams: false,
    notify: Object.freeze({ requested: false, rerequested: false }),
  }),
  claude: Object.freeze({
    reviewPrompt: "Сделай ревью pull request {url}",
    ownPrompt: "Разбери комментарии ревьюеров в моём pull request {url} и предложи, что исправить",
    folders: Object.freeze({}),
  }),
});

const isPlainObject = (v) => typeof v === "object" && v !== null && !Array.isArray(v);

export function withDefaults(stored) {
  const s = stored ?? {};
  const review = isPlainObject(s.review) ? s.review : {};
  const claude = isPlainObject(s.claude) ? s.claude : {};
  return {
    ...DEFAULT_SETTINGS,
    ...s,
    repos: Array.isArray(s.repos) ? s.repos : [],
    notify: { ...DEFAULT_SETTINGS.notify, ...(s.notify ?? {}) },
    review: {
      ...DEFAULT_SETTINGS.review,
      ...review,
      repos: Array.isArray(review.repos) ? review.repos : [],
      notify: { ...DEFAULT_SETTINGS.review.notify, ...(isPlainObject(review.notify) ? review.notify : {}) },
    },
    claude: {
      ...DEFAULT_SETTINGS.claude,
      ...claude,
      folders: isPlainObject(claude.folders) ? { ...claude.folders } : {},
    },
  };
}

const OWNER = "[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})";
const NAME = "[A-Za-z0-9._-]+";
const REPO_RE = new RegExp(`^(${OWNER})/(${NAME}|\\*)$`);

/**
 * Accepts "owner/name", "owner/*" or a github.com URL; returns "owner/name",
 * "owner/*", or null when the text is not a repository.
 */
export function normalizeRepo(text) {
  const s = text
    .trim()
    .replace(/^https?:\/\/(www\.)?github\.com\//i, "")
    .replace(/\.git$/i, "");
  const [owner, name] = s.split("/").filter(Boolean);
  if (!owner || !name) return null;
  const candidate = `${owner}/${name}`;
  return REPO_RE.test(candidate) ? candidate : null;
}

export function prMatchesRepo(prRepo, configured) {
  const a = prRepo.toLowerCase();
  const b = configured.toLowerCase();
  if (b.endsWith("/*")) return a.startsWith(b.slice(0, -1));
  return a === b;
}
