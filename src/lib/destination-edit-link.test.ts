import assert from "node:assert/strict";
import test from "node:test";

import { destinationCardId, destinationEditHref } from "./destination-edit-link";

test("edit link opens the target editor and scrolls to its card", () => {
  assert.equal(destinationCardId("cmsj5ognn0001ji57670mc04x"), "destino-cmsj5ognn0001ji57670mc04x");
  assert.equal(
    destinationEditHref("cmsj5ognn0001ji57670mc04x"),
    "/dashboard/configuracao/destinos?editar=cmsj5ognn0001ji57670mc04x#destino-cmsj5ognn0001ji57670mc04x",
  );
});

test("edit link encodes unexpected characters", () => {
  assert.equal(
    destinationEditHref("a b&c"),
    "/dashboard/configuracao/destinos?editar=a%20b%26c#destino-a%20b%26c",
  );
});
