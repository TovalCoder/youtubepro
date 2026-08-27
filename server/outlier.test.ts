import assert from "node:assert/strict";
import { describe, test } from "node:test";
import type { Video } from "@shared/schema";
import { scoreVideoAgainstBaseline, uploadsPlaylistIdFor } from "./outlier";
import { isAllowedThumbnailUrl } from "./thumbnail-lab";

const NOW = "2026-08-27T12:00:00.000Z";

function video(overrides: Partial<Video>): Video {
  return {
    id: "target",
    title: "A video",
    channelTitle: "Small channel",
    channelId: "UCsmall",
    publishedAt: "2026-08-20T12:00:00.000Z",
    thumbnailUrl: "https://i.ytimg.com/vi/target/hqdefault.jpg",
    description: "",
    ...overrides,
  };
}

describe("uploads playlist derivation", () => {
  test("maps a UC channel id to its UU uploads playlist", () => {
    assert.equal(uploadsPlaylistIdFor("UCabc123"), "UUabc123");
  });

  test("rejects ids that are not channel ids", () => {
    assert.equal(uploadsPlaylistIdFor("PLabc"), null);
    assert.equal(uploadsPlaylistIdFor("UC"), null);
    assert.equal(uploadsPlaylistIdFor(""), null);
  });
});

describe("baseline scoring", () => {
  const sample = [
    { videoId: "a", viewCount: 900 },
    { videoId: "b", viewCount: 1_000 },
    { videoId: "c", viewCount: 1_100 },
    { videoId: "d", viewCount: 1_200 },
  ];

  test("uses the recent-uploads median when available", () => {
    const score = scoreVideoAgainstBaseline(
      video({ viewCount: 21_000 }),
      { source: "recent_uploads", sample },
      NOW,
    );
    assert.equal(score.baselineSource, "recent_uploads");
    assert.equal(score.baselineViews, 1_050);
    assert.equal(score.outlierScore, 20);
    assert.equal(score.bracket, "breakout");
    assert.equal(score.baselineSampleSize, 4);
  });

  test("excludes the video from its own baseline", () => {
    const withSelf = [...sample, { videoId: "target", viewCount: 500_000 }];
    const score = scoreVideoAgainstBaseline(video({ viewCount: 500_000 }), { source: "recent_uploads", sample: withSelf }, NOW);
    // Median of the other four is 1050, not dragged up by the breakout itself.
    assert.equal(score.baselineViews, 1_050);
    assert.equal(score.baselineSampleSize, 4);
  });

  test("falls back to the lifetime average when uploads are unavailable", () => {
    const score = scoreVideoAgainstBaseline(
      video({
        viewCount: 10_000,
        channelStatistics: { hiddenSubscriberCount: false, viewCount: 100_000, videoCount: 50 },
      }),
      { source: "lifetime_average", sample: [] },
      NOW,
    );
    assert.equal(score.baselineSource, "lifetime_average");
    assert.equal(score.baselineViews, 2_000);
    assert.equal(score.outlierScore, 5);
    assert.equal(score.bracket, "strong");
  });

  test("reports unavailable rather than inventing a baseline", () => {
    const score = scoreVideoAgainstBaseline(video({ viewCount: 10_000 }), { source: "lifetime_average", sample: [] }, NOW);
    assert.equal(score.baselineSource, "unavailable");
    assert.equal(score.outlierScore, null);
    assert.equal(score.bracket, null);
  });

  test("still computes views per hour without a baseline", () => {
    const score = scoreVideoAgainstBaseline(video({ viewCount: 16_800 }), { source: "lifetime_average", sample: [] }, NOW);
    assert.equal(score.viewsPerHour, 100);
  });
});

describe("thumbnail fetch allowlist", () => {
  test("allows YouTube-hosted thumbnail origins over https", () => {
    assert.ok(isAllowedThumbnailUrl("https://i.ytimg.com/vi/abc/hqdefault.jpg"));
    assert.ok(isAllowedThumbnailUrl("https://img.youtube.com/vi/abc/hqdefault.jpg"));
  });

  test("rejects other hosts, plaintext http, and malformed urls", () => {
    assert.equal(isAllowedThumbnailUrl("https://evil.example.com/a.jpg"), false);
    assert.equal(isAllowedThumbnailUrl("http://i.ytimg.com/vi/abc/hqdefault.jpg"), false);
    assert.equal(isAllowedThumbnailUrl("not-a-url"), false);
    assert.equal(isAllowedThumbnailUrl("file:///etc/passwd"), false);
  });
});
