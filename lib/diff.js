const KIND_SETTING = {
  comment: "comments",
  approved: "approvals",
  changes_requested: "changesRequested",
};

const FAILED = new Set(["FAILURE", "ERROR"]);
const TERMINAL = new Set(["SUCCESS", "FAILURE", "ERROR"]);

export function emptyUnread() {
  return { comments: 0, approvals: 0, changes: 0, ci: null };
}

export function unreadTotal(unread) {
  if (!unread) return 0;
  return unread.comments + unread.approvals + unread.changes + (unread.ci ? 1 : 0);
}

function isWanted(event, settings) {
  if (settings.ignoreBots && event.isBot) return false;
  return Boolean(settings.notify[KIND_SETTING[event.kind]]);
}

function ciTransition(prev, cur, settings) {
  if (!TERMINAL.has(cur.state)) return null;
  if (prev && prev.sha === cur.sha && prev.state === cur.state) return null;
  if (FAILED.has(cur.state)) return settings.notify.ciFailure ? "failure" : null;
  return settings.notify.ciSuccess ? "success" : null;
}

function ciFlagStillTrue(flag, state) {
  if (flag === "failure") return FAILED.has(state);
  if (flag === "success") return state === "SUCCESS";
  return false;
}

/** Latest APPROVED / CHANGES_REQUESTED review per reviewer. */
function reviewers(events) {
  const latest = new Map();
  for (const e of events) {
    if (e.kind === "approved" || e.kind === "changes_requested") latest.set(e.author, e.kind);
  }
  const approvedBy = [];
  const changesRequestedBy = [];
  for (const [author, kind] of latest) {
    (kind === "approved" ? approvedBy : changesRequestedBy).push(author);
  }
  return { approvedBy, changesRequestedBy };
}

/**
 * Compares freshly fetched PRs with the stored ones.
 * A PR seen for the first time is recorded silently, so adding a repo or
 * installing the extension never replays old comments.
 */
export function diffPullRequests(prevPrs, prs, settings) {
  const next = {};
  const changes = [];

  for (const pr of prs) {
    const { events, ...rest } = pr;
    const prev = prevPrs?.[pr.key];
    const record = { ...rest, ...reviewers(events), seen: events.map((e) => e.id) };

    if (!prev) {
      next[pr.key] = { ...record, unread: emptyUnread() };
      continue;
    }

    const seen = new Set(prev.seen);
    const fresh = events.filter((e) => !seen.has(e.id) && isWanted(e, settings));
    const ci = ciTransition(prev.ci, pr.ci, settings);

    const unread = { ...emptyUnread(), ...prev.unread };
    for (const e of fresh) {
      if (e.kind === "comment") unread.comments++;
      else if (e.kind === "approved") unread.approvals++;
      else unread.changes++;
    }
    if (ci) unread.ci = ci;
    else if (!ciFlagStillTrue(unread.ci, pr.ci.state)) unread.ci = null;

    next[pr.key] = { ...record, unread };
    if (fresh.length || ci) changes.push({ pr: next[pr.key], events: fresh, ci });
  }

  return { prs: next, changes };
}

export function markRead(prs, key) {
  if (!prs[key]) return prs;
  return { ...prs, [key]: { ...prs[key], unread: emptyUnread() } };
}

export function markAllRead(prs) {
  return Object.fromEntries(Object.entries(prs).map(([k, v]) => [k, { ...v, unread: emptyUnread() }]));
}

export function totalUnread(prs) {
  return Object.values(prs).reduce((sum, pr) => sum + unreadTotal(pr.unread), 0);
}
