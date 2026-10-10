import assert from "node:assert/strict";
import test from "node:test";
import {
  appendPodcastDurationEditorSlot,
  hydratePodcastDurationEditorSlots,
  movePodcastDurationEditorSlot,
  removePodcastDurationEditorSlot,
  serializePodcastDurationEditorSlots,
  setPodcastDurationEditorBand,
  maySavePodcastDurationBandsWhenEditorDisabled,
} from "./podcast-duration-sequence-editor";
import { parsePersistedPodcastDurationSlots } from "./podcast-duration-persistence";

test("#365 UI: legacy sequence hydrates to all ANY", () => {
  assert.deepEqual(hydratePodcastDurationEditorSlots(["MUSIC","PODCAST"], null), [
    {type:"MUSIC",band:"ANY"}, {type:"PODCAST",band:"ANY"},
  ]);
});

test("#365 UI: changing band and moving a podcast preserves the association", () => {
  let slots = hydratePodcastDurationEditorSlots(["MUSIC","PODCAST","PODCAST"], [
    "ANY","SHORT","LONG",
  ])!;
  slots = movePodcastDurationEditorSlot(slots, 1, 1);
  assert.deepEqual(slots, [
    {type:"MUSIC",band:"ANY"},
    {type:"PODCAST",band:"LONG"},
    {type:"PODCAST",band:"SHORT"},
  ]);
  slots = setPodcastDurationEditorBand(slots, 2, "MEDIUM");
  assert.deepEqual(JSON.parse(serializePodcastDurationEditorSlots(slots).podcastDurationSlotBands),
    ["ANY","LONG","MEDIUM"]);
});

test("#365 UI: removing a podcast removes its band in the same operation", () => {
  const first = hydratePodcastDurationEditorSlots(["PODCAST","MUSIC","PODCAST"],[
    "SHORT","ANY","LONG",
  ])!;
  const next = removePodcastDurationEditorSlot(first,0);
  assert.deepEqual(next,[{type:"MUSIC",band:"ANY"},{type:"PODCAST",band:"LONG"}]);
  assert.deepEqual(serializePodcastDurationEditorSlots(next),{
    sequencePattern: '["MUSIC","PODCAST"]',
    podcastDurationSlotBands: '["ANY","LONG"]',
  });
});

test("#365 UI: appending MUSIC and PODCAST defaults to ANY", () => {
  const one = hydratePodcastDurationEditorSlots(["PODCAST"],["LONG"])!;
  const two = appendPodcastDurationEditorSlot(one,"MUSIC");
  const three = appendPodcastDurationEditorSlot(two,"PODCAST");
  assert.deepEqual(three,[
    {type:"PODCAST",band:"LONG"},
    {type:"MUSIC",band:"ANY"},
    {type:"PODCAST",band:"ANY"},
  ]);
  assert.deepEqual(parsePersistedPodcastDurationSlots(
    JSON.parse(serializePodcastDurationEditorSlots(three).sequencePattern),
    JSON.parse(serializePodcastDurationEditorSlots(three).podcastDurationSlotBands),
  ),["LONG","ANY","ANY"]);
});

test("#365 UI: manipulating an invalid position never affects the sequence", () => {
  const input = hydratePodcastDurationEditorSlots(["MUSIC","PODCAST"],["ANY","SHORT"])!;
  assert.deepEqual(movePodcastDurationEditorSlot(input,0,-1),input);
  assert.deepEqual(removePodcastDurationEditorSlot(input,5),input);
  assert.deepEqual(setPodcastDurationEditorBand(input,0,"LONG"),input);
});

test("#365 UI: max of 20 and min of one slot remain enforced", () => {
  const arr = Array.from({length:20},()=>({type:"PODCAST" as const,band:"ANY" as const}));
  assert.equal(appendPodcastDurationEditorSlot(arr,"PODCAST").length,20);
  assert.equal(removePodcastDurationEditorSlot([{type:"MUSIC",band:"ANY"}],0).length,1);
});

test("#365 UI: malformed stored bands cannot silently become ANY", () => {
  assert.equal(hydratePodcastDurationEditorSlots(["MUSIC","PODCAST"],["LONG","SHORT"]),null);
  assert.equal(hydratePodcastDurationEditorSlots(["MUSIC","PODCAST"],["SHORT"]),null);
});

test("#365 UI gate: no new specific band may be saved without opt-in", () => {
  assert.equal(maySavePodcastDurationBandsWhenEditorDisabled({
    existingSequence: null, existingBands: null,
    nextSequence: ["MUSIC","PODCAST"], nextBands: ["ANY","SHORT"],
  }), false);
  assert.equal(maySavePodcastDurationBandsWhenEditorDisabled({
    existingSequence: null, existingBands: null,
    nextSequence: ["MUSIC","PODCAST"], nextBands: ["ANY","ANY"],
  }), true);
});

test("#365 UI gate: existing ANY sequence stays freely editable", () => {
  assert.equal(maySavePodcastDurationBandsWhenEditorDisabled({
    existingSequence: ["MUSIC","PODCAST"], existingBands: null,
    nextSequence: ["PODCAST","MUSIC","PODCAST"], nextBands: ["ANY","ANY","ANY"],
  }), true);
  assert.equal(maySavePodcastDurationBandsWhenEditorDisabled({
    existingSequence: ["PODCAST"], existingBands: ["ANY"],
    nextSequence: ["PODCAST","PODCAST"], nextBands: ["ANY","ANY"],
  }), true);
});

test("#365 UI gate: existing specific bands may be preserved but never rearranged", () => {
  const args = {
    existingSequence: ["PODCAST","MUSIC"],
    existingBands: ["SHORT","ANY"],
    nextSequence: ["PODCAST","MUSIC"] as const,
    nextBands: ["SHORT","ANY"] as const,
  };
  assert.equal(maySavePodcastDurationBandsWhenEditorDisabled(args),true);
  assert.equal(maySavePodcastDurationBandsWhenEditorDisabled({
    ...args, nextSequence: ["MUSIC","PODCAST"], nextBands: ["ANY","SHORT"],
  }),false);
  assert.equal(maySavePodcastDurationBandsWhenEditorDisabled({
    ...args, nextSequence: ["PODCAST","MUSIC"], nextBands: ["ANY","ANY"],
  }),false);
});

test("#365 UI gate: malformed metadata cannot bypass disabled editor protection", () => {
  assert.equal(maySavePodcastDurationBandsWhenEditorDisabled({
    existingSequence: ["PODCAST"], existingBands: ["INVALID"],
    nextSequence: ["PODCAST"], nextBands: ["ANY"],
  }), false);
});
