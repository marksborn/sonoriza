#!/usr/bin/env node
/**
 * YTM-01: isolated, opt-in YouTube Data API playlist probe.
 * No integration with Sonoriza runtime or production OAuth.
 * Node >=20. No dependencies. Read-only by default.
 */
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const YOUTUBE_API = "https://www.googleapis.com/youtube/v3";
const DAILY_GENERAL_QUOTA = 10_000;
const WRITE_COST = 50;

function nonnegativeInteger(value, name) {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0) {
    throw new Error(name + " must be a non-negative integer");
  }
  return parsed;
}

export function estimateQuota({
  creates = 0,
  adds = 0,
  removes = 0,
  moves = 0,
  reads = 0,
} = {}) {
  const counts = {
    creates: nonnegativeInteger(creates, "creates"),
    adds: nonnegativeInteger(adds, "adds"),
    removes: nonnegativeInteger(removes, "removes"),
    moves: nonnegativeInteger(moves, "moves"),
    reads: nonnegativeInteger(reads, "reads"),
  };
  const writeUnits = WRITE_COST * (counts.creates + counts.adds + counts.removes + counts.moves);
  const totalUnits = writeUnits + counts.reads;
  return {
    ...counts,
    writeUnits,
    totalUnits,
    defaultGeneralQuota: DAILY_GENERAL_QUOTA,
    exceedsDefaultGeneralQuota: totalUnits > DAILY_GENERAL_QUOTA,
    // Only a per-operation illustration. The live Google Cloud quota is authoritative.
    note: "Does not include other API calls or the separate search.list bucket.",
  };
}

function playlistIdOrThrow(value) {
  if (typeof value !== "string" || !/^[A-Za-z0-9_-]{6,}$/.test(value)) {
    throw new Error("Invalid YouTube playlist ID");
  }
  return value;
}

export function playlistLinks(playlistId) {
  const id = encodeURIComponent(playlistIdOrThrow(playlistId));
  return {
    youtube: "https://www.youtube.com/playlist?list=" + id,
    youtubeMusic: "https://music.youtube.com/playlist?list=" + id,
  };
}

export function summarizeItems(items = []) {
  return items.map((item, index) => {
    const snippet = item?.snippet ?? {};
    return {
      playlistItemId: item?.id ?? null,
      videoId: snippet.resourceId?.videoId ?? item?.contentDetails?.videoId ?? null,
      position: Number.isInteger(snippet.position) ? snippet.position : index,
      title: snippet.title ?? null,
      videoOwnerChannelId: snippet.videoOwnerChannelId ?? null,
      youtubeMusicVisibility: "NOT_VERIFIED",
      playbackEligibility: "NOT_VERIFIED",
    };
  });
}

function parseOptions(argv) {
  const options = {};
  for (let i = 0; i < argv.length; i += 1) {
    const part = argv[i];
    if (!part.startsWith("--")) throw new Error("Unexpected argument " + part);
    const key = part.slice(2);
    if (key === "execute") {
      options.execute = true;
      continue;
    }
    if (!argv[i + 1] || argv[i + 1].startsWith("--")) {
      throw new Error("Missing value for " + part);
    }
    if (options[key] !== undefined) throw new Error("Repeated argument " + part);
    options[key] = argv[++i];
  }
  return options;
}

function accessToken() {
  const token = process.env.YT_POC_ACCESS_TOKEN?.trim();
  if (!token) throw new Error("Set YT_POC_ACCESS_TOKEN in your local shell; never commit or paste it.");
  return token;
}

async function youtubeRequest(path, params, token, method = "GET", body = null) {
  const url = new URL(YOUTUBE_API + path);
  for (const [key, value] of Object.entries(params)) url.searchParams.set(key, String(value));
  const response = await fetch(url, {
    method,
    headers: {
      Authorization: "Bearer " + token,
      Accept: "application/json",
      ...(body === null ? {} : { "Content-Type": "application/json" }),
    },
    ...(body === null ? {} : { body: JSON.stringify(body) }),
  });
  if (!response.ok) {
    // Do not echo response bodies, request headers, or OAuth credentials.
    throw new Error("YouTube Data API returned HTTP " + response.status + " during " + method + " " + path);
  }
  return response.json();
}

async function collectPages(path, params, token, maxItems) {
  const items = [];
  let pageToken;
  let requests = 0;
  do {
    const page = await youtubeRequest(path, {
      ...params,
      maxResults: Math.min(50, maxItems - items.length),
      ...(pageToken ? { pageToken } : {}),
    }, token);
    requests += 1;
    items.push(...(page.items ?? []));
    pageToken = page.nextPageToken;
  } while (pageToken && items.length < maxItems);
  return { items, requests, truncated: Boolean(pageToken) };
}

function output(data) {
  process.stdout.write(JSON.stringify(data, null, 2) + "\n");
}

function sampleVideoIds(value) {
  const ids = (value ?? "").split(",").map((x) => x.trim()).filter(Boolean);
  if (ids.length < 1 || ids.length > 10) throw new Error("Supply 1 to 10 comma-separated video IDs");
  if (ids.some((id) => !/^[A-Za-z0-9_-]{11}$/.test(id))) throw new Error("Invalid video ID");
  return ids;
}

export async function run(argv = process.argv.slice(2)) {
  const [command, ...rest] = argv;
  const args = parseOptions(rest);
  if (command === "quota") {
    return output(estimateQuota({
      creates: args.creates ?? 0,
      adds: args.adds ?? 0,
      removes: args.removes ?? 0,
      moves: args.moves ?? 0,
      reads: args.reads ?? 0,
    }));
  }
  if (command === "links") return output(playlistLinks(args["playlist-id"]));

  if (command === "mine") {
    const token = accessToken();
    const maxItems = nonnegativeInteger(args["max-items"] ?? 100, "max-items");
    if (maxItems < 1 || maxItems > 500) throw new Error("max-items must be 1 to 500");
    const result = await collectPages("/playlists", {
      part: "snippet,status,contentDetails",
      mine: true,
    }, token, maxItems);
    return output({
      operation: "READ_ONLY",
      pagesRead: result.requests,
      truncated: result.truncated,
      playlists: result.items.map((x) => ({
        id: x.id,
        title: x.snippet?.title ?? null,
        privacyStatus: x.status?.privacyStatus ?? null,
        links: playlistLinks(x.id),
      })),
    });
  }

  if (command === "inspect") {
    const id = playlistIdOrThrow(args["playlist-id"]);
    const token = accessToken();
    const maxItems = nonnegativeInteger(args["max-items"] ?? 100, "max-items");
    if (maxItems < 1 || maxItems > 500) throw new Error("max-items must be 1 to 500");
    const meta = await youtubeRequest("/playlists", {
      part: "snippet,status,contentDetails",
      id,
    }, token);
    const details = meta.items?.[0];
    if (!details) throw new Error("Playlist not visible to the authorized YouTube account");
    const result = await collectPages("/playlistItems", {
      part: "snippet,contentDetails,status",
      playlistId: id,
    }, token, maxItems);
    return output({
      operation: "READ_ONLY",
      playlistId: id,
      title: details.snippet?.title ?? null,
      privacyStatus: details.status?.privacyStatus ?? null,
      declaredItemCount: details.contentDetails?.itemCount ?? null,
      pagesRead: result.requests + 1,
      truncated: result.truncated,
      links: playlistLinks(id),
      warning: "The YouTube API does NOT prove YouTube Music visibility, podcast eligibility, or playback order. Check both apps manually.",
      items: summarizeItems(result.items),
    });
  }

  if (command === "create-test") {
    const title = args.title?.trim();
    if (!title || title.length > 100) throw new Error("Provide --title of 1 to 100 characters");
    const videos = sampleVideoIds(args.videos);
    const quota = estimateQuota({ creates: 1, adds: videos.length });
    if (!args.execute) return output({
      operation: "DRY_RUN",
      playlistPrivacy: "private",
      title,
      videos,
      quota,
      instruction: "To write to your own TEST YouTube account, supply --execute and set YT_POC_ALLOW_WRITES=YES_PRIVATE_TEST.",
    });
    if (process.env.YT_POC_ALLOW_WRITES !== "YES_PRIVATE_TEST") {
      throw new Error("Writes blocked: YT_POC_ALLOW_WRITES must be YES_PRIVATE_TEST");
    }
    const token = accessToken();
    const created = await youtubeRequest("/playlists", { part: "snippet,status" }, token, "POST", {
      snippet: { title, description: "Sonoriza YTM-01 private integration experiment; safe to delete manually" },
      status: { privacyStatus: "private" },
    });
    const id = playlistIdOrThrow(created.id);
    // Emit the new ID immediately: partial inserts must not make it untraceable.
    output({ event: "TEST_PLAYLIST_CREATED", playlistId: id, privacyStatus: "private", links: playlistLinks(id) });
    for (const [position, videoId] of videos.entries()) {
      await youtubeRequest("/playlistItems", { part: "snippet" }, token, "POST", {
        snippet: {
          playlistId: id,
          position,
          resourceId: { kind: "youtube#video", videoId },
        },
      });
      output({ event: "TEST_VIDEO_ADDED", playlistId: id, position, videoId });
    }
    return output({ event: "TEST_COMPLETE", playlistId: id, quotaEstimated: quota.totalUnits });
  }

  throw new Error("Commands: quota, links, mine, inspect, create-test. See docs/YOUTUBE-MUSIC-POC.md");
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  run().catch((error) => {
    process.stderr.write("YTM-01 PoC: " + error.message + "\n");
    process.exitCode = 1;
  });
}
