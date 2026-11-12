import { test } from "node:test";
import assert from "node:assert/strict";
import { fillTemplate, claudeLink, folderFor, MAX_PROMPT } from "../lib/claude.js";

const pr = { url: "https://github.com/o/r/pull/7", title: "Fix & add", repo: "o/r", number: 7, author: "ivan" };

test("fillTemplate substitutes all five fields", () => {
  assert.equal(
    fillTemplate("{url} | {title} | {repo} | #{number} | {author}", pr),
    "https://github.com/o/r/pull/7 | Fix & add | o/r | #7 | ivan",
  );
});

test("fillTemplate keeps unknown placeholders and replaces repeated ones", () => {
  assert.equal(fillTemplate("{foo} {url} {url}", pr), "{foo} https://github.com/o/r/pull/7 https://github.com/o/r/pull/7");
});

test("fillTemplate uses an empty string when author is missing", () => {
  const { author, ...own } = pr;
  assert.equal(fillTemplate("by [{author}]", own), "by []");
});

test("fillTemplate does not interpret $ patterns in values", () => {
  assert.equal(fillTemplate("{title}", { ...pr, title: "$& $1" }), "$& $1");
});

test("claudeLink encodes special characters in the prompt", () => {
  assert.equal(claudeLink({ prompt: "a & b\n#1" }), "claude://code/new?q=a%20%26%20b%0A%231");
});

test("claudeLink truncates the prompt to MAX_PROMPT characters", () => {
  assert.equal(MAX_PROMPT, 14000);
  const link = claudeLink({ prompt: "x".repeat(15000) });
  const q = new URL(link.replace("claude://", "https://")).searchParams.get("q");
  assert.equal(q.length, 14000);
});

test("claudeLink adds folder only when it is non-blank", () => {
  assert.equal(claudeLink({ prompt: "p", folder: "  " }), "claude://code/new?q=p");
  assert.equal(claudeLink({ prompt: "p" }), "claude://code/new?q=p");
  assert.equal(
    claudeLink({ prompt: "p", folder: "/home/me/repo" }),
    "claude://code/new?q=p&folder=%2Fhome%2Fme%2Frepo",
  );
});

test("folderFor matches repo names case-insensitively", () => {
  assert.equal(folderFor({ "o/r": "/p" }, "O/R"), "/p");
  assert.equal(folderFor({ "O/R": "/p" }, "o/r"), "/p");
  assert.equal(folderFor({ "o/r": "/p" }, "o/other"), null);
  assert.equal(folderFor({}, "o/r"), null);
});

test("claudeLink never leaves a lone high surrogate at the cut", () => {
  const link = claudeLink({ prompt: "x".repeat(13999) + "\u{1F600}more" });
  const q = new URL(link.replace("claude://", "https://")).searchParams.get("q");
  assert.ok(q.length <= MAX_PROMPT);
  assert.ok(q.endsWith("x"));
  assert.equal(q, "x".repeat(13999));
});

test("claudeLink treats a non-string prompt as empty", () => {
  assert.equal(claudeLink({ prompt: undefined }), "claude://code/new?q=");
  assert.equal(claudeLink({ prompt: null }), "claude://code/new?q=");
  assert.equal(claudeLink({ prompt: 42 }), "claude://code/new?q=");
});
