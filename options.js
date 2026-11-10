import { icons } from "./lib/icons.js";
import { withDefaults, parseRepos } from "./lib/settings.js";
import { fetchViewer, checkRepos } from "./lib/github.js";

const NOTIFY_KEYS = ["comments", "approvals", "changesRequested", "ciFailure", "ciSuccess"];

const TOKEN_URL = (() => {
  const params = new URLSearchParams({
    name: "PR Watcher",
    description: "Read-only token for the GitHub PR Watcher Chrome extension",
    expires_in: "366",
    pull_requests: "read",
    statuses: "read",
    checks: "read",
  });
  return `https://github.com/settings/personal-access-tokens/new?${params}`;
})();

const $ = (id) => document.getElementById(id);
const form = $("form");

for (const el of document.querySelectorAll("[data-icon]")) el.innerHTML = icons[el.dataset.icon];
$("create-token").href = TOKEN_URL;

function message(text, kind = "") {
  $("msg").textContent = text;
  $("msg").className = `msg${kind ? ` msg--${kind}` : ""}`;
}

function readForm() {
  const { valid, invalid } = parseRepos($("repos").value);
  return {
    invalid,
    settings: {
      token: $("token").value.trim(),
      repos: valid,
      intervalMin: Number($("interval").value),
      ignoreBots: $("ignore-bots").checked,
      notify: Object.fromEntries(NOTIFY_KEYS.map((k) => [k, form.elements[k].checked])),
    },
  };
}

async function fill() {
  const { settings: stored } = await chrome.storage.local.get("settings");
  const s = withDefaults(stored);
  $("token").value = s.token;
  $("repos").value = s.repos.join("\n");
  $("interval").value = String(s.intervalMin);
  $("ignore-bots").checked = s.ignoreBots;
  for (const k of NOTIFY_KEYS) form.elements[k].checked = s.notify[k];
}

form.addEventListener("submit", async (e) => {
  e.preventDefault();
  const { settings, invalid } = readForm();
  if (invalid.length) {
    message(`Не похоже на репозиторий: ${invalid.join(", ")}`, "error");
    return;
  }
  await chrome.storage.local.set({ settings });
  $("repos").value = settings.repos.join("\n");
  message("Сохранено. Первая проверка запомнит текущее состояние, уведомления придут о том, что появится после.", "ok");
});

$("check").addEventListener("click", async () => {
  const { settings, invalid } = readForm();
  const results = $("results");
  results.hidden = true;
  if (!settings.token) return message("Сначала вставьте токен", "error");
  if (invalid.length) return message(`Не похоже на репозиторий: ${invalid.join(", ")}`, "error");

  $("check").disabled = true;
  message("Проверяю…");
  try {
    const login = await fetchViewer(settings.token);
    const repos = await checkRepos(settings.token, settings.repos);
    const rows = [
      `<li class="ok">${icons.check}токен принят, пользователь ${login}</li>`,
      ...Object.entries(repos).map(([repo, ok]) =>
        ok
          ? `<li class="ok">${icons.check}${repo}</li>`
          : `<li class="bad">${icons.x}${repo} — не найден или нет доступа</li>`,
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
