import { icons } from "./lib/icons.js";
import { searchRepositories } from "./lib/github.js";
import { buildSuggestions, buildRepoSearch, pickerItems, toggleRepo, repoItem } from "./lib/repos.js";
import { plural } from "./lib/format.js";

const SEARCH_DEBOUNCE_MS = 350;

const esc = (s) =>
  String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);

function repoLabel(owner, name) {
  return `<span class="repo-owner">${esc(owner)}/</span><span class="repo-name">${esc(name)}</span>`;
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

/**
 * Repository multi-select: chips, a search box and a list of suggestions.
 * `loadSuggestions(token)` resolves to { viewer, openRepos, recentRepos }.
 * `getToken` (optional) supplies the live token for GitHub search; it defaults
 * to the token last passed to `reload`.
 */
export function createRepoPicker({
  chipsEl,
  searchEl,
  listEl,
  statusEl,
  loadSuggestions,
  onChange = () => {},
  getToken,
  texts = {},
}) {
  const t = {
    noToken: "Вставьте токен, чтобы увидеть репозитории, где у вас есть PR. Точное имя owner/name можно ввести и без него.",
    loading: "Загружаю репозитории, где у вас есть PR…",
    ...texts,
  };
  const picker = {
    selected: [],
    suggestions: [],
    owners: [],
    remote: [],
    status: "",
    loadedFor: null,
    token: "",
  };
  const currentToken = () => (getToken ? getToken() : picker.token);

  function renderChips() {
    chipsEl.innerHTML = picker.selected.length
      ? picker.selected
          .map((id) => {
            const [owner, name] = id.split("/");
            return `<span class="chip">${name === "*" ? `${repoLabel(owner, "")}<span class="chip__all">все</span>` : repoLabel(owner, name)}
            <button type="button" class="chip__remove" data-remove="${esc(id)}" aria-label="Убрать ${esc(id)}">${icons.x}</button></span>`;
          })
          .join("")
      : `<span class="chips__empty">Ничего не выбрано — отметьте репозитории в списке ниже</span>`;
  }

  function renderList() {
    const query = searchEl.value;
    const rows = pickerItems({ query, suggestions: picker.suggestions, remote: picker.remote, selected: picker.selected });
    const firstRemote = rows.findIndex((r) => r.remote);
    listEl.innerHTML = rows
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
    statusEl.textContent = picker.status || (empty ? (query ? "Ничего не найдено" : "") : "");
  }

  function render() {
    renderChips();
    renderList();
  }

  function setStatus(text) {
    picker.status = text;
    render();
  }

  async function reload(token) {
    picker.token = token;
    if (!token) {
      picker.suggestions = [];
      picker.owners = [];
      picker.loadedFor = null;
      return setStatus(t.noToken);
    }
    if (picker.loadedFor === token) return;
    picker.loadedFor = token;
    setStatus(t.loading);
    try {
      const result = buildSuggestions(await loadSuggestions(token));
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
    const token = currentToken();
    const search = buildRepoSearch(searchEl.value, picker.owners);
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
    onChange(picker.selected);
  }

  listEl.addEventListener("change", (e) => {
    if (e.target.matches('input[type="checkbox"]')) toggle(e.target.value);
  });

  chipsEl.addEventListener("click", (e) => {
    const btn = e.target.closest("[data-remove]");
    if (btn) toggle(btn.dataset.remove);
  });

  searchEl.addEventListener("input", () => {
    renderList();
    scheduleSearch();
  });

  searchEl.addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      e.preventDefault();
      const first = listEl.querySelector('input[type="checkbox"]:not(:checked):not(:disabled)');
      if (first) toggle(first.value);
    } else if (e.key === "ArrowDown") {
      e.preventDefault();
      listEl.querySelector('input[type="checkbox"]:not(:disabled)')?.focus();
    }
  });

  return {
    getSelected: () => [...picker.selected],
    setSelected(ids) {
      picker.selected = [...ids];
      render();
    },
    reload,
  };
}
