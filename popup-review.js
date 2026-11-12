// The "На ревью" tab of the popup. Everything above bindReview is pure (no DOM, no chrome.*)
// so the view model and the markup can be tested with node --test.
import { icons } from "./lib/icons.js";
import { rankQueue, sizeOf, reviewKind, waitAge, formatWait } from "./lib/review.js";
import { fillTemplate, claudeLink, folderFor } from "./lib/claude.js";
import { EMPTY_REVIEW_STATE } from "./lib/review-state.js";
import { plural, timeAgo } from "./lib/format.js";

export const esc = (s) =>
  String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);

export const FILTERS = [
  ["all", "Все"],
  ["first", "Первичные"],
  ["rerequest", "Ре-ревью"],
];

export const SORTS = [
  ["need", "Нужнее всего"],
  ["oldest", "Дольше всех ждут"],
  ["newest", "Новые"],
  ["unreviewed", "Никто не ревьюил"],
  ["smallest", "Маленькие сначала"],
];

export const SECTIONS = ["waiting", "hidden"];

const UI_KEYS = { filter: "reviewFilter", sort: "reviewSort", sections: "reviewSections" };
const isFilter = (v) => FILTERS.some(([id]) => id === v);
const isSort = (v) => SORTS.some(([id]) => id === v);

/** Filter, sort and open sections remembered between popup openings; bad or missing values fall back to defaults. */
export function readReviewUi(storage = globalThis.localStorage) {
  const get = (key) => {
    try {
      return storage?.getItem(key) ?? null;
    } catch {
      return null;
    }
  };
  let sections = [];
  try {
    const parsed = JSON.parse(get(UI_KEYS.sections) ?? "[]");
    if (Array.isArray(parsed)) sections = parsed.filter((s) => SECTIONS.includes(s));
  } catch {
    // A corrupted value just means every section starts collapsed.
  }
  const filter = get(UI_KEYS.filter);
  const sort = get(UI_KEYS.sort);
  return {
    filter: isFilter(filter) ? filter : "all",
    sort: isSort(sort) ? sort : "need",
    openSections: new Set(sections),
  };
}

export function saveReviewUi(ui, storage = globalThis.localStorage) {
  try {
    storage.setItem(UI_KEYS.filter, ui.filter);
    storage.setItem(UI_KEYS.sort, ui.sort);
    storage.setItem(UI_KEYS.sections, JSON.stringify([...ui.openSections]));
  } catch {
    // Remembering the choice is a convenience; without storage the popup opens with defaults.
  }
}

/** Stored ignore list with not-yet-confirmed hides (true) and un-hides (false) applied on top. */
export function effectiveIgnored(ignored, overrides, reviewState) {
  const out = { ...(ignored ?? {}) };
  for (const [key, hidden] of overrides ?? []) {
    if (!hidden) {
      delete out[key];
      continue;
    }
    if (out[key]) continue;
    const pr = reviewState?.queue?.[key] ?? reviewState?.waiting?.[key];
    if (pr) out[key] = { ignoredAt: null, title: pr.title, url: pr.url, repo: pr.repo, number: pr.number };
  }
  return out;
}

/** Number on the «На ревью» tab: PRs in the queue that are not hidden. */
export function reviewTabCount(reviewState, ignored) {
  return Object.keys(reviewState?.queue ?? {}).filter((key) => !ignored?.[key]).length;
}

/** Link that opens a new Claude Code session for the PR; kind "review" for others' PRs, "own" for mine. */
export function claudeLinkFor(settings, pr, kind = "review") {
  const template = kind === "own" ? settings.claude.ownPrompt : settings.claude.reviewPrompt;
  return claudeLink({ prompt: fillTemplate(template, pr), folder: folderFor(settings.claude.folders, pr.repo) });
}

const ownerOf = (repo) => String(repo ?? "").split("/")[0].toLowerCase();
const tsOr = (iso, fallback) => {
  const t = Date.parse(iso);
  return Number.isFinite(t) ? t : fallback;
};

/**
 * View model of the tab. status: "no-token" | "no-repos" | "loading" | "error" | "ready".
 * ui = { filter, sort, openSections, overrides? }.
 */
export function reviewView({ settings, reviewState, ignored, ui, now = Date.now() }) {
  const rs = { ...EMPTY_REVIEW_STATE, ...reviewState };
  const base = { filter: ui.filter, sort: ui.sort, openSections: ui.openSections };
  if (!settings.token) return { ...base, status: "no-token" };
  if (!settings.review.repos.length) return { ...base, status: "no-repos" };

  const hidden = effectiveIgnored(ignored, ui.overrides, rs);
  const active = Object.values(rs.queue).filter((pr) => !hidden[pr.key]);
  const waitingPrs = Object.values(rs.waiting).filter((pr) => !hidden[pr.key] && !rs.queue[pr.key]);
  const hiddenList = Object.entries(hidden)
    .map(([key, entry]) => ({ key, ...entry }))
    .sort((a, b) => tsOr(b.ignoredAt, Infinity) - tsOr(a.ignoredAt, Infinity) || (a.key < b.key ? -1 : 1));

  if (!rs.lastCheck && !active.length && !waitingPrs.length) return { ...base, status: rs.lastError ? "error" : "loading" };

  const counts = { all: active.length, first: 0, rerequest: 0 };
  for (const pr of active) counts[reviewKind(pr)]++;

  const filtered = ui.filter === "all" ? active : active.filter((pr) => reviewKind(pr) === ui.filter);
  const items = rankQueue(filtered, ui.sort, now).map((item) => ({ ...item, kind: reviewKind(item.pr) }));

  // PRs with commits after my review are the ones worth a look first.
  const waiting = waitingPrs.sort(
    (a, b) =>
      Number(Boolean(b.firstCommitAfterMyReview)) - Number(Boolean(a.firstCommitAfterMyReview)) ||
      tsOr(b.updatedAt, 0) - tsOr(a.updatedAt, 0),
  );

  const owners = new Set([...active, ...waiting, ...hiddenList].map((p) => ownerOf(p.repo)));
  return {
    ...base,
    status: "ready",
    counts,
    items,
    waiting,
    hidden: hiddenList,
    showOwner: owners.size > 1,
    now,
  };
}

// ---------- markup ----------

const attr = (name, value) => (value ? ` ${name}="${esc(value)}"` : "");

function repoRef(repo, number, showOwner) {
  const name = showOwner ? repo : String(repo).split("/").pop();
  return `<span class="trunc" title="${esc(repo)}">${esc(name)} #${esc(number)}</span>`;
}

const pill = (cls, content, title) => `<span class="pill pill--${cls}"${attr("title", title)}>${content}</span>`;

const CI_DOT = {
  FAILURE: ["red", "CI упал"],
  ERROR: ["red", "CI: ошибка"],
  PENDING: ["yellow", "CI выполняется"],
  EXPECTED: ["yellow", "CI ожидает запуска"],
};

/** Badges of a row; zero values are never shown. lead is "kind" for the queue, "commits" for «Ждут автора». */
export function badgesHtml(pr, lead) {
  const out = [];
  if (lead === "commits") {
    if (pr.firstCommitAfterMyReview) {
      out.push(pill("comment", "новые коммиты", `Первый коммит после вашего ревью: ${timeAgo(pr.firstCommitAfterMyReview)}`));
    }
  } else if (reviewKind(pr) === "rerequest") {
    out.push(pill("comment", "ре-ревью", "Вы уже ревьюили, автор ждёт вас снова"));
  } else if (!pr.reviewedByOthers) {
    out.push(pill("muted", "никто не смотрел", "Кроме вас, ревью пока никто не оставил"));
  }
  const approved = pr.approvedBy ?? [];
  if (approved.length) out.push(pill("approve", `${icons.check}${approved.length}`, `Апрув: ${approved.join(", ")}`));
  const changes = pr.changesRequestedBy ?? [];
  if (changes.length) out.push(pill("changes", `${icons.x}${changes.length}`, `Просят изменения: ${changes.join(", ")}`));
  const t = pr.threads ?? {};
  const total = (t.resolved ?? 0) + (t.unresolved ?? 0);
  if (total) out.push(pill("muted", `${icons.comment}${t.resolved ?? 0}/${total}`, `Треды: решено ${t.resolved ?? 0} из ${total}`));
  if (t.unanswered) out.push(pill("warn", `${t.unanswered} без ответа`, "Нерешённые треды, где автор PR ещё не ответил"));
  if (t.answered) out.push(pill("comment", `${t.answered} с ответом`, "Нерешённые треды, где последним ответил автор PR"));
  const ci = CI_DOT[pr.ci];
  if (ci) out.push(`<span class="st st--${ci[0]}" title="${ci[1]}">${icons.dot}</span>`);
  return out.join("");
}

/** Grey line explaining a row's place under «Нужнее всего». */
export function reasonText(item) {
  if (!item.reasons?.length) return "";
  const raised = item.reasons.length > 1 || !item.reasons[0].startsWith("ждёт");
  const arrow = item.tier === 2 ? "↓ " : raised ? "↑ " : "";
  return arrow + item.reasons.join(" · ");
}

function sizeBadge(pr) {
  const size = sizeOf(pr);
  const files = pr.changedFiles ?? 0;
  const title = `+${pr.additions} −${pr.deletions}, ${files} ${plural(files, ["файл", "файла", "файлов"])}`;
  return `<span class="size size--${size}" title="${esc(title)}">${size}</span>`;
}

function actionsHtml(pr) {
  const ref = `#${esc(pr.number)}`;
  return `<span class="row-actions">
      <button class="act" type="button" data-action="claude" data-key="${esc(pr.key)}" data-focus="claude:${esc(pr.key)}" title="Открыть в Claude" aria-label="Открыть ${ref} в Claude">${icons.claude}</button>
      <button class="act" type="button" data-action="hide" data-key="${esc(pr.key)}" data-focus="hide:${esc(pr.key)}" title="Скрыть" aria-label="Скрыть ${ref}">${icons.eyeOff}</button>
    </span>`;
}

const sep = `<span class="sep" aria-hidden="true">·</span>`;

function rowHtml(pr, { metaTail, badges, reason }, view) {
  return `<li class="rv" data-key="${esc(pr.key)}">
    <a class="rv__link" href="${esc(pr.url)}" data-review-url data-focus="open:${esc(pr.key)}" title="Открыть на GitHub">
      <span class="rv__head"><span class="rv__title">${esc(pr.title)}</span>${sizeBadge(pr)}</span>
      <span class="rv__meta">${repoRef(pr.repo, pr.number, view.showOwner)}${pr.author ? `${sep}<span class="trunc">${esc(pr.author)}</span>` : ""}${sep}${metaTail}</span>
      ${badges ? `<span class="rv__badges">${badges}</span>` : ""}
      ${reason ? `<span class="rv__reason">${esc(reason)}</span>` : ""}
    </a>
    ${actionsHtml(pr)}
  </li>`;
}

function queueRowHtml(item, view) {
  const age = waitAge(item.hours);
  const wait = `<span class="wait wait--${age}" title="Ждёт вашего ревью">ждёт ${esc(formatWait(item.hours))}</span>`;
  return rowHtml(
    item.pr,
    { metaTail: wait, badges: badgesHtml(item.pr, "kind"), reason: view.sort === "need" ? reasonText(item) : "" },
    view,
  );
}

const MY_REVIEW = {
  CHANGES_REQUESTED: "вы просили изменения",
  COMMENTED: "вы комментировали",
};

function waitingRowHtml(pr, view) {
  const what = MY_REVIEW[pr.myLastReviewState] ?? "ваше ревью";
  const tail = `<span class="trunc">${esc(what)} ${esc(timeAgo(pr.myLastReviewAt, view.now))}</span>`;
  return rowHtml(pr, { metaTail: tail, badges: badgesHtml(pr, "commits"), reason: "" }, view);
}

function hiddenRowHtml(entry, view) {
  return `<li class="hid">
    <a class="hid__link" href="${esc(entry.url)}" data-review-url data-focus="open:${esc(entry.key)}" title="Открыть на GitHub">
      <span class="hid__ref">${repoRef(entry.repo, entry.number, view.showOwner)}</span>
      <span class="hid__title">${esc(entry.title)}</span>
    </a>
    <button class="text-button" type="button" data-action="unhide" data-key="${esc(entry.key)}" data-focus="unhide:${esc(entry.key)}">Вернуть</button>
  </li>`;
}

function sectionHtml(id, title, count, hint, body, view) {
  const open = view.openSections?.has(id) ? " open" : "";
  return `<details class="repo section" data-section="${id}"${open}>
    <summary class="repo__head" data-focus="section:${id}">
      <span class="repo__chevron">${icons.chevron}</span>
      <span class="repo__name">${esc(title)}</span>
      <span class="repo__summary"><span class="repo__n">${count}</span></span>
    </summary>
    <div class="section__hint">${hint}</div>
    <ul class="queue">${body}</ul>
  </details>`;
}

function emptyHtml(text, extra = "") {
  return `<div class="empty"><p>${text}</p>${extra}</div>`;
}

const settingsButton = `<button class="button button--primary" data-open-options>Открыть настройки</button>`;

/** Filter chips and the sort picker; empty when there is nothing to filter. */
export function reviewToolbarHtml(view) {
  if (view.status !== "ready" || !view.counts.all) return "";
  const chips = FILTERS.map(([id, label]) => {
    const n = view.counts[id];
    const cls = ["chip", !n && "chip--zero"].filter(Boolean).join(" ");
    return `<button class="${cls}" type="button" data-filter="${id}" data-focus="filter:${id}" aria-pressed="${view.filter === id}">${label}<span class="chip__n">${n}</span></button>`;
  }).join("");
  const current = SORTS.find(([id]) => id === view.sort)?.[1] ?? SORTS[0][1];
  const options = SORTS.map(
    ([id, label]) => `<option value="${id}"${id === view.sort ? " selected" : ""}>${label}</option>`,
  ).join("");
  return `<div class="chips" role="group" aria-label="Фильтр">${chips}</div>
    <label class="sort" title="Сортировка">
      <span class="sort__label">${current}</span>${icons.chevron}
      <select class="sort__select" data-sort data-focus="sort" aria-label="Сортировка">${options}</select>
    </label>`;
}

const FILTER_EMPTY = {
  first: "Нет PR на первичное ревью",
  rerequest: "Нет PR на ре-ревью",
};

/** Markup of the list area of the tab. */
export function reviewListHtml(view) {
  switch (view.status) {
    case "no-token":
      return emptyHtml("Добавьте токен GitHub в настройках.", settingsButton);
    case "no-repos":
      return emptyHtml("Выберите репозитории для ревью в настройках", settingsButton);
    case "loading":
      return emptyHtml("Загружаю…");
    case "error":
      return "";
  }

  let main;
  if (!view.counts.all) {
    main = `<div class="empty empty--done">${icons.check}<p>Нет PR, где ждут вашего ревью</p></div>`;
  } else if (!view.items.length) {
    main = emptyHtml(
      esc(FILTER_EMPTY[view.filter] ?? "Нет PR"),
      `<button class="button" type="button" data-filter="all" data-focus="filter-reset">Показать все</button>`,
    );
  } else {
    let dividerShown = false;
    const rows = view.items.map((item) => {
      let html = "";
      if (view.sort === "need" && item.tier === 2 && !dividerShown) {
        dividerShown = true;
        const n = view.items.filter((i) => i.tier === 2).length;
        html += `<li class="divider" title="Уже хватает апрувов или ждут ответа автора на запрос изменений">Ход не за вами<span class="divider__n">${n}</span></li>`;
      }
      return html + queueRowHtml(item, view);
    });
    main = `<ul class="queue">${rows.join("")}</ul>`;
  }

  let sections = "";
  if (view.waiting.length) {
    sections += sectionHtml(
      "waiting",
      "Ждут автора",
      view.waiting.length,
      "Вы уже ревьюили, сейчас ход за автором.",
      view.waiting.map((pr) => waitingRowHtml(pr, view)).join(""),
      view,
    );
  }
  if (view.hidden.length) {
    const all =
      view.hidden.length > 1
        ? `<button class="text-button" type="button" data-action="unhide-all" data-focus="unhide-all">Вернуть все</button>`
        : "";
    sections += sectionHtml(
      "hidden",
      "Скрытые",
      view.hidden.length,
      `<span>Вернутся сами, если ревью запросят снова.</span>${all}`,
      view.hidden.map((entry) => hiddenRowHtml(entry, view)).join(""),
      view,
    );
  }
  return main + sections;
}

// ---------- DOM ----------

/** ctx = { settings, reviewState, ignored, ui, toolbar? } — toolbar is the element above the list. */
export function renderReview(listEl, ctx) {
  const view = reviewView(ctx);
  listEl.innerHTML = reviewListHtml(view);
  if (ctx.toolbar) {
    const html = reviewToolbarHtml(view);
    ctx.toolbar.innerHTML = html;
    ctx.toolbar.hidden = !html;
  }
}

const TOAST_MS = 5000;

/**
 * Event handlers of the tab. getContext() returns the same ctx as renderReview.
 * opts = { toolbar, toast, render: () => void, reload: () => Promise<void> }.
 */
export function bindReview(listEl, getContext, { toolbar, toast, render, reload }) {
  const send = (msg) => chrome.runtime.sendMessage(msg).catch(() => ({ ok: false }));
  const prOf = (key) => {
    const { reviewState } = getContext();
    return reviewState?.queue?.[key] ?? reviewState?.waiting?.[key] ?? null;
  };

  const focusAfterRender = (focusId) => {
    if (!focusId) return;
    const el = [...listEl.querySelectorAll("[data-focus]")].find((n) => n.dataset.focus === focusId);
    el?.focus({ preventScroll: false });
  };

  // Hide/unhide are applied locally at once and confirmed by the background.
  async function setHidden(key, hidden, focusId) {
    const { ui } = getContext();
    ui.overrides.set(key, hidden);
    render();
    focusAfterRender(focusId);
    await send({ type: hidden ? "ignore" : "unignore", key });
    if (ui.overrides.get(key) === hidden) ui.overrides.delete(key);
    await reload();
  }

  // ---- toast ----
  let toastTimer = null;
  let toastLeft = 0;
  let toastStarted = 0;
  let toastUndo = null;

  const hideToast = () => {
    clearTimeout(toastTimer);
    toastTimer = null;
    toastUndo = null;
    toast.classList.remove("is-visible");
    // The faded-out «Отменить» must not stay a tab stop.
    const button = toast.querySelector(".toast__undo");
    if (button) button.disabled = true;
  };
  const startToastTimer = (ms) => {
    clearTimeout(toastTimer);
    toastLeft = ms;
    toastStarted = Date.now();
    toastTimer = setTimeout(hideToast, ms);
  };
  const showToast = (onUndo) => {
    toastUndo = onUndo;
    toast.innerHTML = `<span>Скрыто</span><span class="toast__sep" aria-hidden="true">·</span><button class="toast__undo" type="button" title="Ctrl+Z" aria-keyshortcuts="Control+Z Meta+Z">${icons.undo}Отменить</button>`;
    toast.classList.add("is-visible");
    startToastTimer(TOAST_MS);
  };
  const undoLast = () => {
    const undo = toastUndo;
    hideToast();
    undo?.();
  };
  toast.addEventListener("click", (e) => {
    if (e.target.closest(".toast__undo")) undoLast();
  });
  document.addEventListener("keydown", (e) => {
    if (toastUndo && (e.ctrlKey || e.metaKey) && !e.shiftKey && e.code === "KeyZ") {
      e.preventDefault();
      undoLast();
    }
  });
  // The countdown pauses while the pointer or focus is on the toast.
  const pause = () => {
    if (!toastTimer) return;
    clearTimeout(toastTimer);
    toastTimer = null;
    toastLeft = Math.max(1500, toastLeft - (Date.now() - toastStarted));
  };
  const resume = () => {
    if (toastUndo && !toastTimer && !toast.matches(":hover, :focus-within")) startToastTimer(toastLeft);
  };
  toast.addEventListener("mouseenter", pause);
  toast.addEventListener("focusin", pause);
  toast.addEventListener("mouseleave", resume);
  toast.addEventListener("focusout", resume);

  // ---- actions ----
  function nextFocusAfter(row) {
    for (const dir of ["nextElementSibling", "previousElementSibling"]) {
      let el = row[dir];
      while (el && !el.matches(".rv, .hid")) el = el[dir];
      const target = el?.querySelector("[data-review-url]");
      if (target) return target.dataset.focus;
    }
    return null;
  }

  function onAction(button, viaKeyboard) {
    const key = button.dataset.key;
    const { settings, ui } = getContext();
    switch (button.dataset.action) {
      case "claude": {
        const pr = prOf(key);
        if (!pr) return;
        chrome.runtime.sendMessage({ type: "openClaude", url: claudeLinkFor(settings, pr, "review") });
        window.close();
        return;
      }
      case "hide": {
        const row = button.closest(".rv");
        const focusId = viaKeyboard && row ? nextFocusAfter(row) : null;
        setHidden(key, true, focusId);
        showToast(() => setHidden(key, false, `open:${key}`));
        return;
      }
      case "unhide": {
        const row = button.closest(".hid");
        const focusId = viaKeyboard && row ? nextFocusAfter(row) : null;
        setHidden(key, false, focusId);
        return;
      }
      case "unhide-all": {
        const { ignored } = getContext();
        for (const k of Object.keys(effectiveIgnored(ignored, ui.overrides, getContext().reviewState))) {
          ui.overrides.set(k, false);
        }
        render();
        send({ type: "unignoreAll" }).then(async () => {
          for (const [k, v] of ui.overrides) if (v === false) ui.overrides.delete(k);
          await reload();
        });
        return;
      }
    }
  }

  function setFilter(filter) {
    const { ui } = getContext();
    if (!isFilter(filter) || ui.filter === filter) return;
    ui.filter = filter;
    saveReviewUi(ui);
    render();
  }

  const openLink = (link, active) => {
    chrome.runtime.sendMessage({ type: "openReview", url: link.href, active });
    if (active) window.close();
  };

  listEl.addEventListener("click", (e) => {
    const action = e.target.closest("[data-action]");
    if (action && listEl.contains(action)) {
      e.preventDefault();
      e.stopPropagation();
      // detail is 0 for clicks synthesized from Enter/Space: only then move focus to the next row.
      onAction(action, e.detail === 0);
      return;
    }
    const reset = e.target.closest("[data-filter]");
    if (reset && listEl.contains(reset)) {
      setFilter(reset.dataset.filter);
      toolbar?.querySelector('[data-filter="all"]')?.focus();
      return;
    }
    const link = e.target.closest("[data-review-url]");
    if (!link) return;
    e.preventDefault();
    openLink(link, !(e.ctrlKey || e.metaKey || e.shiftKey));
  });

  listEl.addEventListener("auxclick", (e) => {
    const link = e.target.closest("[data-review-url]");
    if (link && e.button === 1) {
      e.preventDefault();
      openLink(link, false);
    }
  });

  listEl.addEventListener(
    "toggle",
    (e) => {
      const id = e.target.dataset?.section;
      if (!id) return;
      const { ui } = getContext();
      if (e.target.open) ui.openSections.add(id);
      else ui.openSections.delete(id);
      saveReviewUi(ui);
    },
    true,
  );

  toolbar?.addEventListener("click", (e) => {
    const chip = e.target.closest("[data-filter]");
    if (chip) setFilter(chip.dataset.filter);
  });

  toolbar?.addEventListener("change", (e) => {
    if (!e.target.matches("[data-sort]")) return;
    const { ui } = getContext();
    if (!isSort(e.target.value)) return;
    ui.sort = e.target.value;
    saveReviewUi(ui);
    render();
  });
}
