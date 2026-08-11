import assert from "node:assert/strict";
import test from "node:test";

import {
  isEmailAllowed,
  isOAuthIdentityAllowed,
  normalizeEmail,
  parseAllowedEmails,
  readOAuthProfileEmail,
} from "./email-allowlist";

test("normalizes email with trim and lowercase", () => {
  assert.equal(normalizeEmail("  User@Example.COM  "), "user@example.com");
  assert.equal(normalizeEmail("   "), null);
  assert.equal(normalizeEmail(null), null);
});

test("parses comma and line separated allowlists deterministically", () => {
  const allowed = parseAllowedEmails(
    " User@Example.com, second@example.com\nTHIRD@example.com\r\nuser@example.com ",
  );

  assert.deepEqual([...allowed].sort(), [
    "second@example.com",
    "third@example.com",
    "user@example.com",
  ]);
});

test("production fails closed when no allowlist is configured", () => {
  assert.equal(
    isEmailAllowed("owner@example.com", {
      NODE_ENV: "production",
      SONORIZA_ALLOWED_EMAILS: undefined,
    }),
    false,
  );
  assert.equal(
    isEmailAllowed("owner@example.com", {
      NODE_ENV: "production",
      SONORIZA_ALLOWED_EMAILS: "  , \n ",
    }),
    false,
  );
});

test("development and test stay open only while the allowlist is absent", () => {
  assert.equal(
    isEmailAllowed("owner@example.com", {
      NODE_ENV: "development",
      SONORIZA_ALLOWED_EMAILS: undefined,
    }),
    true,
  );
  assert.equal(
    isEmailAllowed("owner@example.com", {
      NODE_ENV: "test",
      SONORIZA_ALLOWED_EMAILS: undefined,
    }),
    true,
  );
  assert.equal(
    isEmailAllowed("other@example.com", {
      NODE_ENV: "development",
      SONORIZA_ALLOWED_EMAILS: "owner@example.com",
    }),
    false,
  );
});

test("configured allowlist is case-insensitive and exact", () => {
  const env = {
    NODE_ENV: "production",
    SONORIZA_ALLOWED_EMAILS: "owner@example.com,tester@example.com",
  };
  assert.equal(isEmailAllowed("OWNER@EXAMPLE.COM", env), true);
  assert.equal(isEmailAllowed("tester@example.com", env), true);
  assert.equal(isEmailAllowed("other@example.com", env), false);
  assert.equal(isEmailAllowed(null, env), false);
});

test("reads provider email safely", () => {
  assert.equal(
    readOAuthProfileEmail({ email: " Provider@Example.com " }),
    "provider@example.com",
  );
  assert.equal(readOAuthProfileEmail({ email: null }), null);
  assert.equal(readOAuthProfileEmail(null), null);
});

test("OAuth requires both provider email and Auth.js user email to be allowed", () => {
  const env = {
    NODE_ENV: "production",
    SONORIZA_ALLOWED_EMAILS: "owner@example.com,tester@example.com",
  };

  assert.equal(
    isOAuthIdentityAllowed(
      "owner@example.com",
      { email: "OWNER@example.com" },
      env,
    ),
    true,
  );
  assert.equal(
    isOAuthIdentityAllowed(
      "removed@example.com",
      { email: "tester@example.com" },
      env,
    ),
    false,
    "an old disallowed session cannot link a newly allowed provider",
  );
  assert.equal(
    isOAuthIdentityAllowed(
      "owner@example.com",
      { email: "blocked@example.com" },
      env,
    ),
    false,
  );
  assert.equal(
    isOAuthIdentityAllowed("owner@example.com", {}, env),
    false,
    "missing provider email fails closed",
  );
});
