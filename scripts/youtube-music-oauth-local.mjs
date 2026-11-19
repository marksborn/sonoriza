#!/usr/bin/env node
/**
 * YTM-01 — Local-only, one-shot OAuth authorization for YouTube READS.
 * Requires a Google Cloud OAuth 2.0 client with application type Desktop.
 * Does not request offline access, save refresh tokens or touch Sonoriza auth.
 *
 * Usage: YT_POC_CLIENT_ID=... YT_POC_CLIENT_SECRET=... \
 *   node scripts/youtube-music-oauth-local.mjs mine
 *   node scripts/youtube-music-oauth-local.mjs inspect --playlist-id PL...
 */
import { randomBytes, createHash } from "node:crypto";
import { createServer } from "node:http";
import { run as runProbe } from "./youtube-music-poc.mjs";

const SCOPE = "https://www.googleapis.com/auth/youtube.readonly";
const TIMEOUT_MS = 180_000;
const CALLBACK_PATH = "/ytm-01-callback";

function assertReadOnlyCommand(args) {
  const [command, ...rest] = args;
  if (!["mine", "inspect"].includes(command)) {
    throw new Error("OAuth local allows only mine or inspect (read-only).");
  }
  if (rest.includes("--execute") || rest.includes("--videos")) {
    throw new Error("Write flags are not allowed with read-only OAuth.");
  }
  return args;
}

function responsePage(response, statusCode, message) {
  response.writeHead(statusCode, {
    "Content-Type": "text/plain; charset=utf-8",
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
  });
  response.end(message + "\n");
}

async function authorize(clientId, clientSecret) {
  const verifier = randomBytes(32).toString("base64url");
  const challenge = createHash("sha256").update(verifier).digest("base64url");
  const state = randomBytes(24).toString("base64url");

  let complete;
  let rejectAuth;
  const authorization = new Promise((resolve, reject) => {
    complete = resolve;
    rejectAuth = reject;
  });

  let used = false;
  const server = createServer((request, response) => {
    try {
      const parsed = new URL(request.url ?? "/", "http://127.0.0.1");
      if (request.method !== "GET" || parsed.pathname !== CALLBACK_PATH) {
        return responsePage(response, 404, "Not found");
      }
      if (used) return responsePage(response, 410, "This authorization was already handled");
      if (parsed.searchParams.get("state") !== state) {
        return responsePage(response, 403, "Invalid authorization state");
      }

      used = true;
      if (parsed.searchParams.has("error")) {
        responsePage(response, 400, "Access was not granted. You may close this page.");
        rejectAuth(new Error("OAuth authorization denied or cancelled"));
      } else if (!parsed.searchParams.get("code")) {
        responsePage(response, 400, "Authorization code missing.");
        rejectAuth(new Error("OAuth response missing authorization code"));
      } else {
        const code = parsed.searchParams.get("code");
        responsePage(response, 200, "Permission received. Return to your terminal; you may close this page.");
        complete(code);
      }
      server.close();
    } catch {
      responsePage(response, 400, "Invalid OAuth callback");
    }
  });

  server.on("error", (error) => {
    rejectAuth(new Error("Local callback server failed: " + error.message));
  });
  await new Promise((resolve, reject) => {
    server.listen(0, "127.0.0.1", () => resolve());
    server.once("error", reject);
  });

  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Could not bind local OAuth callback");
  const redirectUri = "http://127.0.0.1:" + address.port + CALLBACK_PATH;
  const authorizationUrl = new URL("https://accounts.google.com/o/oauth2/v2/auth");
  authorizationUrl.searchParams.set("client_id", clientId);
  authorizationUrl.searchParams.set("redirect_uri", redirectUri);
  authorizationUrl.searchParams.set("response_type", "code");
  authorizationUrl.searchParams.set("scope", SCOPE);
  authorizationUrl.searchParams.set("access_type", "online");
  authorizationUrl.searchParams.set("state", state);
  authorizationUrl.searchParams.set("code_challenge", challenge);
  authorizationUrl.searchParams.set("code_challenge_method", "S256");

  // Authorization URL contains a one-time CSRF state, not a token.
  process.stderr.write("Open this Google authorization link in your own browser:\n" + authorizationUrl.href + "\n");
  const timer = setTimeout(() => {
    rejectAuth(new Error("OAuth authorization timed out. Please restart the command."));
    server.close();
  }, TIMEOUT_MS);
  timer.unref();

  try {
    const code = await authorization;
    const body = new URLSearchParams({
      code,
      client_id: clientId,
      redirect_uri: redirectUri,
      grant_type: "authorization_code",
      code_verifier: verifier,
    });
    if (clientSecret) body.set("client_secret", clientSecret);
    const response = await fetch("https://oauth2.googleapis.com/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body,
      signal: AbortSignal.timeout(15000),
    });
    if (!response.ok) {
      // Google error bodies can contain credential details; do not print them.
      throw new Error("Google token exchange failed (HTTP " + response.status + ")");
    }
    const payload = await response.json();
    if (!payload.access_token || !String(payload.scope ?? "").split(" ").includes(SCOPE)) {
      throw new Error("Google did not return the expected YouTube read-only grant");
    }
    // Deliberately discard any refresh token; this is not a production integration.
    return payload.access_token;
  } finally {
    clearTimeout(timer);
    if (server.listening) server.close();
  }
}

async function main(argv) {
  const commandArgs = assertReadOnlyCommand(argv);
  const clientId = process.env.YT_POC_CLIENT_ID?.trim();
  const clientSecret = process.env.YT_POC_CLIENT_SECRET?.trim() ?? "";
  if (!clientId || !clientId.endsWith(".apps.googleusercontent.com")) {
    throw new Error("Set YT_POC_CLIENT_ID to the OAuth Desktop client ID from your TEST Google Cloud project");
  }
  if (process.env.YT_POC_ACCESS_TOKEN) {
    throw new Error("Unset YT_POC_ACCESS_TOKEN before using the one-shot OAuth helper");
  }
  try {
    process.env.YT_POC_ACCESS_TOKEN = await authorize(clientId, clientSecret);
    await runProbe(commandArgs);
  } finally {
    delete process.env.YT_POC_ACCESS_TOKEN;
  }
}

main(process.argv.slice(2)).catch((error) => {
  process.stderr.write("YTM-01 read-only OAuth: " + error.message + "\n");
  process.exitCode = 1;
});
