import { test } from "node:test";
import assert from "node:assert/strict";
import { withDefaults } from "../lib/settings.js";
import {
  esc,
  readReviewUi,
  saveReviewUi,
  effectiveIgnored,
  reviewTabCount,
  claudeLinkFor,
  ownClaudeLink,
  reviewStatusSource,
  reviewView,
  badgesHtml,
  reasonText,
  reviewListHtml,
  reviewToolbarHtml,
} from "../popup-review.js";

const NOW = Date.parse("2026-11-12T12:00:00Z");
const hoursAgo = (h) => new Date(NOW - h * 3600 * 1000).toISOString();

let seq = 0;
function pr(o = {}) {
  seq++;
  const repo = o.repo ?? "o/r";
  const number = o.number ?? seq;
  return {
    key: `${repo}#${number}`,
    id: `PR_${seq}`,
    repo,
    number,
    title: `PR ${seq}`,
    url: `https://github.com/${repo}/pull/${number}`,
    author: "alice",
    createdAt: hoursAgo(100),
    updatedAt: hoursAgo(1),
    isDraft: false,
    reviewDecision: null,
    additions: 50,
    deletions: 50,
    changedFiles: 3,
    ci: null,
    requestedAt: hoursAgo(10),
    myLastReviewAt: null,
    myLastReviewState: null,
    firstCommitAfterMyReview: null,
    approvedBy: [],
    changesRequestedBy: [],
    changesPendingAuthor: false,
    reviewedByOthers: true,
    threads: { resolved: 0, unresolved: 0, unanswered: 0, answered: 0 },
    ...o,
  };
}

const byKey = (...prs) => Object.fromEntries(prs.map((p) => [p.key, p]));
const settings = (o = {}) => withDefaults({ token: "t", review: { repos: ["o/r"] }, ...o });
const ui = (o = {}) => ({ filter: "all", sort: "need", openSections: new Set(), overrides: new Map(), ...o });
const view = ({ queue = [], waiting = [], ignored = {}, s = settings(), u = ui(), state = {} } = {}) =>
  reviewView({
    settings: s,
    reviewState: { queue: byKey(...queue), waiting: byKey(...waiting), lastCheck: hoursAgo(0), ...state },
    ignored,
    ui: u,
    now: NOW,
  });

function memoryStorage(init = {}) {
  const data = { ...init };
  return {
    data,
    getItem: (k) => (k in data ? data[k] : null),
    setItem: (k, v) => {
      data[k] = String(v);
    },
  };
}

test("esc escapes HTML specials", () => {
  assert.equal(esc(`<a href="x">'&'</a>`), "&lt;a href=&quot;x&quot;&gt;&#39;&amp;&#39;&lt;/a&gt;");
  assert.equal(esc(null), "");
});

test("readReviewUi falls back to defaults for missing, invalid or unreadable values", () => {
  const d = readReviewUi(memoryStorage());
  assert.equal(d.filter, "all");
  assert.equal(d.sort, "need");
  assert.deepEqual([...d.openSections], []);

  const bad = readReviewUi(memoryStorage({ reviewFilter: "x", reviewSort: "y", reviewSections: "{oops" }));
  assert.equal(bad.filter, "all");
  assert.equal(bad.sort, "need");
  assert.deepEqual([...bad.openSections], []);

  const throwing = { getItem: () => { throw new Error("denied"); } };
  assert.equal(readReviewUi(throwing).sort, "need");
  assert.equal(readReviewUi(undefined).filter, "all");
});

test("saveReviewUi round-trips through readReviewUi and survives a throwing storage", () => {
  const storage = memoryStorage();
  saveReviewUi({ filter: "rerequest", sort: "smallest", openSections: new Set(["hidden"]) }, storage);
  const back = readReviewUi(storage);
  assert.equal(back.filter, "rerequest");
  assert.equal(back.sort, "smallest");
  assert.deepEqual([...back.openSections], ["hidden"]);

  const unknown = readReviewUi(memoryStorage({ reviewSections: JSON.stringify(["hidden", "bogus"]) }));
  assert.deepEqual([...unknown.openSections], ["hidden"]);

  assert.doesNotThrow(() =>
    saveReviewUi(ui(), { setItem: () => { throw new Error("quota"); } }),
  );
});

test("effectiveIgnored applies pending hides and un-hides", () => {
  const a = pr();
  const b = pr();
  const stored = { [b.key]: { ignoredAt: hoursAgo(1), title: b.title, url: b.url, repo: b.repo, number: b.number } };
  const out = effectiveIgnored(stored, new Map([[a.key, true], [b.key, false]]), { queue: byKey(a, b), waiting: {} });
  assert.deepEqual(Object.keys(out), [a.key]);
  assert.equal(out[a.key].title, a.title);
  assert.equal(out[a.key].ignoredAt, null);
  // An override for a PR that is gone is ignored.
  assert.deepEqual(effectiveIgnored({}, new Map([["x#1", true]]), { queue: {}, waiting: {} }), {});
});

test("reviewTabCount counts queued PRs that are not hidden", () => {
  const a = pr();
  const b = pr();
  assert.equal(reviewTabCount({ queue: byKey(a, b) }, {}), 2);
  assert.equal(reviewTabCount({ queue: byKey(a, b) }, { [a.key]: {} }), 1);
  assert.equal(reviewTabCount(undefined, {}), 0);
});

test("claudeLinkFor uses the review or own prompt and the repo folder", () => {
  const s = settings({
    claude: { reviewPrompt: "R {url}", ownPrompt: "O {number}", folders: { "O/R": "/src/r" } },
  });
  const p = pr({ number: 7 });
  assert.equal(
    claudeLinkFor(s, p),
    `claude://code/new?q=${encodeURIComponent(`R ${p.url}`)}&folder=${encodeURIComponent("/src/r")}`,
  );
  assert.equal(claudeLinkFor(s, p, "own"), `claude://code/new?q=${encodeURIComponent("O 7")}&folder=%2Fsrc%2Fr`);
  assert.equal(claudeLinkFor(settings(), pr({ repo: "x/y" })).includes("folder="), false);
});

test("ownClaudeLink fills {author} with the viewer", () => {
  const s = settings({ claude: { ownPrompt: "{author}: {url}" } });
  const mine = { key: "o/r#3", repo: "o/r", number: 3, title: "T", url: "https://github.com/o/r/pull/3" };
  assert.equal(ownClaudeLink(s, mine, "ivan"), `claude://code/new?q=${encodeURIComponent(`ivan: ${mine.url}`)}`);
  assert.equal(ownClaudeLink(s, mine, null), `claude://code/new?q=${encodeURIComponent(`: ${mine.url}`)}`);
});

test("reviewStatusSource keeps the status bar neutral while the empty state explains the setup", () => {
  const setup = { lastError: { kind: "setup", message: "Выберите репозитории для ревью в настройках" }, lastCheck: null };
  assert.equal(reviewStatusSource(withDefaults({ token: "t" }), setup).lastError, null);
  assert.equal(reviewStatusSource(withDefaults({ review: { repos: ["o/r"] } }), setup).lastError, null);
  const auth = { lastError: { kind: "auth", message: "Токен отклонён" } };
  assert.deepEqual(reviewStatusSource(settings(), auth).lastError, auth.lastError);
});

test("«Ждут автора» puts my last review on its own line so repo and author stay whole", () => {
  const w = pr({ number: 42, author: "hedgehog", myLastReviewAt: hoursAgo(50), myLastReviewState: "CHANGES_REQUESTED" });
  const html = reviewListHtml(view({ waiting: [w] }));
  assert.match(html, /class="rv__sub">вы просили изменения 2 дня назад</);
  const meta = html.match(/class="rv__meta">([\s\S]*?)<\/span><\/span>\s*<span class="rv__sub"/)?.[1] ?? "";
  assert.match(meta, /r #42/);
  assert.match(meta, /hedgehog/);
  assert.doesNotMatch(meta, /вы просили/);
});

test("reviewView reports setup and loading states", () => {
  assert.equal(view({ s: withDefaults({ review: { repos: ["o/r"] } }) }).status, "no-token");
  assert.equal(view({ s: withDefaults({ token: "t" }) }).status, "no-repos");
  assert.equal(view({ state: { lastCheck: null } }).status, "loading");
  assert.equal(view({ state: { lastCheck: null, lastError: { kind: "api", message: "x" } } }).status, "error");
  assert.equal(view().status, "ready");
});

test("hidden PRs leave the queue and «Ждут автора» and show up only under «Скрытые»", () => {
  const q = pr();
  const w = pr({ myLastReviewAt: hoursAgo(30), myLastReviewState: "COMMENTED" });
  const keep = pr();
  const ignored = {
    [q.key]: { ignoredAt: hoursAgo(2), title: q.title, url: q.url, repo: q.repo, number: q.number },
    [w.key]: { ignoredAt: hoursAgo(1), title: w.title, url: w.url, repo: w.repo, number: w.number },
  };
  const v = view({ queue: [q, keep], waiting: [w], ignored });
  assert.deepEqual(v.items.map((i) => i.pr.key), [keep.key]);
  assert.equal(v.waiting.length, 0);
  assert.deepEqual(v.hidden.map((h) => h.key), [w.key, q.key]); // newest hide first
  assert.equal(v.counts.all, 1);
});

test("reviewView counts kinds and filters the queue", () => {
  const first = pr();
  const again = pr({ myLastReviewAt: hoursAgo(50), firstCommitAfterMyReview: hoursAgo(20) });
  const all = view({ queue: [first, again] });
  assert.deepEqual(all.counts, { all: 2, first: 1, rerequest: 1 });
  const only = view({ queue: [first, again], u: ui({ filter: "rerequest" }) });
  assert.deepEqual(only.items.map((i) => i.pr.key), [again.key]);
  assert.equal(only.items[0].kind, "rerequest");
  assert.deepEqual(only.counts, all.counts);
});

test("«Ждут автора» lists PRs with new commits first", () => {
  const old = pr({ myLastReviewAt: hoursAgo(40), updatedAt: hoursAgo(1) });
  const pushed = pr({ myLastReviewAt: hoursAgo(40), firstCommitAfterMyReview: hoursAgo(5), updatedAt: hoursAgo(5) });
  const v = view({ waiting: [old, pushed] });
  assert.deepEqual(v.waiting.map((p) => p.key), [pushed.key, old.key]);
});

test("owners are shown only when PRs come from more than one owner", () => {
  assert.equal(view({ queue: [pr(), pr()] }).showOwner, false);
  assert.equal(view({ queue: [pr(), pr({ repo: "acme/r" })] }).showOwner, true);
  const html = reviewListHtml(view({ queue: [pr({ number: 5 })] }));
  assert.match(html, /title="o\/r">r #5</);
});

test("badgesHtml shows only non-zero badges in spec order with logins in tooltips", () => {
  assert.equal(badgesHtml(pr(), "kind"), "");

  const busy = pr({
    myLastReviewAt: hoursAgo(50),
    approvedBy: ["bob", "carol"],
    changesRequestedBy: ["dave"],
    threads: { resolved: 2, unresolved: 3, unanswered: 1, answered: 2 },
    ci: "FAILURE",
  });
  const html = badgesHtml(busy, "kind");
  const order = ["ре-ревью", 'title="Апрув: bob, carol"', 'title="Просят изменения: dave"', "2/5", "1 без ответа", "2 с ответом", "CI упал"];
  let at = -1;
  for (const part of order) {
    const i = html.indexOf(part);
    assert.ok(i > at, `${part} should come after the previous badge`);
    at = i;
  }

  assert.match(badgesHtml(pr({ reviewedByOthers: false }), "kind"), /никто не смотрел/);
  assert.doesNotMatch(badgesHtml(pr({ ci: "SUCCESS" }), "kind"), /st--/);
  assert.match(badgesHtml(pr({ ci: "PENDING" }), "kind"), /st--yellow/);
  assert.match(badgesHtml(pr({ firstCommitAfterMyReview: hoursAgo(3) }), "commits"), /новые коммиты/);
  assert.equal(badgesHtml(pr({ reviewedByOthers: false }), "commits"), "");
});

test("badge tooltips escape logins", () => {
  assert.match(badgesHtml(pr({ approvedBy: ['x"><b>'] }), "kind"), /Апрув: x&quot;&gt;&lt;b&gt;/);
});

test("reasonText keeps only what the row does not already show", () => {
  // «ре-ревью» / «никто не смотрел» are badges, «ждёт …» is in the meta line.
  assert.equal(reasonText({ tier: 1, reasons: ["ре-ревью", "никто не смотрел", "маленький"] }), "↑ маленький");
  assert.equal(reasonText({ tier: 1, reasons: ["ре-ревью", "ждёт 4 д"] }), "");
  assert.equal(reasonText({ tier: 1, reasons: ["ждёт 3 ч"] }), "");
  assert.equal(reasonText({ tier: 2, reasons: ["уже хватает апрувов", "ждёт 2 д"] }), "↓ уже хватает апрувов");
  assert.equal(
    reasonText({ tier: 2, reasons: ["ждёт автора после запроса изменений", "маленький", "ждёт 1 д"] }),
    "↓ ждёт автора после запроса изменений · маленький",
  );
  assert.equal(reasonText({ tier: 1, reasons: [] }), "");
});

test("reasonText reads «маленький» from the PR size, even when rankQueue cut it off", () => {
  const big = pr({ additions: 400, deletions: 400 });
  const tiny = pr({ additions: 1, deletions: 1, reviewDecision: "APPROVED" });
  assert.equal(reasonText({ pr: big, tier: 1, reasons: ["ре-ревью", "никто не смотрел", "ждёт 2 д"] }), "");
  assert.equal(
    reasonText({ pr: tiny, tier: 2, reasons: ["уже хватает апрувов", "ре-ревью", "никто не смотрел"] }),
    "↓ уже хватает апрувов · маленький",
  );
});

test("queue rows under «need» never repeat badges or the wait time in the reason line", () => {
  const p = pr({ reviewedByOthers: false, myLastReviewAt: hoursAgo(80), firstCommitAfterMyReview: hoursAgo(50) });
  const html = reviewListHtml(view({ queue: [p] }));
  const reason = html.match(/class="rv__reason">([^<]*)</)?.[1];
  assert.equal(reason, "↑ маленький");
  const big = reviewListHtml(view({ queue: [pr({ additions: 500, deletions: 0, reviewedByOthers: false })] }));
  assert.doesNotMatch(big, /rv__reason/);
});

test("rows escape GitHub data and carry size, wait and reason", () => {
  const p = pr({
    title: "<img src=x onerror=alert(1)>",
    author: "a&b",
    additions: 3,
    deletions: 2,
    changedFiles: 1,
    requestedAt: hoursAgo(130),
  });
  const html = reviewListHtml(view({ queue: [p] }));
  assert.doesNotMatch(html, /<img/);
  assert.match(html, /&lt;img src=x onerror=alert\(1\)&gt;/);
  assert.match(html, /a&amp;b/);
  assert.match(html, /class="size size--XS" title="\+3 −2, 1 файл"/);
  assert.match(html, /class="wait wait--late"[^>]*>ждёт 5 д/);
  assert.match(html, /class="rv__reason">↑ /);
  assert.match(html, /data-action="claude"/);
  assert.match(html, /data-action="hide"/);
});

test("the reason line appears only with the «need» sort", () => {
  const html = reviewListHtml(view({ queue: [pr()], u: ui({ sort: "oldest" }) }));
  assert.doesNotMatch(html, /rv__reason/);
});

test("a divider separates «ход не за вами» under the «need» sort", () => {
  const mine = pr();
  const approved = pr({ reviewDecision: "APPROVED" });
  const html = reviewListHtml(view({ queue: [approved, mine] }));
  const divider = html.indexOf('class="divider"');
  assert.ok(divider > html.indexOf(`data-key="${mine.key}"`));
  assert.ok(divider < html.indexOf(`data-key="${approved.key}"`));
  assert.doesNotMatch(reviewListHtml(view({ queue: [approved, mine], u: ui({ sort: "oldest" }) })), /class="divider"/);
});

test("empty states use the spec texts", () => {
  assert.match(reviewListHtml(view({ s: withDefaults({ token: "t" }) })), /Выберите репозитории для ревью в настройках/);
  assert.match(reviewListHtml(view({ s: withDefaults({ token: "t" }) })), /data-open-options/);
  assert.match(reviewListHtml(view()), /Нет PR, где ждут вашего ревью/);
  const filtered = reviewListHtml(view({ queue: [pr()], u: ui({ filter: "rerequest" }) }));
  assert.match(filtered, /Нет PR на ре-ревью/);
  assert.match(filtered, /data-filter="all"/);
  assert.equal(reviewListHtml(view({ state: { lastCheck: null, lastError: { kind: "auth", message: "x" } } })), "");
});

test("sections show counts, remember open state and offer «Вернуть»", () => {
  const w = pr({ myLastReviewAt: hoursAgo(30), myLastReviewState: "CHANGES_REQUESTED" });
  const h1 = pr();
  const h2 = pr();
  const entry = (p, at) => ({ ignoredAt: at, title: p.title, url: p.url, repo: p.repo, number: p.number });
  const ignored = { [h1.key]: entry(h1, hoursAgo(1)), [h2.key]: entry(h2, hoursAgo(2)) };
  const closed = reviewListHtml(view({ queue: [h1, h2], waiting: [w], ignored }));
  assert.match(closed, /data-section="waiting">/);
  assert.match(closed, /Ждут автора<\/span>[\s\S]*?class="repo__n">1</);
  assert.match(closed, /Скрытые<\/span>[\s\S]*?class="repo__n">2</);
  assert.match(closed, /вы просили изменения 1 день назад/);
  assert.equal((closed.match(/data-action="unhide"/g) ?? []).length, 2);
  assert.match(closed, /data-action="unhide-all"/);
  assert.match(closed, /Нет PR, где ждут вашего ревью/);

  const open = reviewListHtml(view({ waiting: [w], ignored, u: ui({ openSections: new Set(["hidden"]) }) }));
  assert.match(open, /data-section="hidden" open>/);
  assert.match(open, /data-section="waiting">/);
});

test("no sections are rendered when they would be empty", () => {
  const html = reviewListHtml(view({ queue: [pr()] }));
  assert.doesNotMatch(html, /data-section/);
});

test("reviewToolbarHtml renders chips with counts and the selected sort", () => {
  const first = pr();
  const again = pr({ myLastReviewAt: hoursAgo(50), firstCommitAfterMyReview: hoursAgo(20) });
  const html = reviewToolbarHtml(view({ queue: [first, again], u: ui({ filter: "first", sort: "smallest" }) }));
  assert.match(html, /data-filter="all"[^>]*aria-pressed="false">Все<span class="chip__n">2</);
  assert.match(html, /data-filter="first"[^>]*aria-pressed="true">Первичные<span class="chip__n">1</);
  assert.match(html, /data-filter="rerequest"[^>]*>Ре-ревью<span class="chip__n">1</);
  assert.match(html, /class="sort__label">Маленькие сначала</);
  assert.match(html, /<option value="smallest" selected>/);
  for (const label of ["Нужнее всего", "Дольше всех ждут", "Новые", "Никто не ревьюил", "Маленькие сначала"]) {
    assert.ok(html.includes(`>${label}</option>`), label);
  }
  assert.equal(reviewToolbarHtml(view()), "");
  assert.equal(reviewToolbarHtml(view({ s: withDefaults({ token: "t" }) })), "");
});
