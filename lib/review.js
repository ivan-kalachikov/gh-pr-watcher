import { isBot } from "./github.js";

export const WEIGHTS = { rerequest: 24, unreviewed: 12, small: 8 };

const HOUR = 3600 * 1000;
const ts = (iso) => Date.parse(iso);
const lower = (s) => (s ?? "").toLowerCase();

/** A review that counts as "I reviewed this PR" (a lone reply in someone else's thread does not). */
export function didReview(review, login) {
  if (!review || lower(review.author?.login) !== lower(login)) return false;
  if (review.state === "APPROVED" || review.state === "CHANGES_REQUESTED") return true;
  if (review.state !== "COMMENTED") return false;
  if (review.body?.trim()) return true;
  return (review.comments?.nodes ?? []).some((c) => c && c.replyTo == null);
}

function latestBy(items, field) {
  let best = null;
  for (const item of items) {
    if (!item?.[field]) continue;
    if (!best || ts(item[field]) > ts(best[field])) best = item;
  }
  return best;
}

export function normalizeReviewPr(node, login, { includeTeams = false } = {}) {
  const me = lower(login);
  const authorLogin = node.author?.login ?? null;
  const commits = (node.commits?.nodes ?? []).map((n) => n?.commit).filter(Boolean);
  const reviews = (node.reviews?.nodes ?? []).filter((r) => r?.submittedAt);

  const requests = (node.timelineItems?.nodes ?? []).filter((e) => {
    const r = e?.requestedReviewer;
    if (!e?.createdAt || !r) return false;
    if (r.login) return lower(r.login) === me;
    return includeTeams && Boolean(r.slug);
  });
  const requestedAt = latestBy(requests, "createdAt")?.createdAt ?? null;

  const mine = latestBy(reviews.filter((r) => didReview(r, login)), "submittedAt");
  const myLastReviewAt = mine?.submittedAt ?? null;
  const firstCommitAfterMyReview = myLastReviewAt
    ? commits
        .map((c) => c.committedDate)
        .filter((d) => d && ts(d) > ts(myLastReviewAt))
        .sort((a, b) => ts(a) - ts(b))[0] ?? null
    : null;

  const isOther = (r) => {
    const l = r.author?.login;
    return Boolean(l) && lower(l) !== me && lower(l) !== lower(authorLogin) && !isBot(r.author);
  };
  const others = reviews.filter(isOther);

  const byReviewer = new Map();
  for (const r of others) {
    if (!["APPROVED", "CHANGES_REQUESTED", "DISMISSED"].includes(r.state)) continue;
    const k = lower(r.author.login);
    const prev = byReviewer.get(k);
    if (!prev || ts(r.submittedAt) >= ts(prev.submittedAt)) byReviewer.set(k, r);
  }
  const latest = [...byReviewer.values()];
  const approvedBy = latest.filter((r) => r.state === "APPROVED").map((r) => r.author.login);
  const crReviews = latest.filter((r) => r.state === "CHANGES_REQUESTED");
  const changesRequestedBy = crReviews.map((r) => r.author.login);
  const lastCommitAt = latestBy(commits, "committedDate")?.committedDate ?? null;
  const changesPendingAuthor = crReviews.some((r) => !lastCommitAt || ts(lastCommitAt) <= ts(r.submittedAt));
  const reviewedByOthers = others.some((r) => didReview(r, r.author.login));

  const threads = { resolved: 0, unresolved: 0, unanswered: 0, answered: 0 };
  for (const t of node.reviewThreads?.nodes ?? []) {
    if (!t) continue;
    if (t.isResolved) {
      threads.resolved++;
      continue;
    }
    threads.unresolved++;
    const last = t.comments?.nodes?.[0]?.author?.login;
    if (last && authorLogin && lower(last) === lower(authorLogin)) threads.answered++;
    else threads.unanswered++;
  }

  const repo = node.repository.nameWithOwner;
  return {
    key: `${repo}#${node.number}`,
    id: node.id,
    repo,
    number: node.number,
    title: node.title,
    url: node.url,
    author: authorLogin,
    createdAt: node.createdAt,
    updatedAt: node.updatedAt,
    isDraft: Boolean(node.isDraft),
    reviewDecision: node.reviewDecision ?? null,
    additions: node.additions ?? 0,
    deletions: node.deletions ?? 0,
    changedFiles: node.changedFiles ?? 0,
    ci: commits.at(-1)?.statusCheckRollup?.state ?? null,
    requestedAt,
    myLastReviewAt,
    myLastReviewState: mine?.state ?? null,
    firstCommitAfterMyReview,
    approvedBy,
    changesRequestedBy,
    changesPendingAuthor,
    reviewedByOthers,
    threads,
  };
}

export function sizeOf(pr) {
  const n = pr.additions + pr.deletions;
  if (n <= 10) return "XS";
  if (n <= 100) return "S";
  if (n <= 400) return "M";
  if (n <= 1000) return "L";
  return "XL";
}

export function reviewKind(pr) {
  return pr.myLastReviewAt ? "rerequest" : "first";
}

export function waitingSince(pr) {
  const fallback = pr.requestedAt ?? pr.createdAt;
  if (reviewKind(pr) === "first") return fallback;
  const candidates = [];
  if (pr.requestedAt && ts(pr.requestedAt) > ts(pr.myLastReviewAt)) candidates.push(pr.requestedAt);
  if (pr.firstCommitAfterMyReview) candidates.push(pr.firstCommitAfterMyReview);
  if (!candidates.length) return fallback;
  return candidates.sort((a, b) => ts(a) - ts(b))[0];
}

export function waitAge(hours) {
  if (hours >= 120) return "late";
  if (hours >= 48) return "warn";
  return "normal";
}

export function formatWait(hours) {
  return hours < 24 ? `${Math.floor(hours)} ч` : `${Math.floor(hours / 24)} д`;
}

const byKey = (a, b) => (a.pr.key < b.pr.key ? -1 : a.pr.key > b.pr.key ? 1 : 0);

export function rankQueue(prs, sort, now) {
  const items = prs.map((pr) => {
    const since = ts(waitingSince(pr));
    const hours = Number.isFinite(since) ? Math.max(0, (now - since) / HOUR) : 0;
    const rerequest = reviewKind(pr) === "rerequest";
    const unreviewed = !pr.reviewedByOthers;
    const small = ["XS", "S"].includes(sizeOf(pr));
    const approved = pr.reviewDecision === "APPROVED";
    const tier = approved || pr.changesPendingAuthor ? 2 : 1;
    const score =
      hours + (rerequest ? WEIGHTS.rerequest : 0) + (unreviewed ? WEIGHTS.unreviewed : 0) + (small ? WEIGHTS.small : 0);
    const reasons = [];
    if (sort === "need") {
      if (tier === 2) reasons.push(approved ? "уже хватает апрувов" : "ждёт автора после запроса изменений");
      if (rerequest) reasons.push("ре-ревью");
      if (unreviewed) reasons.push("никто не смотрел");
      if (small) reasons.push("маленький");
      reasons.push(`ждёт ${formatWait(hours)}`);
    }
    return { pr, tier, score, hours, reasons: reasons.slice(0, 3), since, size: pr.additions + pr.deletions };
  });

  const cmp = {
    need: (a, b) => a.tier - b.tier || b.score - a.score,
    oldest: (a, b) => b.hours - a.hours,
    newest: (a, b) => b.since - a.since,
    unreviewed: (a, b) => Number(a.pr.reviewedByOthers) - Number(b.pr.reviewedByOthers) || b.hours - a.hours,
    smallest: (a, b) => a.size - b.size,
  }[sort] ?? ((a, b) => b.hours - a.hours);

  items.sort((a, b) => cmp(a, b) || byKey(a, b));
  return items.map(({ pr, tier, score, hours, reasons }) => ({ pr, tier, score, hours, reasons }));
}
