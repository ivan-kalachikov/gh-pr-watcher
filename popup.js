import { icons } from "./lib/icons.js";
import { withDefaults, prMatchesRepo } from "./lib/settings.js";
import { unreadTotal, totalUnread } from "./lib/diff.js";
import { timeAgo } from "./lib/format.js";

const AUTO_REFRESH_AFTER_MS = 60_000;

const $ = (id) => document.getElementById(id);

const esc = (s) =>
  String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);

for (const el of document.querySelectorAll("[data-icon]")) el.innerHTML = icons[el.dataset.icon];

async function load() {
  const { settings, state } = await chrome.storage.local.get(["settings", "state"]);
  return { settings: withDefaults(settings), state: { prs: {}, ...state } };
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
    <a class="pr__link" href="${esc(pr.url)}" data-key="${esc(pr.key)}" title="Открыть на GitHub">
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
    <summary class="repo__head">
      <span class="repo__chevron">${icons.chevron}</span>
      <span class="repo__name"><span class="repo__owner">${esc(owner)} /</span> ${esc(name)}</span>
      <span class="repo__summary">${repoSummary(prs)}<span class="repo__n" title="Открытых PR">${prs.length}</span></span>
    </summary>
    <ul>${prs.map(renderPr).join("")}</ul>
  </details>`;
}

function renderStatus(settings, state) {
  const el = $("status");
  const error = state.lastError;
  if (error) {
    const link = error.kind === "setup" || error.kind === "auth" ? ` <a href="#" data-open-options>Открыть настройки</a>` : "";
    el.className = "status status--error";
    el.innerHTML = `${icons.warn}<span>${esc(error.message)}.${link}</span>`;
    return;
  }
  el.className = "status";
  el.title = state.rateLimit ? `Осталось запросов к API: ${state.rateLimit.remaining}` : "";
  const who = state.viewer ? ` · ${esc(state.viewer)}` : "";
  el.innerHTML = `Проверено ${esc(timeAgo(state.lastCheck))}${who} · каждые ${settings.intervalMin} мин`;
}

function render({ settings, state }) {
  renderStatus(settings, state);

  const total = totalUnread(state.prs);
  $("count").hidden = !total;
  $("count").textContent = total > 99 ? "99+" : total;
  $("mark-all").hidden = !total;

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
    if (e.target.matches?.("details.repo")) saveCollapsed(e.target.dataset.repo, !e.target.open);
  },
  true,
);

$("refresh").addEventListener("click", refresh);
$("settings").addEventListener("click", () => {
  chrome.runtime.openOptionsPage();
  window.close();
});
$("mark-all").addEventListener("click", () => chrome.runtime.sendMessage({ type: "markAllRead" }));

chrome.storage.onChanged.addListener(async (_changes, area) => {
  if (area === "local") render(await load());
});

const initial = await load();
render(initial);
const stale = !initial.state.lastCheck || Date.now() - new Date(initial.state.lastCheck).getTime() > AUTO_REFRESH_AFTER_MS;
if (initial.settings.token && initial.settings.repos.length && stale) refresh();
