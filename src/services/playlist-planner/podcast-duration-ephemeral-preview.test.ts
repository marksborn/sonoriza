import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import {
  validatePodcast08EphemeralPreviewRequest,
  validatePodcast08EphemeralPreviewTarget,
} from "./podcast-duration-ephemeral-preview";

const WORK = "cmsj5ognn0001ji57670mc04x";
const base = {
  simulate: true,
  targetScope: [WORK],
  preview: {
    targetPlaylistId: WORK,
    bands: ["ANY" as const, "SHORT" as const, "ANY" as const],
  },
  activeMode: "OFF",
};
const target = {
  preview: base.preview,
  targetId: WORK,
  compositionMode: "SEQUENCE" as const,
  sequencePattern: ["MUSIC" as const, "PODCAST" as const, "MUSIC" as const],
  hasDurationBlocks: false,
  enabled: true,
};
function rejects(call:()=>void) {
  assert.throws(call,/PODCAST-08 preview/);
}

test("#449: only one active Trabalho simulation is accepted", () => {
  assert.doesNotThrow(()=>validatePodcast08EphemeralPreviewRequest(base));
  assert.doesNotThrow(()=>validatePodcast08EphemeralPreviewTarget(target));
});

test("#449: any real run, multi-target or unscoped preview must fail", () => {
  rejects(()=>validatePodcast08EphemeralPreviewRequest({...base,simulate:false}));
  rejects(()=>validatePodcast08EphemeralPreviewRequest({...base,targetScope:null}));
  rejects(()=>validatePodcast08EphemeralPreviewRequest({...base,targetScope:[WORK,"car"]}));
  rejects(()=>validatePodcast08EphemeralPreviewRequest({
    ...base,targetScope:["car"],
  }));
});

test("#449: ACTIVE pilot mode must not mix with ephemeral shadow", () => {
  rejects(()=>validatePodcast08EphemeralPreviewRequest({
    ...base,activeMode:"ACTIVE",
  }));
});

test("#449: malformed or all-ANY bands are not accepted", () => {
  for (const bands of [[],["ANY"],["ANY","INVALID","ANY"],Array(21).fill("SHORT")]) {
    rejects(()=>validatePodcast08EphemeralPreviewRequest({
      ...base,preview:{targetPlaylistId:WORK,bands:bands as typeof base.preview.bands},
    }));
  }
});

test("#449: parser rejects shifted bands or specific MUSIC positions", () => {
  rejects(()=>validatePodcast08EphemeralPreviewTarget({
    ...target,preview:{targetPlaylistId:WORK,bands:["SHORT","ANY","ANY"]},
  }));
  rejects(()=>validatePodcast08EphemeralPreviewTarget({
    ...target,preview:{targetPlaylistId:WORK,bands:["ANY","SHORT"]},
  }));
});

test("#449: disabled, proportion or segmented targets cannot be previewed", () => {
  rejects(()=>validatePodcast08EphemeralPreviewTarget({...target,enabled:false}));
  rejects(()=>validatePodcast08EphemeralPreviewTarget({...target,
    compositionMode:"PROPORTION"}));
  rejects(()=>validatePodcast08EphemeralPreviewTarget({...target,
    hasDurationBlocks:true}));
});

test("#449: preview is not exposed as new API request parameter", () => {
  const api=readFileSync("src/app/api/generate/route.ts","utf8");
  assert.doesNotMatch(api,/podcast08EphemeralPreview/);
});

test("#449: generator restricts previews to simulation and blocks CONFIG-04 approval", () => {
  const job=readFileSync("src/jobs/generate-playlists-incremental.ts","utf8");
  assert.match(job,/validatePodcast08EphemeralPreviewRequest/);
  assert.match(job,/!Boolean\(opts\.podcast08EphemeralPreview\)/);
  assert.match(job,/summary\.podcast08PreviewNotForApproval = true/);
  assert.match(job,/podcast08BandsByTargetId\.set/);
});
