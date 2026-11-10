const rules = new Intl.PluralRules("ru");

/** forms: [one, few, many] — "комментарий", "комментария", "комментариев" */
export function plural(n, [one, few, many]) {
  const form = rules.select(n);
  if (form === "one") return one;
  if (form === "few") return few;
  return many;
}

function uniqueAuthors(events) {
  return [...new Set(events.map((e) => e.author))].join(", ");
}

function truncate(text, max) {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

export function prLabel(pr) {
  const name = pr.repo.split("/")[1];
  return `${name}#${pr.number}`;
}

/** Builds the system notification for one PR's changes in a poll. */
export function describeChange({ pr, events, ci }) {
  const approvals = events.filter((e) => e.kind === "approved");
  const changes = events.filter((e) => e.kind === "changes_requested");
  const comments = events.filter((e) => e.kind === "comment");

  const lines = [];
  if (approvals.length) lines.push(`✅ Апрув: ${uniqueAuthors(approvals)}`);
  if (changes.length) lines.push(`⛔ Просят изменения: ${uniqueAuthors(changes)}`);
  if (comments.length) {
    const n = comments.length;
    lines.push(
      `💬 ${n} ${plural(n, ["новый", "новых", "новых"])} ${plural(n, ["комментарий", "комментария", "комментариев"])}: ${uniqueAuthors(comments)}`,
    );
  }
  if (ci === "failure") lines.push("❌ CI упал");
  if (ci === "success") lines.push("🟢 CI прошёл");

  return {
    title: truncate(`${prLabel(pr)} · ${pr.title}`, 80),
    message: lines.join("\n"),
    url: events.length === 1 && !ci ? events[0].url : pr.url,
  };
}

export function timeAgo(iso, now = Date.now()) {
  if (!iso) return "никогда";
  const sec = Math.max(0, Math.round((now - new Date(iso).getTime()) / 1000));
  if (sec < 60) return "только что";
  const min = Math.round(sec / 60);
  if (min < 60) return `${min} мин назад`;
  const h = Math.round(min / 60);
  if (h < 24) return `${h} ч назад`;
  const d = Math.round(h / 24);
  return `${d} ${plural(d, ["день", "дня", "дней"])} назад`;
}
