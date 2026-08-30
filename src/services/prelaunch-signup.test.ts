import assert from "node:assert/strict";
import test from "node:test";

import {
  normalizePrelaunchEmail,
  prelaunchSignupSchema,
} from "./prelaunch-contract";

test("normalizes prelaunch email deterministically", () => {
  assert.equal(normalizePrelaunchEmail("  Teste@Exemplo.COM  "), "teste@exemplo.com");
});

test("accepts a valid signup with privacy consent", () => {
  const parsed = prelaunchSignupSchema.safeParse({
    email: "pessoa@example.com",
    privacyAccepted: true,
    website: "",
  });
  assert.equal(parsed.success, true);
});

test("rejects invalid email, missing consent and honeypot content", () => {
  assert.equal(
    prelaunchSignupSchema.safeParse({ email: "invalido", privacyAccepted: true }).success,
    false,
  );
  assert.equal(
    prelaunchSignupSchema.safeParse({ email: "pessoa@example.com", privacyAccepted: false }).success,
    false,
  );
  assert.equal(
    prelaunchSignupSchema.safeParse({
      email: "pessoa@example.com",
      privacyAccepted: true,
      website: "bot",
    }).success,
    false,
  );
});
