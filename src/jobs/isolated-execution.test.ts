import assert from "node:assert/strict";
import test from "node:test";

import { runIsolated } from "./isolated-execution";

test("#92 a falha de um destino não impede a execução do próximo", async () => {
  const executed: string[] = [];
  const failures: string[] = [];

  await runIsolated(
    ["Carro", "Trabalho"],
    async (target) => {
      executed.push(target);

      if (target === "Carro") {
        throw new Error("falha do Carro");
      }
    },
    async (target, error) => {
      failures.push(
        `${target}:${error instanceof Error ? error.message : String(error)}`,
      );
    },
  );

  assert.deepEqual(executed, ["Carro", "Trabalho"]);
  assert.deepEqual(failures, ["Carro:falha do Carro"]);
});
