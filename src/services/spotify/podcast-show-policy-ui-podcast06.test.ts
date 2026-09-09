import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

test("canonical podcast policy UI exposes PODCAST-06 cadence and priority without a second settings surface", () => {
  const page = readFileSync(
    "src/app/dashboard/configuracao/fontes/podcasts/page.tsx",
    "utf8",
  );
  const client = readFileSync(
    "src/app/dashboard/configuracao/fontes/podcasts/podcast-policy-client.tsx",
    "utf8",
  );

  assert.match(page, /PODCAST-05 · PODCAST-06/);
  assert.match(page, /cadenceMode/);
  assert.match(page, /cadenceMaxEpisodes/);
  assert.match(page, /cadenceUnit/);
  assert.match(page, /priority/);
  assert.match(page, /savePodcastShowPolicy/);

  assert.match(client, /Frequência de escuta/);
  assert.match(client, /name="cadenceMode"/);
  assert.match(client, /name="cadenceMaxEpisodes"/);
  assert.match(client, /name="cadenceUnit"/);
  assert.match(client, /value="DAY"/);
  assert.match(client, /value="WEEK"/);
  assert.match(client, /value="MONTH"/);
  assert.match(client, /name="priority"/);
  assert.match(client, /value="NORMAL"/);
  assert.match(client, /value="PRIORITY"/);
  assert.match(client, /cadenceLabel\(policy\)/);
  assert.match(client, /Prioritário/);
});
