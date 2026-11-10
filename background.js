import { withDefaults } from "./lib/settings.js";
import { fetchViewer, fetchPullRequests } from "./lib/github.js";
import { diffPullRequests, markRead, markAllRead, totalUnread } from "./lib/diff.js";
import { describeChange } from "./lib/format.js";

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

function poll() {
  return serial(async () => {
    const settings = await getSettings();
    const state = await getState();
    const setupError = !settings.token
      ? "Укажите токен в настройках"
      : !settings.repos.length
        ? "Добавьте репозитории в настройках"
        : null;
    if (setupError) {
      await setState({ ...state, lastError: { kind: "setup", message: setupError } });
      return;
    }

    try {
      const viewer = state.viewer ?? (await fetchViewer(settings.token));
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
      await setState({ ...state, lastError: { kind: e.kind ?? "api", message: e.message } });
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
    await serial(() => setState({ ...EMPTY_STATE }));
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
  };
  const handler = handlers[msg?.type];
  if (!handler) return false;
  handler().then(
    () => sendResponse({ ok: true }),
    (e) => sendResponse({ ok: false, error: e.message }),
  );
  return true;
});
