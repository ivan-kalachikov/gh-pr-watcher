import { withDefaults } from "./lib/settings.js";
import { fetchViewer, fetchPullRequests, fetchReviewList, fetchReviewDetails } from "./lib/github.js";
import { diffPullRequests, markRead, markAllRead, totalUnread } from "./lib/diff.js";
import { describeChange, describeReviewRequest } from "./lib/format.js";
import { normalizeReviewPr } from "./lib/review.js";
import { EMPTY_REVIEW_STATE, needsDetails, diffReviewQueue, reposKey, pruneIgnored } from "./lib/review-state.js";

const ALARM = "poll";
const EMPTY_STATE = { prs: {}, viewer: null, lastCheck: null, lastError: null, rateLimit: null, warnings: [] };

const COLOR_INFO = "#0969da";
const COLOR_ALERT = "#d1242f";

async function getSettings() {
  const { settings } = await chrome.storage.local.get("settings");
  return withDefaults(settings);
}

async function getState() {
  const { state } = await chrome.storage.local.get("state");
  return { ...EMPTY_STATE, ...state };
}

async function getReviewState() {
  const { reviewState } = await chrome.storage.local.get("reviewState");
  return { ...EMPTY_REVIEW_STATE, ...reviewState };
}

async function getReviewIgnored() {
  const { reviewIgnored } = await chrome.storage.local.get("reviewIgnored");
  return reviewIgnored ?? {};
}

async function setState(state) {
  await chrome.storage.local.set({ state });
  await updateBadge(state);
}

// Polls and read-marks both rewrite the stored state; run them one at a time.
let queue = Promise.resolve();
function serial(fn) {
  const run = queue.then(fn, fn);
  queue = run.catch(() => {});
  return run;
}

async function updateBadge(state) {
  const error = state.lastError;
  if (error && (error.kind === "auth" || error.kind === "setup")) {
    await chrome.action.setBadgeText({ text: "!" });
    await chrome.action.setBadgeBackgroundColor({ color: COLOR_ALERT });
    await chrome.action.setTitle({ title: `GitHub PR Watcher — ${error.message}` });
    return;
  }

  const total = totalUnread(state.prs);
  const alert = Object.values(state.prs).some((pr) => pr.unread?.changes || pr.unread?.ci === "failure");
  await chrome.action.setBadgeText({ text: total ? (total > 99 ? "99+" : String(total)) : "" });
  await chrome.action.setBadgeBackgroundColor({ color: alert ? COLOR_ALERT : COLOR_INFO });
  const suffix = error ? ` (ошибка: ${error.message})` : total ? ` — новых: ${total}` : "";
  await chrome.action.setTitle({ title: `GitHub PR Watcher${suffix}` });
}

async function notify(change) {
  const { title, message, url } = describeChange(change);
  const id = `pr:${change.pr.key}:${Date.now()}`;
  await chrome.storage.session.set({ [id]: { url, key: change.pr.key } });
  await chrome.notifications.create(id, {
    type: "basic",
    iconUrl: "icons/icon-128.png",
    title,
    message,
    priority: 1,
  });
}

async function notifyReview(change) {
  const { title, message, url } = describeReviewRequest(change);
  const id = `review:${change.pr.key}:${Date.now()}`;
  // No read-mark key: opening a review request must not touch "Мои PR".
  await chrome.storage.session.set({ [id]: { url } });
  await chrome.notifications.create(id, {
    type: "basic",
    iconUrl: "icons/icon-128.png",
    title,
    message,
    priority: 1,
  });
}

const SETUP_MINE = "Добавьте репозитории в настройках";
const SETUP_REVIEW = "Выберите репозитории для ревью в настройках";

async function pollMine(settings, viewer, state) {
  try {
    const { prs, rateLimit, warnings } = await fetchPullRequests(settings.token, viewer, settings.repos);
    const { prs: next, changes } = diffPullRequests(state.prs, prs, settings);
    await setState({
      prs: next,
      viewer,
      lastCheck: new Date().toISOString(),
      lastError: null,
      rateLimit,
      warnings,
    });
    for (const change of changes) await notify(change);
  } catch (e) {
    await setState({ ...state, viewer, lastError: { kind: e.kind ?? "api", message: e.message } });
  }
}

async function pollReview(settings, viewer, prev) {
  const now = Date.now();
  const scope = reposKey(settings.review);
  // A changed repo list or teams toggle rewrites the baseline silently.
  const baselined = prev.baselined && prev.reposKey === scope;
  // Cached details were normalized under the old scope (includeTeams changes requestedAt).
  const cache = prev.reposKey === scope ? prev.details : {};
  try {
    const list = await fetchReviewList(settings.token, viewer, settings.review);
    const items = [...new Map([...list.queue, ...list.waiting].map((item) => [item.key, item])).values()];
    const stale = items.filter((item) => needsDetails(item, cache[item.key], now));
    const { nodes } = await fetchReviewDetails(
      settings.token,
      stale.map((item) => item.id),
    );
    const fresh = new Map(nodes.map((node) => [node.id, node]));

    const details = {};
    for (const item of items) {
      const node = fresh.get(item.id);
      if (node) {
        details[item.key] = {
          pr: normalizeReviewPr(node, viewer, { includeTeams: settings.review.includeTeams }),
          fetchedAt: now,
        };
      } else if (cache[item.key]) {
        details[item.key] = cache[item.key];
      }
    }

    const queue = {};
    for (const item of list.queue) if (details[item.key]) queue[item.key] = details[item.key].pr;
    const waiting = {};
    for (const item of list.waiting) {
      const pr = details[item.key]?.pr;
      if (pr && !queue[item.key] && pr.myLastReviewAt && pr.myLastReviewState !== "APPROVED") waiting[item.key] = pr;
    }

    const { changes } = diffReviewQueue({ ...prev, baselined }, queue, settings);
    const ignoredBefore = await getReviewIgnored();
    const ignored = pruneIgnored(ignoredBefore, queue, waiting);
    if (Object.keys(ignored).length !== Object.keys(ignoredBefore).length) {
      await chrome.storage.local.set({ reviewIgnored: ignored });
    }

    await chrome.storage.local.set({
      reviewState: {
        queue,
        waiting,
        details,
        baselined: true,
        reposKey: scope,
        lastCheck: new Date().toISOString(),
        lastError: null,
      },
    });
    for (const change of changes) if (!ignored[change.pr.key]) await notifyReview(change);
  } catch (e) {
    await chrome.storage.local.set({ reviewState: { ...prev, lastError: { kind: e.kind ?? "api", message: e.message } } });
  }
}

function poll() {
  return serial(async () => {
    const settings = await getSettings();
    const state = await getState();
    const review = await getReviewState();

    if (!settings.token) {
      const lastError = { kind: "setup", message: "Укажите токен в настройках" };
      await setState({ ...state, lastError });
      await chrome.storage.local.set({ reviewState: { ...review, lastError } });
      return;
    }

    // Each half polls on its own: one half's error or empty setup never blocks the other.
    let viewer;
    try {
      viewer = state.viewer ?? (await fetchViewer(settings.token));
    } catch (e) {
      const lastError = { kind: e.kind ?? "api", message: e.message };
      await setState({
        ...state,
        lastError: settings.repos.length ? lastError : { kind: "setup", message: SETUP_MINE },
      });
      await chrome.storage.local.set({
        reviewState: {
          ...review,
          lastError: settings.review.repos.length ? lastError : { kind: "setup", message: SETUP_REVIEW },
        },
      });
      return;
    }

    if (settings.repos.length) {
      await pollMine(settings, viewer, state);
    } else {
      await setState({ ...state, viewer, lastError: { kind: "setup", message: SETUP_MINE } });
    }

    if (settings.review.repos.length) {
      await pollReview(settings, viewer, review);
    } else {
      await chrome.storage.local.set({ reviewState: { ...review, lastError: { kind: "setup", message: SETUP_REVIEW } } });
    }
  });
}

async function scheduleAlarm() {
  const { intervalMin } = await getSettings();
  const current = await chrome.alarms.get(ALARM);
  if (current?.periodInMinutes === intervalMin) return;
  await chrome.alarms.create(ALARM, { delayInMinutes: intervalMin, periodInMinutes: intervalMin });
}

function updateState(mutate) {
  return serial(async () => {
    const state = await getState();
    await setState({ ...state, prs: mutate(state.prs) });
  });
}

function setIgnored(mutate) {
  return serial(async () => {
    const reviewIgnored = mutate(await getReviewIgnored(), await getReviewState());
    await chrome.storage.local.set({ reviewIgnored });
  });
}

function ignoreReview(key) {
  const now = new Date().toISOString();
  return setIgnored((ignored, { queue, waiting }) => {
    const pr = queue[key] ?? waiting[key];
    if (!pr) return ignored;
    const { title, url, repo, number } = pr;
    return { ...ignored, [key]: { ignoredAt: now, title, url, repo, number } };
  });
}

function unignoreReview(key) {
  return setIgnored((ignored) => {
    const { [key]: _removed, ...rest } = ignored;
    return rest;
  });
}

async function openReview(url, active = true) {
  if (typeof url !== "string" || !url.startsWith("https://github.com/")) throw new Error("Недопустимая ссылка");
  await chrome.tabs.create({ url, active });
}

async function openClaude(url) {
  if (typeof url !== "string" || !url.startsWith("claude://")) throw new Error("Недопустимая ссылка");
  // Navigating the current tab to an external scheme leaves no blank tab behind.
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (tab?.id !== undefined) await chrome.tabs.update(tab.id, { url });
  else await chrome.tabs.create({ url, active: false });
}

async function openPr(url, key, active = true) {
  await chrome.tabs.create({ url, active });
  if (key) await updateState((prs) => markRead(prs, key));
}

chrome.runtime.onInstalled.addListener(async () => {
  await scheduleAlarm();
  const { settings } = await chrome.storage.local.get("settings");
  if (!settings?.token) await chrome.runtime.openOptionsPage();
  await poll();
});

chrome.runtime.onStartup.addListener(async () => {
  await scheduleAlarm();
  await poll();
});

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === ALARM) poll();
});

chrome.storage.onChanged.addListener(async (changes, area) => {
  if (area !== "local" || !changes.settings) return;
  const before = withDefaults(changes.settings.oldValue);
  const after = withDefaults(changes.settings.newValue);
  if (before.token !== after.token) {
    // Another account's PRs must be baselined again, not reported as new.
    await serial(async () => {
      await setState({ ...EMPTY_STATE });
      await chrome.storage.local.set({ reviewState: { ...EMPTY_REVIEW_STATE }, reviewIgnored: {} });
    });
  }
  if (before.intervalMin !== after.intervalMin) await scheduleAlarm();
  await poll();
});

chrome.notifications.onClicked.addListener(async (id) => {
  const data = (await chrome.storage.session.get(id))[id];
  await chrome.notifications.clear(id);
  await chrome.storage.session.remove(id);
  if (data) await openPr(data.url, data.key);
});

chrome.notifications.onClosed.addListener((id) => chrome.storage.session.remove(id));

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  const handlers = {
    refresh: () => poll(),
    open: () => openPr(msg.url, msg.key, msg.active !== false),
    markAllRead: () => updateState(markAllRead),
    ignore: () => ignoreReview(msg.key),
    unignore: () => unignoreReview(msg.key),
    unignoreAll: () => setIgnored(() => ({})),
    openReview: () => openReview(msg.url, msg.active !== false),
    openClaude: () => openClaude(msg.url),
  };
  const handler = handlers[msg?.type];
  if (!handler) return false;
  handler().then(
    () => sendResponse({ ok: true }),
    (e) => sendResponse({ ok: false, error: e.message }),
  );
  return true;
});
