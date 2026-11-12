import { icons } from "./lib/icons.js";
import { withDefaults, prMatchesRepo } from "./lib/settings.js";
import { unreadTotal, totalUnread } from "./lib/diff.js";
import { timeAgo } from "./lib/format.js";
import { EMPTY_REVIEW_STATE } from "./lib/review-state.js";
import { esc, renderReview, bindReview, readReviewUi, reviewTabCount, effectiveIgnored, claudeLinkFor } from "./popup-review.js";

const AUTO_REFRESH_AFTER_MS = 60_000;

const $ = (id) => document.getElementById(id);

for (const el of document.querySelectorAll("[data-icon]")) el.innerHTML = icons[el.dataset.icon];

async function load() {
  const { settings, state, reviewState, reviewIgnored } = await chrome.storage.local.get([
    "settings",
    "state",
    "reviewState",
    "reviewIgnored",
  ]);
  return {
    settings: withDefaults(settings),
    state: { prs: {}, ...state },
    reviewState: { ...EMPTY_REVIEW_STATE, ...reviewState },
    ignored: reviewIgnored ?? {},
  };
}

function groupByRepo(repos, prs) {
  const list = Object.values(prs);
  const groups = new Map();
  const add = (repo) => {
    const k = repo.toLowerCase();
    if (!groups.has(k)) groups.set(k, { repo, prs: [] });
  };

  for (const configured of repos) {
    if (!configured.endsWith("/*")) {
      add(list.find((p) => p.repo.toLowerCase() === configured.toLowerCase())?.repo ?? configured);
      continue;
    }
    const owned = [...new Set(list.filter((p) => prMatchesRepo(p.repo, configured)).map((p) => p.repo))].sort();
    if (owned.length) owned.forEach(add);
    else add(configured);
  }
  for (const pr of list) groups.get(pr.repo.toLowerCase())?.prs.push(pr);

  const byAttention = (a, b) =>
    Number(unreadTotal(b.unread) > 0) - Number(unreadTotal(a.unread) > 0) || b.updatedAt.localeCompare(a.updatedAt);
  for (const g of groups.values()) g.prs.sort(byAttention);

  const all = [...groups.values()];
  return { active: all.filter((g) => g.prs.length), quiet: all.filter((g) => !g.prs.length) };
}

function status(kind, icon, title) {
  return `<span class="st st--${kind}" title="${esc(title)}">${icons[icon]}</span>`;
}

function reviewStatus(pr) {
  if (pr.reviewDecision === "CHANGES_REQUESTED" || (!pr.reviewDecision && pr.changesRequestedBy?.length)) {
    return status("red", "x", `Просят изменения: ${pr.changesRequestedBy?.join(", ") || "—"}`);
  }
  if (pr.reviewDecision === "APPROVED" || (!pr.reviewDecision && pr.approvedBy?.length)) {
    return status("green", "check", `Апрув: ${pr.approvedBy?.join(", ") || "—"}`);
  }
  if (pr.reviewDecision === "REVIEW_REQUIRED") {
    const approved = pr.approvedBy?.length ? ` (апрув: ${pr.approvedBy.join(", ")})` : "";
    return status("grey", "eye", `Ждёт ревью${approved}`);
  }
  return "";
}

const CI = {
  SUCCESS: ["green", "CI прошёл"],
  FAILURE: ["red", "CI упал"],
  ERROR: ["red", "CI: ошибка"],
  PENDING: ["yellow", "CI выполняется"],
  EXPECTED: ["yellow", "CI ожидает запуска"],
};

function ciStatus(pr) {
  const entry = CI[pr.ci?.state];
  if (!entry) return "";
  const html = status(entry[0], "dot", entry[1]);
  return pr.unread?.ci ? html.replace('class="st ', 'class="st st--fresh ') : html;
}

function pills(unread) {
  if (!unread) return "";
  const pill = (n, cls, icon, title) =>
    n ? `<span class="pill pill--${cls}" title="${title}">${icons[icon]}${n}</span>` : "";
  return (
    pill(unread.comments, "comment", "comment", "Новые комментарии") +
    pill(unread.approvals, "approve", "check", "Новые апрувы") +
    pill(unread.changes, "changes", "x", "Новые запросы изменений")
  );
}

function renderPr(pr) {
  const unread = unreadTotal(pr.unread) > 0;
  const cls = ["pr", unread && "pr--unread", pr.isDraft && "pr--draft"].filter(Boolean).join(" ");
  const meta = [`#${pr.number}`, pr.isDraft && "черновик", `обновлён ${timeAgo(pr.updatedAt)}`].filter(Boolean);
  const pillHtml = pills(pr.unread);
  return `<li class="${cls}">
    <a class="pr__link" href="${esc(pr.url)}" data-key="${esc(pr.key)}" data-focus="open:${esc(pr.key)}" title="Открыть на GitHub">
      <span class="pr__state">${icons.pr}</span>
      <span class="pr__main">
        <span class="pr__title">${esc(pr.title)}</span>
        <span class="pr__meta">${meta.map(esc).join(" · ")}</span>
      </span>
      <span class="pr__side">
        <span class="pr__status">${reviewStatus(pr)}${ciStatus(pr)}</span>
        ${pillHtml ? `<span class="pr__pills">${pillHtml}</span>` : ""}
      </span>
    </a>
    <span class="row-actions row-actions--mine">
      <button class="act" type="button" data-claude-own="${esc(pr.key)}" data-focus="claude:${esc(pr.key)}" title="Открыть в Claude" aria-label="Открыть #${esc(pr.number)} в Claude">${icons.claude}</button>
    </span>
  </li>`;
}

const COLLAPSED_KEY = "collapsedRepos";

function readCollapsed() {
  try {
    return new Set(JSON.parse(localStorage.getItem(COLLAPSED_KEY) ?? "[]"));
  } catch {
    return new Set();
  }
}

function saveCollapsed(repo, collapsed) {
  const set = readCollapsed();
  if (collapsed) set.add(repo);
  else set.delete(repo);
  try {
    localStorage.setItem(COLLAPSED_KEY, JSON.stringify([...set]));
  } catch {
    // Collapsing is a convenience; without storage every repo simply opens expanded.
  }
}

function repoSummary(prs) {
  const sum = { comments: 0, approvals: 0, changes: 0 };
  for (const pr of prs) {
    sum.comments += pr.unread?.comments ?? 0;
    sum.approvals += pr.unread?.approvals ?? 0;
    sum.changes += pr.unread?.changes ?? 0;
  }
  const failing = prs.filter((pr) => pr.ci?.state === "FAILURE" || pr.ci?.state === "ERROR").length;
  const fail = failing
    ? `<span class="pill pill--fail" title="Упал CI в ${failing} PR">${icons.dot}${failing}</span>`
    : "";
  return pills(sum) + fail;
}

function renderGroup({ repo, prs }, collapsed) {
  const [owner, name] = repo.split("/");
  return `<details class="repo" data-repo="${esc(repo)}" ${collapsed.has(repo) ? "" : "open"}>
    <summary class="repo__head" data-focus="repo:${esc(repo)}">
      <span class="repo__chevron">${icons.chevron}</span>
      <span class="repo__name"><span class="repo__owner">${esc(owner)} /</span> ${esc(name)}</span>
      <span class="repo__summary">${repoSummary(prs)}<span class="repo__n" title="Открытых PR">${prs.length}</span></span>
    </summary>
    <ul>${prs.map(renderPr).join("")}</ul>
  </details>`;
}

function renderStatus(settings, { lastError: error, lastCheck, rateLimit, viewer } = {}) {
  const el = $("status");
  el.title = "";
  if (error) {
    const link = error.kind === "setup" || error.kind === "auth" ? ` <a href="#" data-open-options>Открыть настройки</a>` : "";
    el.className = "status status--error";
    el.innerHTML = `${icons.warn}<span>${esc(error.message)}.${link}</span>`;
    return;
  }
  el.className = "status";
  el.title = rateLimit ? `Осталось запросов к API: ${rateLimit.remaining}` : "";
  const who = viewer ? ` · ${esc(viewer)}` : "";
  el.innerHTML = `Проверено ${esc(timeAgo(lastCheck))}${who} · каждые ${settings.intervalMin} мин`;
}

function renderMine({ settings, state }) {
  renderStatus(settings, state);
  $("mark-all").hidden = !totalUnread(state.prs);

  const list = $("list");
  if (!settings.token || !settings.repos.length) {
    list.innerHTML = `<div class="empty"><p>Добавьте токен GitHub и репозитории, за которыми следить.</p>
      <button class="button button--primary" data-open-options>Открыть настройки</button></div>`;
    return;
  }

  const { active, quiet } = groupByRepo(settings.repos, state.prs);
  if (!active.length && !state.lastCheck) {
    list.innerHTML = state.lastError ? "" : `<div class="empty"><p>Загружаю…</p></div>`;
    return;
  }

  const quietHtml = quiet.length
    ? `<div class="quiet">Нет открытых PR: ${quiet.map((g) => `<strong>${esc(g.repo)}</strong>`).join(", ")}</div>`
    : "";
  const collapsed = readCollapsed();
  list.innerHTML = active.length
    ? active.map((g) => renderGroup(g, collapsed)).join("") + quietHtml
    : `<div class="empty"><p>Нет ваших открытых PR в отслеживаемых репозиториях.</p></div>${quietHtml}`;
}

// ---------- tabs ----------

const TAB_KEY = "popupTab";
const TABS = ["mine", "review"];

function readTab() {
  try {
    const tab = localStorage.getItem(TAB_KEY);
    return TABS.includes(tab) ? tab : "mine";
  } catch {
    return "mine";
  }
}

function saveTab(tab) {
  try {
    localStorage.setItem(TAB_KEY, tab);
  } catch {
    // Without storage the popup simply opens on «Мои PR».
  }
}

let data;
let tab = readTab();
let renderedTab = null;
const scrollByTab = { mine: 0, review: 0 };
const reviewUi = { ...readReviewUi(), overrides: new Map() };

const reviewContext = () => ({
  settings: data.settings,
  reviewState: data.reviewState,
  ignored: data.ignored,
  ui: reviewUi,
  toolbar: $("toolbar"),
});

function renderTabs() {
  const total = totalUnread(data.state.prs);
  $("count").hidden = !total;
  $("count").textContent = total > 99 ? "99+" : total;

  const queued = data.settings.review.repos.length
    ? reviewTabCount(data.reviewState, effectiveIgnored(data.ignored, reviewUi.overrides, data.reviewState))
    : 0;
  $("review-count").hidden = !queued;
  $("review-count").textContent = queued > 99 ? "99+" : queued;

  for (const el of document.querySelectorAll("[data-tab]")) {
    const selected = el.dataset.tab === tab;
    el.setAttribute("aria-selected", String(selected));
    el.tabIndex = selected ? 0 : -1;
  }
  $("list").setAttribute("aria-labelledby", `tab-${tab}`);
}

// Re-renders keep the scroll position and the focused control of the current tab.
function render() {
  const list = $("list");
  if (renderedTab) scrollByTab[renderedTab] = list.scrollTop;
  const sameTab = renderedTab === tab;
  const focused = sameTab ? document.activeElement?.closest?.("[data-focus]")?.dataset.focus : null;

  renderTabs();
  if (tab === "review") {
    $("mark-all").hidden = true;
    renderStatus(data.settings, data.reviewState);
    renderReview(list, reviewContext());
  } else {
    $("toolbar").hidden = true;
    renderMine(data);
  }
  renderedTab = tab;
  list.scrollTop = scrollByTab[tab];

  if (focused) {
    const el = [...document.querySelectorAll("[data-focus]")].find((n) => n.dataset.focus === focused);
    el?.focus({ preventScroll: true });
  }
}

async function reload() {
  data = await load();
  render();
}

function selectTab(next, { focus = false } = {}) {
  if (!TABS.includes(next)) return;
  if (next !== tab) {
    tab = next;
    saveTab(tab);
    render();
  }
  if (focus) document.querySelector(`[data-tab="${tab}"]`)?.focus();
}

async function refresh() {
  const btn = $("refresh");
  if (btn.disabled) return;
  btn.disabled = true;
  btn.classList.add("is-spinning");
  try {
    await chrome.runtime.sendMessage({ type: "refresh" });
  } finally {
    btn.disabled = false;
    btn.classList.remove("is-spinning");
  }
}

function openPr(link, active) {
  chrome.runtime.sendMessage({ type: "open", url: link.href, key: link.dataset.key, active });
  if (active) window.close();
}

document.addEventListener("click", (e) => {
  if (e.target.closest("[data-open-options]")) {
    e.preventDefault();
    chrome.runtime.openOptionsPage();
    window.close();
    return;
  }
  const own = e.target.closest("[data-claude-own]");
  if (own) {
    const pr = data.state.prs[own.dataset.claudeOwn];
    if (!pr) return;
    chrome.runtime.sendMessage({ type: "openClaude", url: claudeLinkFor(data.settings, pr, "own") });
    window.close();
    return;
  }
  const link = e.target.closest(".pr__link");
  if (!link) return;
  e.preventDefault();
  openPr(link, !(e.ctrlKey || e.metaKey));
});

document.addEventListener("auxclick", (e) => {
  const link = e.target.closest(".pr__link");
  if (link && e.button === 1) {
    e.preventDefault();
    openPr(link, false);
  }
});

$("list").addEventListener(
  "toggle",
  (e) => {
    if (e.target.matches?.("details[data-repo]")) saveCollapsed(e.target.dataset.repo, !e.target.open);
  },
  true,
);

$("refresh").addEventListener("click", refresh);
$("settings").addEventListener("click", () => {
  chrome.runtime.openOptionsPage();
  window.close();
});
$("mark-all").addEventListener("click", () => chrome.runtime.sendMessage({ type: "markAllRead" }));

const tablist = document.querySelector("[role=tablist]");
tablist.addEventListener("click", (e) => {
  const el = e.target.closest("[data-tab]");
  if (el) selectTab(el.dataset.tab);
});
tablist.addEventListener("keydown", (e) => {
  const step = { ArrowLeft: -1, ArrowRight: 1 }[e.key];
  const jump = { Home: TABS[0], End: TABS.at(-1) }[e.key];
  if (!step && !jump) return;
  e.preventDefault();
  const next = jump ?? TABS[(TABS.indexOf(tab) + step + TABS.length) % TABS.length];
  selectTab(next, { focus: true });
});

bindReview($("list"), reviewContext, { toolbar: $("toolbar"), toast: $("toast"), render, reload });

chrome.storage.onChanged.addListener((_changes, area) => {
  if (area === "local") reload();
});

data = await load();
render();
const lastChecks = [
  data.settings.repos.length && data.state.lastCheck,
  data.settings.review.repos.length && data.reviewState.lastCheck,
].filter((v) => v !== 0 && v !== false);
const stale = lastChecks.some((iso) => !iso || Date.now() - new Date(iso).getTime() > AUTO_REFRESH_AFTER_MS);
if (data.settings.token && stale) refresh();
