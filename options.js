import { icons } from "./lib/icons.js";
import { withDefaults } from "./lib/settings.js";
import { fetchViewer, checkRepos, fetchRepoSuggestions, searchRepositories } from "./lib/github.js";
import { buildSuggestions, buildRepoSearch, pickerItems, toggleRepo, repoItem } from "./lib/repos.js";
import { plural } from "./lib/format.js";

const NOTIFY_KEYS = ["comments", "approvals", "changesRequested", "ciFailure", "ciSuccess"];
const SEARCH_DEBOUNCE_MS = 350;

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

const picker = {
  selected: [],
  suggestions: [],
  owners: [],
  remote: [],
  status: "",
  loadedFor: null,
};

function message(text, kind = "") {
  $("msg").textContent = text;
  $("msg").className = `msg${kind ? ` msg--${kind}` : ""}`;
}

function readForm() {
  return {
    token: $("token").value.trim(),
    repos: [...picker.selected],
    intervalMin: Number($("interval").value),
    ignoreBots: $("ignore-bots").checked,
    notify: Object.fromEntries(NOTIFY_KEYS.map((k) => [k, form.elements[k].checked])),
  };
}

function repoLabel(owner, name) {
  return `<span class="repo-owner">${esc(owner)}/</span><span class="repo-name">${esc(name)}</span>`;
}

function renderChips() {
  $("chips").innerHTML = picker.selected.length
    ? picker.selected
        .map((id) => {
          const [owner, name] = id.split("/");
          return `<span class="chip">${name === "*" ? `${repoLabel(owner, "")}<span class="chip__all">все</span>` : repoLabel(owner, name)}
            <button type="button" class="chip__remove" data-remove="${esc(id)}" aria-label="Убрать ${esc(id)}">${icons.x}</button></span>`;
        })
        .join("")
    : `<span class="chips__empty">Ничего не выбрано — отметьте репозитории в списке ниже</span>`;
}

function rowMeta(item) {
  if (item.coveredBy) return `<span class="tag">входит в ${esc(item.coveredBy)}</span>`;
  const tags = [];
  if (item.wildcard) tags.push(`<span class="tag">все репозитории</span>`);
  if (item.openPrs) {
    const n = item.openPrs;
    tags.push(`<span class="tag tag--accent">${n} ${plural(n, ["открытый PR", "открытых PR", "открытых PR"])}</span>`);
  }
  if (item.manual) tags.push(`<span class="tag">добавить вручную</span>`);
  if (item.archived) tags.push(`<span class="tag">архив</span>`);
  if (item.isPrivate) tags.push(`<span class="tag" title="Приватный">${icons.lock}</span>`);
  return tags.join("");
}

function renderList() {
  const query = $("repo-search").value;
  const rows = pickerItems({ query, suggestions: picker.suggestions, remote: picker.remote, selected: picker.selected });
  const firstRemote = rows.findIndex((r) => r.remote);
  $("repo-list").innerHTML = rows
    .map((item, i) => {
      const header = i === firstRemote ? `<li class="picker__group">Поиск на GitHub</li>` : "";
      const name = repoLabel(item.owner, item.name);
      return `${header}<li>
        <label class="picker__row${item.coveredBy ? " picker__row--covered" : ""}">
          <input type="checkbox" value="${esc(item.id)}" ${item.checked ? "checked" : ""} ${item.coveredBy ? "disabled" : ""} />
          <span class="picker__main">
            <span class="picker__name">${name}</span>
            ${item.description ? `<span class="picker__desc">${esc(item.description)}</span>` : ""}
          </span>
          <span class="picker__meta">${rowMeta(item)}</span>
        </label>
      </li>`;
    })
    .join("");
  const empty = !rows.length;
  $("picker-status").textContent = picker.status || (empty ? (query ? "Ничего не найдено" : "") : "");
}

function render() {
  renderChips();
  renderList();
}

function setStatus(text) {
  picker.status = text;
  render();
}

async function loadSuggestions() {
  const token = $("token").value.trim();
  if (!token) {
    picker.suggestions = [];
    picker.owners = [];
    picker.loadedFor = null;
    return setStatus("Вставьте токен, чтобы увидеть репозитории, где у вас есть PR. Точное имя owner/name можно ввести и без него.");
  }
  if (picker.loadedFor === token) return;
  picker.loadedFor = token;
  setStatus("Загружаю репозитории, где у вас есть PR…");
  try {
    const result = buildSuggestions(await fetchRepoSuggestions(token));
    if (picker.loadedFor !== token) return;
    picker.suggestions = result.items;
    picker.owners = result.owners;
    setStatus("");
  } catch (e) {
    picker.loadedFor = null;
    setStatus(`Не удалось загрузить список: ${e.message}`);
  }
}

let searchTimer;
let searchSeq = 0;

function scheduleSearch() {
  clearTimeout(searchTimer);
  picker.remote = [];
  renderList();
  const token = $("token").value.trim();
  const search = buildRepoSearch($("repo-search").value, picker.owners);
  if (!token || !search) {
    if (picker.status.startsWith("Ищу")) setStatus("");
    return;
  }
  searchTimer = setTimeout(async () => {
    const seq = ++searchSeq;
    setStatus("Ищу на GitHub…");
    try {
      const repos = await searchRepositories(token, search);
      if (seq !== searchSeq) return;
      picker.remote = repos.map((r) => repoItem(r));
      setStatus("");
    } catch (e) {
      if (seq === searchSeq) setStatus(`Поиск не удался: ${e.message}`);
    }
  }, SEARCH_DEBOUNCE_MS);
}

function toggle(id) {
  picker.selected = toggleRepo(picker.selected, id);
  render();
  message("Есть несохранённые изменения", "");
}

$("repo-list").addEventListener("change", (e) => {
  if (e.target.matches('input[type="checkbox"]')) toggle(e.target.value);
});

$("chips").addEventListener("click", (e) => {
  const btn = e.target.closest("[data-remove]");
  if (btn) toggle(btn.dataset.remove);
});

$("repo-search").addEventListener("input", () => {
  renderList();
  scheduleSearch();
});

$("repo-search").addEventListener("keydown", (e) => {
  if (e.key === "Enter") {
    e.preventDefault();
    const first = $("repo-list").querySelector('input[type="checkbox"]:not(:checked):not(:disabled)');
    if (first) toggle(first.value);
  } else if (e.key === "ArrowDown") {
    e.preventDefault();
    $("repo-list").querySelector('input[type="checkbox"]:not(:disabled)')?.focus();
  }
});

$("token").addEventListener("change", loadSuggestions);

async function fill() {
  const { settings: stored } = await chrome.storage.local.get("settings");
  const s = withDefaults(stored);
  $("token").value = s.token;
  $("interval").value = String(s.intervalMin);
  $("ignore-bots").checked = s.ignoreBots;
  for (const k of NOTIFY_KEYS) form.elements[k].checked = s.notify[k];
  picker.selected = [...s.repos];
  render();
  await loadSuggestions();
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
    const repos = await checkRepos(settings.token, settings.repos);
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
