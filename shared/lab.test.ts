import assert from "node:assert/strict";
import { describe, test } from "node:test";
import type { Video } from "./schema";
import {
  applyLabFilters,
  computeOutlierScore,
  computeViewsPerHour,
  defaultLabFilters,
  median,
  outlierBracket,
  parseIsoDurationSeconds,
  rankByOutlierScore,
  type LabRankedVideo,
  type LabVideoScore,
} from "./lab";

const NOW = "2026-08-27T12:00:00.000Z";

function video(overrides: Partial<Video>): Video {
  return {
    id: "vid-1",
    title: "A test video",
    channelTitle: "A channel",
    channelId: "UCabc",
    publishedAt: "2026-08-20T12:00:00.000Z",
    thumbnailUrl: "https://i.ytimg.com/vi/vid-1/hqdefault.jpg",
    description: "",
    ...overrides,
  };
}

function score(overrides: Partial<LabVideoScore>): LabVideoScore {
  return {
    videoId: "vid-1",
    outlierScore: null,
    bracket: null,
    viewsPerHour: null,
    baselineViews: null,
    baselineSampleSize: 0,
    baselineSource: "unavailable",
    durationSeconds: null,
    ...overrides,
  };
}

describe("outlier math", () => {
  test("computes the vidIQ-style multiplier", () => {
    assert.equal(computeOutlierScore(10_000, 1_000), 10);
    assert.equal(computeOutlierScore(500, 1_000), 0.5);
  });

  test("returns null instead of zero-filling missing data", () => {
    assert.equal(computeOutlierScore(undefined, 1_000), null);
    assert.equal(computeOutlierScore(10_000, null), null);
    assert.equal(computeOutlierScore(10_000, 0), null);
    assert.equal(computeOutlierScore(-5, 1_000), null);
  });

  test("brackets mirror the vidIQ bands", () => {
    assert.equal(outlierBracket(1.9), "standard");
    assert.equal(outlierBracket(2), "rising");
    assert.equal(outlierBracket(5), "strong");
    assert.equal(outlierBracket(10), "breakout");
    assert.equal(outlierBracket(42), "breakout");
  });

  test("median resists a single viral skew", () => {
    assert.equal(median([100, 120, 90, 110, 1_000_000]), 110);
    assert.equal(median([4, 8]), 6);
    assert.equal(median([]), null);
    assert.equal(median([Number.NaN, -3]), null);
  });

  test("views per hour uses hours since publish with a one-hour floor", () => {
    const sevenDays = computeViewsPerHour(16_800, "2026-08-20T12:00:00.000Z", NOW);
    assert.equal(sevenDays, 100);
    const justPublished = computeViewsPerHour(500, "2026-08-27T11:45:00.000Z", NOW);
    assert.equal(justPublished, 500);
    assert.equal(computeViewsPerHour(undefined, "2026-08-20T12:00:00.000Z", NOW), null);
    assert.equal(computeViewsPerHour(100, "not-a-date", NOW), null);
  });

  test("parses ISO 8601 durations including day components", () => {
    assert.equal(parseIsoDurationSeconds("PT10M10S"), 610);
    assert.equal(parseIsoDurationSeconds("PT1H2M3S"), 3_723);
    assert.equal(parseIsoDurationSeconds("P1DT2H"), 93_600);
    assert.equal(parseIsoDurationSeconds("PT58M17S"), 3_497);
    assert.equal(parseIsoDurationSeconds("nonsense"), null);
    assert.equal(parseIsoDurationSeconds(undefined), null);
  });
});

describe("lab smart filters", () => {
  const entries: LabRankedVideo[] = [
    {
      video: video({
        id: "small-outlier",
        viewCount: 23_000,
        channelStatistics: { hiddenSubscriberCount: false, subscriberCount: 900 },
      }),
      score: score({ videoId: "small-outlier", outlierScore: 42, bracket: "breakout", viewsPerHour: 89, durationSeconds: 3_497 }),
    },
    {
      video: video({
        id: "big-channel",
        viewCount: 28_000,
        channelStatistics: { hiddenSubscriberCount: false, subscriberCount: 2_290_000 },
      }),
      score: score({ videoId: "big-channel", outlierScore: 2, bracket: "rising", viewsPerHour: 118, durationSeconds: 621 }),
    },
    {
      video: video({ id: "no-data" }),
      score: score({ videoId: "no-data" }),
    },
  ];

  test("default filters keep everything", () => {
    assert.equal(applyLabFilters(entries, defaultLabFilters, NOW).length, 3);
  });

  test("subscriber ceiling isolates small channels", () => {
    const filtered = applyLabFilters(entries, { ...defaultLabFilters, maxSubscribers: 10_000 }, NOW);
    assert.deepEqual(filtered.map((entry) => entry.video.id), ["small-outlier"]);
  });

  test("outlier floor excludes unscored videos only when active", () => {
    const filtered = applyLabFilters(entries, { ...defaultLabFilters, minOutlierScore: 10 }, NOW);
    assert.deepEqual(filtered.map((entry) => entry.video.id), ["small-outlier"]);
    const inactive = applyLabFilters(entries, defaultLabFilters, NOW);
    assert.ok(inactive.some((entry) => entry.video.id === "no-data"));
  });

  test("duration and recency windows apply together", () => {
    const filtered = applyLabFilters(
      entries,
      { ...defaultLabFilters, minDurationSeconds: 600, maxDurationSeconds: 700, publishedWithinDays: 30 },
      NOW,
    );
    assert.deepEqual(filtered.map((entry) => entry.video.id), ["big-channel"]);
  });

  test("ranking puts the highest multiplier first and unscored last", () => {
    const ranked = rankByOutlierScore(entries);
    assert.deepEqual(ranked.map((entry) => entry.video.id), ["small-outlier", "big-channel", "no-data"]);
  });
});
