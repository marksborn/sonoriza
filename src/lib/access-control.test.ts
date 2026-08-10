import assert from "node:assert/strict";
import test from "node:test";

import {
  isEmailAllowed,
  normalizeEmail,
  parseAllowedEmails,
} from "./access-control";

test("allowlist normalizes case, whitespace and common separators", () => {
  assert.deepEqual(
    [...parseAllowedEmails(" Owner@Example.com, tester@example.com\nthird@example.com ; ")],
    ["owner@example.com", "tester@example.com", "third@example.com"],
  );
  assert.equal(normalizeEmail("  USER@Example.COM "), "user@example.com");
});

test("configured allowlist only accepts exact normalized emails", () => {
  const raw = "owner@example.com,tester@example.com";
  assert.equal(isEmailAllowed("OWNER@example.com", { raw, production: true }), true);
  assert.equal(isEmailAllowed("other@example.com", { raw, production: true }), false);
  assert.equal(isEmailAllowed(null, { raw, production: true }), false);
});

test("production fails closed when allowlist is empty or missing", () => {
  assert.equal(isEmailAllowed("owner@example.com", { raw: "", production: true }), false);
  assert.equal(isEmailAllowed("owner@example.com", { raw: null, production: true }), false);
});

test("local and test environments remain usable without production allowlist", () => {
  assert.equal(isEmailAllowed("developer@example.com", { raw: "", production: false }), true);
});
