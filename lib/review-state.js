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
    } else if (pr.requestedAt) {
      const was = before?.requestedAt ? ts(before.requestedAt) : -Infinity;
      if (!before || ts(pr.requestedAt) > was) kind = "rerequested";
    }
    if (kind && notify[kind]) changes.push({ pr, kind });
  }
  return { changes };
}

/** Drops ignored PRs that left both lists or got a review request newer than ignoredAt. */
export function pruneIgnored(ignored, queue, waiting) {
  const out = {};
  for (const [key, entry] of Object.entries(ignored ?? {})) {
    const current = queue?.[key];
    if (!current && !waiting?.[key]) continue;
    if (current?.requestedAt && ts(current.requestedAt) > ts(entry.ignoredAt)) continue;
    out[key] = entry;
  }
  return out;
}
