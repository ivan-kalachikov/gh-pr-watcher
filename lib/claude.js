export const MAX_PROMPT = 14000;

const PLACEHOLDER_RE = /\{(url|title|repo|number|author)\}/g;

const isHighSurrogate = (code) => code >= 0xd800 && code <= 0xdbff;

export function fillTemplate(template, pr) {
  const values = {
    url: pr.url ?? "",
    title: pr.title ?? "",
    repo: pr.repo ?? "",
    number: pr.number ?? "",
    author: pr.author ?? "",
  };
  return template.replace(PLACEHOLDER_RE, (_, key) => String(values[key]));
}

function truncatePrompt(text) {
  if (text.length <= MAX_PROMPT) return text;
  let end = MAX_PROMPT;
  if (isHighSurrogate(text.charCodeAt(end - 1))) end -= 1;
  return text.slice(0, end);
}

export function claudeLink({ prompt, folder } = {}) {
  const text = typeof prompt === "string" ? prompt : "";
  let link = `claude://code/new?q=${encodeURIComponent(truncatePrompt(text))}`;
  const dir = typeof folder === "string" ? folder.trim() : "";
  if (dir) link += `&folder=${encodeURIComponent(dir)}`;
  return link;
}

export function folderFor(folders, repo) {
  const wanted = repo.toLowerCase();
  for (const [key, path] of Object.entries(folders ?? {})) {
    if (key.toLowerCase() === wanted) return path;
  }
  return null;
}
