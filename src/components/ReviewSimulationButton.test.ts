import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const source = readFileSync(
  new URL("./ReviewSimulationButton.tsx", import.meta.url),
  "utf8",
);

test("resets the running CTA when the displayed simulation run changes", () => {
  assert.match(source, /useSearchParams/);
  assert.match(source, /const displayedRunId = searchParams\.get\("run"\);/);
  assert.match(
    source,
    /useEffect\(\(\) => \{\s*setRunning\(false\);\s*\}, \[displayedRunId\]\);/s,
  );
});

test("keeps the CTA running until navigation changes the run id", () => {
  const navigationStart = source.indexOf(
    "router.push(`/dashboard/configuracao/revisao?run=${encodeURIComponent(data.runId)}`);",
  );
  assert.notEqual(navigationStart, -1);

  const successBlockStart = source.indexOf('if (!data.runId) {');
  const catchStart = source.indexOf("} catch (err) {");
  assert.ok(successBlockStart >= 0 && catchStart > successBlockStart);

  const successBlock = source.slice(successBlockStart, catchStart);
  assert.doesNotMatch(successBlock, /setRunning\(false\)/);
});
