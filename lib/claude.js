export const MAX_PROMPT = 14000;

const PLACEHOLDER_RE = /\{(url|title|repo|number|author)\}/g;

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

export function claudeLink({ prompt, folder } = {}) {
  let link = `claude://code/new?q=${encodeURIComponent(prompt.slice(0, MAX_PROMPT))}`;
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
