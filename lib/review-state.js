import { reviewKind } from "./review.js";

export const EMPTY_REVIEW_STATE = {
  queue: {},
  waiting: {},
  details: {},
  baselined: false,
  reposKey: "",
  lastCheck: null,
  lastError: null,
};

export const DETAILS_TTL_MS = 10 * 60 * 1000;

const ts = (v) => (typeof v === "number" ? v : Date.parse(v)); // ISO string or ms number

/** Details are refetched when uncached, when updatedAt changed, or when older than 10 minutes. */
export function needsDetails(listItem, cached, now) {
  if (!cached) return true;
  if (cached.pr?.updatedAt !== listItem.updatedAt) return true;
  return now - cached.fetchedAt > DETAILS_TTL_MS;
}

/** Key of the review scope; a mismatch with the stored one means the baseline must be rewritten silently. */
export function reposKey(review) {
  const repos = (review?.repos ?? []).map((r) => String(r).toLowerCase()).sort();
  return `${repos.join(",")}|${Boolean(review?.includeTeams)}`;
}

export function diffReviewQueue(prevState, nextQueue, settings) {
  const changes = [];
  if (!prevState?.baselined) return { changes };
  const notify = settings?.review?.notify ?? {};
  const prevQueue = prevState.queue ?? {};
  for (const [key, pr] of Object.entries(nextQueue ?? {})) {
    const before = prevQueue[key];
    let kind = null;
    if (reviewKind(pr) === "first") {
      if (!before) kind = "requested";
    } else if (pr.requestedAt && ts(pr.requestedAt) > ts(pr.myLastReviewAt)) {
      // Only a request made after my last review is a re-request.
      const was = before?.requestedAt ? ts(before.requestedAt) : -Infinity;
      if (!before || ts(pr.requestedAt) > was) kind = "rerequested";
    }
    if (kind && notify[kind]) changes.push({ pr, kind });
  }
  return { changes };
}

/**
 * Builds the active queue and «Ждут автора» from the search lists and normalized details.
 * A queue hit counts only while reviewRequests still names me (requestedNow); otherwise the
 * search index is stale and the PR is a «Ждут автора» candidate. Details cached before
 * requestedNow existed trust the search.
 */
export function assembleReviewLists(list, details) {
  const queue = {};
  const candidates = [];
  for (const item of list.queue ?? []) {
    const pr = details[item.key]?.pr;
    if (!pr) continue;
    if (pr.requestedNow !== false) queue[item.key] = pr;
    else candidates.push(item);
  }
  const waiting = {};
  for (const item of [...candidates, ...(list.waiting ?? [])]) {
    const pr = details[item.key]?.pr;
    if (pr && !queue[item.key] && pr.myLastReviewAt && pr.myLastReviewState !== "APPROVED") waiting[item.key] = pr;
  }
  return { queue, waiting };
}

/**
 * Drops ignored PRs that left both lists or got a review request newer than ignoredAt.
 * When a search was truncated, absence from the lists proves nothing, so those entries stay.
 */
export function pruneIgnored(ignored, queue, waiting, { truncated = false } = {}) {
  const out = {};
  for (const [key, entry] of Object.entries(ignored ?? {})) {
    const current = queue?.[key];
    if (!current && !waiting?.[key] && !truncated) continue;
    if (current?.requestedAt && ts(current.requestedAt) > ts(entry.ignoredAt)) continue;
    out[key] = entry;
  }
  return out;
}
