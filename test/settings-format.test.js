import { test } from "node:test";
import assert from "node:assert/strict";
import { normalizeRepo, prMatchesRepo, withDefaults } from "../lib/settings.js";
import { describeChange, plural } from "../lib/format.js";

test("repos normalize from names, URLs and wildcards", () => {
  assert.equal(normalizeRepo(" VirtoCommerce/vc-frontend "), "VirtoCommerce/vc-frontend");
  assert.equal(normalizeRepo("https://github.com/VirtoCommerce/vc-module-x.git"), "VirtoCommerce/vc-module-x");
  assert.equal(normalizeRepo("https://github.com/o/r/pull/12"), "o/r");
  assert.equal(normalizeRepo("VirtoCommerce/*"), "VirtoCommerce/*");
  assert.equal(normalizeRepo("not a repo"), null);
  assert.equal(normalizeRepo("vc-frontend"), null);
});

test("wildcard repo matches every repo of the owner", () => {
  assert.ok(prMatchesRepo("VirtoCommerce/vc-frontend", "virtocommerce/*"));
  assert.ok(!prMatchesRepo("Other/vc-frontend", "VirtoCommerce/*"));
  assert.ok(prMatchesRepo("o/R", "O/r"));
});

test("defaults merge nested notify flags", () => {
  const s = withDefaults({ notify: { ciSuccess: true } });
  assert.equal(s.notify.ciSuccess, true);
  assert.equal(s.notify.comments, true);
  assert.equal(s.intervalMin, 2);
});

test("russian plural forms", () => {
  const forms = ["комментарий", "комментария", "комментариев"];
  assert.equal(plural(1, forms), "комментарий");
  assert.equal(plural(3, forms), "комментария");
  assert.equal(plural(11, forms), "комментариев");
  assert.equal(plural(21, forms), "комментарий");
});

test("notification groups a PR's events and links the single comment", () => {
  const pr = { repo: "o/vc-frontend", number: 5, title: "Fix cart", url: "pr-url" };
  const ev = (id, kind, author) => ({ id, kind, author, url: `u/${id}` });

  const many = describeChange({
    pr,
    events: [ev("1", "comment", "bob"), ev("2", "comment", "bob"), ev("3", "approved", "alice")],
    ci: "failure",
  });
  assert.equal(many.title, "vc-frontend#5 · Fix cart");
  assert.equal(many.message, "✅ Апрув: alice\n💬 2 новых комментария: bob\n❌ CI упал");
  assert.equal(many.url, "pr-url");

  const one = describeChange({ pr, events: [ev("9", "comment", "bob")], ci: null });
  assert.equal(one.message, "💬 1 новый комментарий: bob");
  assert.equal(one.url, "u/9");
});
