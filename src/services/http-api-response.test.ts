import assert from "node:assert/strict";
import test from "node:test";

import {
  readJsonApiResponse,
  unexpectedResponseMessage,
} from "./http-api-response";

test("preserva payload JSON de erro para tratamento existente", async () => {
  const response = new Response(
    JSON.stringify({
      error: "Quota indisponível",
      code: "SPOTIFY_BACKOFF_ACTIVE",
      reason: "QUOTA_EXCEEDED",
    }),
    {
      status: 429,
      headers: { "content-type": "application/json; charset=utf-8" },
    },
  );

  const data = await readJsonApiResponse<{
    error: string;
    code: string;
    reason: string;
  }>(response, "a verificação do Spotify");

  assert.equal(data.error, "Quota indisponível");
  assert.equal(data.code, "SPOTIFY_BACKOFF_ACTIVE");
  assert.equal(data.reason, "QUOTA_EXCEEDED");
});

test("HTML 502 vira erro amigável e não vaza corpo HTML", async () => {
  const response = new Response("<html><h1>502 Bad Gateway</h1></html>", {
    status: 502,
    headers: { "content-type": "text/html; charset=utf-8" },
  });

  await assert.rejects(
    () => readJsonApiResponse(response, "a simulação"),
    (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.match(error.message, /HTTP 502/);
      assert.match(error.message, /interrompeu a resposta/);
      assert.doesNotMatch(error.message, /<html>/i);
      assert.doesNotMatch(error.message, /Unexpected token/i);
      return true;
    },
  );
});

test("HTML 504 informa timeout sem tentar parsear JSON", async () => {
  const response = new Response("<html>gateway timeout</html>", {
    status: 504,
    headers: { "content-type": "text/html" },
  });

  await assert.rejects(
    () => readJsonApiResponse(response, "a simulação"),
    /HTTP 504 — O servidor excedeu o tempo de resposta durante a simulação/,
  );
});

test("JSON malformado produz diagnóstico próprio", async () => {
  const response = new Response("{invalid", {
    status: 502,
    headers: { "content-type": "application/json" },
  });

  await assert.rejects(
    () => readJsonApiResponse(response, "a simulação"),
    /HTTP 502 — O servidor retornou uma resposta JSON inválida durante a simulação/,
  );
});

test("mensagem genérica sempre preserva status HTTP", () => {
  assert.equal(
    unexpectedResponseMessage(418, "a verificação do Spotify"),
    "HTTP 418 — O servidor retornou uma resposta inesperada durante a verificação do Spotify.",
  );
});
