import { icons } from "./lib/icons.js";
import { withDefaults, normalizeRepo, DEFAULT_SETTINGS } from "./lib/settings.js";
import { fetchViewer, checkRepos, fetchRepoSuggestions, fetchReviewRepoSuggestions } from "./lib/github.js";
import { createRepoPicker } from "./repo-picker.js";

const NOTIFY_KEYS = ["comments", "approvals", "changesRequested", "ciFailure", "ciSuccess"];

const TOKEN_URL = (() => {
  const params = new URLSearchParams({
    name: "PR Watcher",
    description: "Read-only token for the GitHub PR Watcher Chrome extension",
    expires_in: "366",
    pull_requests: "read",
    statuses: "read",
  });
  return `https://github.com/settings/personal-access-tokens/new?${params}`;
})();

const $ = (id) => document.getElementById(id);
const form = $("form");

const esc = (s) =>
  String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);

for (const el of document.querySelectorAll("[data-icon]")) el.innerHTML = icons[el.dataset.icon];
$("create-token").href = TOKEN_URL;

const unsaved = () => message("Есть несохранённые изменения", "");

const myPicker = createRepoPicker({
  chipsEl: $("chips"),
  searchEl: $("repo-search"),
  listEl: $("repo-list"),
  statusEl: $("picker-status"),
  loadSuggestions: fetchRepoSuggestions,
  getToken: () => $("token").value.trim(),
  onChange: () => {
    unsaved();
    renderFolders();
  },
});

const reviewPicker = createRepoPicker({
  chipsEl: $("review-chips"),
  searchEl: $("review-search"),
  listEl: $("review-list"),
  statusEl: $("review-status"),
  loadSuggestions: fetchReviewRepoSuggestions,
  getToken: () => $("token").value.trim(),
  texts: {
    noToken: "Вставьте токен, чтобы увидеть репозитории, где у вас просили ревью. Точное имя owner/name можно ввести и без него.",
    loading: "Загружаю репозитории, где у вас просили или делали ревью…",
  },
  onChange: () => {
    unsaved();
    renderFolders();
  },
});

function message(text, kind = "") {
  $("msg").textContent = text;
  $("msg").className = `msg${kind ? ` msg--${kind}` : ""}`;
}

function readForm() {
  const folders = {};
  for (const [repo, path] of Object.entries(folderState)) if (path.trim()) folders[repo] = path.trim();
  return {
    token: $("token").value.trim(),
    repos: myPicker.getSelected(),
    intervalMin: Number($("interval").value),
    ignoreBots: $("ignore-bots").checked,
    notify: Object.fromEntries(NOTIFY_KEYS.map((k) => [k, form.elements[k].checked])),
    review: {
      repos: reviewPicker.getSelected(),
      includeTeams: $("review-teams").checked,
      notify: { requested: $("review-notify-requested").checked, rerequested: $("review-notify-rerequested").checked },
    },
    claude: {
      reviewPrompt: $("prompt-review").value.trim() || DEFAULT_SETTINGS.claude.reviewPrompt,
      ownPrompt: $("prompt-own").value.trim() || DEFAULT_SETTINGS.claude.ownPrompt,
      folders,
    },
  };
}

const same = (a, b) => a.toLowerCase() === b.toLowerCase();
const exactRepos = (ids) => ids.filter((id) => !id.endsWith("/*"));

// Folder paths by repo id as typed; empty path means "no folder" and is dropped on save.
let folderState = {};

function folderRepos() {
  const repos = [];
  for (const id of [...exactRepos(reviewPicker.getSelected()), ...exactRepos(myPicker.getSelected()), ...Object.keys(folderState)]) {
    if (!repos.some((r) => same(r, id))) repos.push(id);
  }
  return repos;
}

const folderKey = (repo) => Object.keys(folderState).find((k) => same(k, repo));

function renderFolders() {
  const repos = folderRepos();
  const pickerIds = [...exactRepos(reviewPicker.getSelected()), ...exactRepos(myPicker.getSelected())];
  $("folders").innerHTML = repos
    .map((repo) => {
      const key = folderKey(repo);
      const removable = !pickerIds.some((id) => same(id, repo));
      const [owner, name] = repo.split("/");
      return `<li>
        <span class="folders__repo" title="${esc(repo)}">${repoLabel(owner, name)}</span>
        <input type="text" data-repo="${esc(repo)}" value="${esc(key ? folderState[key] : "")}" autocomplete="off" spellcheck="false"
          placeholder="Без папки" aria-label="Папка для ${esc(repo)}" />
        ${removable ? `<button type="button" class="chip__remove" data-remove-folder="${esc(repo)}" aria-label="Убрать ${esc(repo)}">${icons.x}</button>` : ""}
      </li>`;
    })
    .join("");
  $("folders-empty").hidden = repos.length > 0;
}

function repoLabel(owner, name) {
  return `<span class="repo-owner">${esc(owner)}/</span><span class="repo-name">${esc(name)}</span>`;
}

$("folders").addEventListener("input", (e) => {
  const input = e.target.closest("input[data-repo]");
  if (!input) return;
  folderState[folderKey(input.dataset.repo) ?? input.dataset.repo] = input.value;
  unsaved();
});

$("folders").addEventListener("click", (e) => {
  const btn = e.target.closest("[data-remove-folder]");
  if (!btn) return;
  delete folderState[folderKey(btn.dataset.removeFolder)];
  renderFolders();
  unsaved();
});

function addFolderRepo() {
  const input = $("folder-repo");
  const error = $("folder-error");
  const repo = normalizeRepo(input.value);
  if (!input.value.trim()) return;
  if (!repo || repo.endsWith("/*")) {
    error.textContent = "Нужно точное имя репозитория: owner/name";
    error.hidden = false;
    return;
  }
  error.hidden = true;
  if (!folderRepos().some((r) => same(r, repo))) folderState[repo] = "";
  input.value = "";
  renderFolders();
  const row = [...$("folders").querySelectorAll("input[data-repo]")].find((i) => same(i.dataset.repo, repo));
  row?.focus();
}

$("folder-add").addEventListener("click", addFolderRepo);
$("folder-repo").addEventListener("keydown", (e) => {
  if (e.key === "Enter") {
    e.preventDefault();
    addFolderRepo();
  }
});
$("folder-repo").addEventListener("input", () => ($("folder-error").hidden = true));

// Hidden review PRs, kept live from storage.
function renderHidden(ignored) {
  const rows = Object.entries(ignored ?? {}).sort(
    ([, a], [, b]) => (Date.parse(b.ignoredAt) || 0) - (Date.parse(a.ignoredAt) || 0),
  );
  $("hidden-card").hidden = rows.length === 0;
  $("hidden-list").innerHTML = rows
    .map(([key, pr]) => {
      const url = typeof pr.url === "string" && pr.url.startsWith("https://github.com/") ? pr.url : null;
      const label = `<span class="repo-owner">${esc(pr.repo)}#${esc(pr.number)}</span> ${esc(pr.title)}`;
      return `<li>
        ${url ? `<a href="${esc(url)}" target="_blank" rel="noopener" title="${esc(pr.title)}">${label}</a>` : `<span>${label}</span>`}
        <button type="button" class="link-button" data-unignore="${esc(key)}">Вернуть</button>
      </li>`;
    })
    .join("");
}

$("hidden-list").addEventListener("click", (e) => {
  const btn = e.target.closest("[data-unignore]");
  if (btn) chrome.runtime.sendMessage({ type: "unignore", key: btn.dataset.unignore });
});
$("unignore-all").addEventListener("click", () => chrome.runtime.sendMessage({ type: "unignoreAll" }));

chrome.storage.onChanged.addListener((changes, area) => {
  if (area === "local" && changes.reviewIgnored) renderHidden(changes.reviewIgnored.newValue);
});

function reloadPickers() {
  const token = $("token").value.trim();
  return Promise.all([myPicker.reload(token), reviewPicker.reload(token)]);
}

$("token").addEventListener("change", reloadPickers);
async function fill() {
  const { settings: stored, reviewIgnored } = await chrome.storage.local.get(["settings", "reviewIgnored"]);
  const s = withDefaults(stored);
  $("token").value = s.token;
  $("interval").value = String(s.intervalMin);
  $("ignore-bots").checked = s.ignoreBots;
  for (const k of NOTIFY_KEYS) form.elements[k].checked = s.notify[k];
  myPicker.setSelected(s.repos);
  reviewPicker.setSelected(s.review.repos);
  $("review-teams").checked = s.review.includeTeams;
  $("review-notify-requested").checked = s.review.notify.requested;
  $("review-notify-rerequested").checked = s.review.notify.rerequested;
  $("prompt-review").value = s.claude.reviewPrompt;
  $("prompt-own").value = s.claude.ownPrompt;
  folderState = { ...s.claude.folders };
  renderFolders();
  renderHidden(reviewIgnored);
  await reloadPickers();
}

form.addEventListener("submit", async (e) => {
  e.preventDefault();
  await chrome.storage.local.set({ settings: readForm() });
  message("Сохранено. Первая проверка запомнит текущее состояние, уведомления придут о том, что появится после.", "ok");
});

$("check").addEventListener("click", async () => {
  const settings = readForm();
  const results = $("results");
  results.hidden = true;
  if (!settings.token) return message("Сначала вставьте токен", "error");

  $("check").disabled = true;
  message("Проверяю…");
  try {
    const login = await fetchViewer(settings.token);
    const all = [...settings.repos];
    for (const r of settings.review.repos) if (!all.some((x) => same(x, r))) all.push(r);
    const repos = await checkRepos(settings.token, all);
    const rows = [
      `<li class="ok">${icons.check}токен принят, пользователь ${esc(login)}</li>`,
      ...Object.entries(repos).map(([repo, ok]) =>
        ok
          ? `<li class="ok">${icons.check}${esc(repo)}</li>`
          : `<li class="bad">${icons.x}${esc(repo)} — не найден или нет доступа</li>`,
      ),
    ];
    results.innerHTML = rows.join("");
    results.hidden = false;
    const bad = Object.values(repos).filter((ok) => !ok).length;
    message(bad ? `Недоступно репозиториев: ${bad}` : "Всё доступно", bad ? "error" : "ok");
  } catch (e) {
    message(e.message, "error");
  } finally {
    $("check").disabled = false;
  }
});

$("toggle-token").addEventListener("click", () => {
  const input = $("token");
  const show = input.type === "password";
  input.type = show ? "text" : "password";
  $("toggle-token").title = show ? "Скрыть токен" : "Показать токен";
});

fill();
