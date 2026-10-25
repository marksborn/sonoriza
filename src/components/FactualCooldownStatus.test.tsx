import assert from "node:assert/strict";
import test from "node:test";
import * as React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { factualCooldownDisplay } from "@/services/factual-cooldown-status";
import { FactualCooldownStatus } from "./FactualCooldownStatus";

const factual = {
  policyVersion: "music-repeat-lastfm-factual-v1", source: "LASTFM_SCROBBLE",
  configuredMode: "ACTIVE", effectiveMode: "ACTIVE", status: "READY_ACTIVE",
  productiveInfluenceAllowed: true, providerComplete: true,
  preWriteRevalidated: true, preWriteBlockedCount: 0,
};
function display(change: Record<string, unknown> = {}, runStatus = "SUCCESS") {
  return factualCooldownDisplay({ summary: { musicRepeatLastFmFactual: { ...factual, ...change } }, runStatus });
}

test("#512 verified requires complete ACTIVE coverage and prewrite evidence", () => {
  assert.equal(display().state, "VERIFIED");
  assert.equal(display({}, "PARTIAL").state, "VERIFIED");
  for (const change of [
    { providerComplete: false }, { providerComplete: null }, { providerComplete: "true" },
    { preWriteRevalidated: false }, { preWriteRevalidated: undefined },
    { productiveInfluenceAllowed: false }, { productiveInfluenceAllowed: undefined },
    { preWriteBlockedCount: 1 }, { preWriteBlockedCount: null }, { preWriteBlockedCount: "0" },
    { preWriteBlockedCount: undefined }, { status: "PROVIDER_INCOMPLETE" },
    { effectiveMode: "SHADOW" },
  ]) assert.notEqual(display(change).state, "VERIFIED", JSON.stringify(change));
  for (const status of ["FAILED", "PENDING", "RUNNING", "unknown"]) {
    assert.notEqual(display({}, status).state, "VERIFIED");
  }
});

test("#512 a historical SUCCESS with ACTIVE degraded to SHADOW is unconfirmed", () => {
  const value = display({ effectiveMode: "SHADOW", status: "PROVIDER_UNAVAILABLE",
    providerComplete: false, preWriteRevalidated: false, matchedCandidateCount: 248, skippedCandidateCount: 0 });
  assert.equal(value.state, "UNCONFIRMED");
  assert.match(value.description, /resultado geral.*não comprova/);
});

test("#512 shadow, disabled and simulation cannot claim productive protection", () => {
  assert.equal(display({ configuredMode: "SHADOW", effectiveMode: "SHADOW", status: "READY_SHADOW" }).state, "OBSERVED");
  for (const status of ["OFF", "USER_NOT_ALLOWLISTED", "POLICY_DISABLED"]) {
    assert.equal(display({ status }).state, "NOT_APPLIED");
  }
  const summary = { musicRepeatLastFmFactual: factual };
  assert.equal(factualCooldownDisplay({ summary, simulation: true, runStatus: "SUCCESS" }).state, "OBSERVED");
  assert.equal(factualCooldownDisplay({ summary: { ...summary, simulate: true }, runStatus: "SUCCESS" }).state, "OBSERVED");
});

test("#512 missing, malformed and future contracts stay unknown without reading current policy", () => {
  for (const summary of [null, [], "invalid", {}, { musicRepeatLastFmFactual: [] }]) {
    assert.equal(factualCooldownDisplay({ summary, runStatus: "SUCCESS" }).state, "UNKNOWN");
  }
  assert.equal(display({ policyVersion: "future-v2" }).state, "UNKNOWN");
  assert.equal(display({ source: "SPOTIFY_RECENTLY_PLAYED" }).state, "UNKNOWN");
});

test("#512 server rendering shows scope and never renders provider failures or action controls", () => {
  const html = renderToStaticMarkup(<FactualCooldownStatus runStatus="SUCCESS" summary={{ musicRepeatLastFmFactual: {
    ...factual, failure: "https://provider.invalid/?api_key=SECRET", userId: "PRIVATE-USER",
  } }} />);
  assert.match(html, /Proteção factual verificada/);
  assert.match(html, /artista e título/);
  assert.match(html, /versões com nomes diferentes/);
  assert.doesNotMatch(html, /SECRET|PRIVATE-USER|provider.invalid|<form|<button/);
  const old = renderToStaticMarkup(<FactualCooldownStatus runStatus="SUCCESS" summary={null} />);
  assert.match(old, /Sem registro da proteção/);
  assert.doesNotMatch(old, /text-emerald/);
  const degraded = renderToStaticMarkup(<FactualCooldownStatus runStatus="SUCCESS" summary={{ musicRepeatLastFmFactual: {
    ...factual, effectiveMode: "SHADOW", status: "PROVIDER_UNAVAILABLE", failure: "SECRET",
  } }} />);
  assert.match(degraded, /Histórico Last.fm indisponível/);
  assert.doesNotMatch(degraded, /text-emerald|SECRET/);
});
