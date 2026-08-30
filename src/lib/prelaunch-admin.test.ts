import assert from "node:assert/strict";
import test from "node:test";

import { isPrelaunchAdmin } from "./prelaunch-admin";

test("prelaunch admin access is fail-closed without an explicit list", () => {
  assert.equal(isPrelaunchAdmin("admin@example.com", {}), false);
  assert.equal(
    isPrelaunchAdmin("admin@example.com", { NODE_ENV: "development" }),
    false,
  );
});

test("prelaunch admin email matching is normalized", () => {
  const environment = {
    SONORIZA_ADMIN_EMAILS: "owner@example.com, ADMIN@example.com",
  };

  assert.equal(isPrelaunchAdmin(" admin@EXAMPLE.com ", environment), true);
  assert.equal(isPrelaunchAdmin("other@example.com", environment), false);
});
