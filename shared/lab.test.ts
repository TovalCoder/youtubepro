import assert from "node:assert/strict";
import { describe, test } from "node:test";
import type { Video } from "./schema";
import {
  applyLabFilters,
  computeFilterFunnel,
  computeOutlierScore,
  formatAbsolutePublished,
  formatRelativePublished,
  computeViewsPerHour,
  defaultLabFilters,
  median,
  outlierBracket,
  isEnglishVideo,
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

describe("relative publication dates", () => {
  // Midday Sydney on 27 Aug 2026, clear of any day boundary.
  const NOW = "2026-08-27T02:00:00.000Z";
  const agoByDays = (days: number) =>
    formatRelativePublished(new Date(Date.parse(NOW) - days * 86_400_000).toISOString(), NOW);

  test("names today and yesterday", () => {
    assert.equal(agoByDays(0), "Today");
    assert.equal(agoByDays(1), "1 day ago");
  });

  test("counts single days up to a week", () => {
    assert.equal(agoByDays(2), "2 days ago");
    assert.equal(agoByDays(3), "3 days ago");
    assert.equal(agoByDays(6), "6 days ago");
  });

  test("switches to whole weeks at seven days", () => {
    assert.equal(agoByDays(7), "1 week ago");
    assert.equal(agoByDays(13), "1 week ago");
    assert.equal(agoByDays(14), "2 weeks ago");
    assert.equal(agoByDays(21), "3 weeks ago");
    assert.equal(agoByDays(29), "4 weeks ago");
  });

  test("switches to whole months at thirty days", () => {
    assert.equal(agoByDays(30), "1 month ago");
    assert.equal(agoByDays(59), "1 month ago");
    assert.equal(agoByDays(60), "2 months ago");
    assert.equal(agoByDays(180), "6 months ago");
  });

  test("stays relative for the whole first year", () => {
    assert.equal(agoByDays(364), "12 months ago");
  });

  test("falls back to a real date at one year", () => {
    assert.equal(agoByDays(365), "27 Aug 2025");
    assert.equal(agoByDays(400), "23 Jul 2025");
    assert.equal(agoByDays(730), "27 Aug 2024");
  });

  test("uses Sydney calendar days, not elapsed hours", () => {
    // 13:00 UTC is 23:00 Sydney the same evening; three hours later Sydney has
    // rolled over, so this reads as a day ago despite barely any time passing.
    assert.equal(
      formatRelativePublished("2026-08-26T13:00:00.000Z", "2026-08-26T16:00:00.000Z"),
      "1 day ago",
    );
    // The same pair judged in UTC has not crossed midnight.
    assert.equal(
      formatRelativePublished("2026-08-26T13:00:00.000Z", "2026-08-26T16:00:00.000Z", "UTC"),
      "Today",
    );
  });

  test("tracks the daylight-saving offset rather than a fixed +10", () => {
    // Sydney runs UTC+11 in January, so 13:30 UTC is already the next day
    // there. A fixed +10 offset would place it on the previous date.
    assert.equal(formatAbsolutePublished("2026-01-15T13:30:00.000Z"), "16 Jan 2026");
    // In August the offset is UTC+10 and the same clock time stays put.
    assert.equal(formatAbsolutePublished("2026-08-15T13:30:00.000Z"), "15 Aug 2026");
    assert.equal(formatRelativePublished("2026-01-15T13:30:00.000Z", "2026-01-16T02:00:00.000Z"), "Today");
  });

  test("reads a video published on the 25th as 2 days ago on the 27th", () => {
    // Published 09:00 Sydney on 25 Aug, read at midday Sydney on 27 Aug.
    assert.equal(formatRelativePublished("2026-08-24T23:00:00.000Z", NOW), "2 days ago");
  });

  test("counts the Sydney date, not the UTC date shown by the API", () => {
    // 22:00 UTC on 25 Aug is already 08:00 on 26 Aug in Sydney, so on the 27th
    // this is one day old even though the raw timestamp reads the 25th.
    assert.equal(formatRelativePublished("2026-08-25T22:00:00.000Z", NOW), "1 day ago");
    assert.equal(formatAbsolutePublished("2026-08-25T22:00:00.000Z"), "26 Aug 2026");
  });

  test("degrades safely on unusable or future input", () => {
    assert.equal(formatRelativePublished("not-a-date", NOW), "Unknown date");
    assert.equal(formatAbsolutePublished("nonsense"), "Unknown date");
    assert.equal(agoByDays(-9), "Scheduled");
  });
});

describe("english-only filter", () => {
  const NOW = "2026-08-27T12:00:00.000Z";
  const make = (id: string, lang?: string, audio?: string): LabRankedVideo => ({
    video: video({ id, defaultLanguage: lang, defaultAudioLanguage: audio, viewCount: 5_000 }),
    score: score({ videoId: id, outlierScore: 4, bracket: "rising" }),
  });

  const entries = [
    make("plain-en", undefined, "en"),
    make("en-us", undefined, "en-US"),
    make("en-gb", "en-GB"),
    make("hindi", undefined, "hi"),
    make("portuguese", "pt-BR"),
    make("undeclared"),
  ];

  test("accepts every English variant", () => {
    assert.ok(isEnglishVideo(video({ defaultAudioLanguage: "en" })));
    assert.ok(isEnglishVideo(video({ defaultAudioLanguage: "en-US" })));
    assert.ok(isEnglishVideo(video({ defaultLanguage: "EN-gb" })));
  });

  test("rejects other languages and undeclared videos", () => {
    assert.equal(isEnglishVideo(video({ defaultAudioLanguage: "hi" })), false);
    assert.equal(isEnglishVideo(video({ defaultLanguage: "pt-BR" })), false);
    assert.equal(isEnglishVideo(video({})), false);
  });

  test("prefers the spoken language over the metadata language", () => {
    // A video captioned in English but spoken in Hindi is not an English video.
    assert.equal(isEnglishVideo(video({ defaultLanguage: "en", defaultAudioLanguage: "hi" })), false);
  });

  test("filters a lane down to English when enabled", () => {
    const off = applyLabFilters(entries, defaultLabFilters, NOW);
    assert.equal(off.length, 6);
    const on = applyLabFilters(entries, { ...defaultLabFilters, englishOnly: true }, NOW);
    assert.deepEqual(on.map((entry) => entry.video.id), ["plain-en", "en-us", "en-gb"]);
  });
});

describe("filter funnel", () => {
  const NOW = "2026-08-27T12:00:00.000Z";
  const entries: LabRankedVideo[] = [
    {
      video: video({ id: "tiny", viewCount: 20_000, channelStatistics: { hiddenSubscriberCount: false, subscriberCount: 900 } }),
      score: score({ videoId: "tiny", outlierScore: 8 }),
    },
    {
      video: video({ id: "mid", viewCount: 50_000, channelStatistics: { hiddenSubscriberCount: false, subscriberCount: 90_000 } }),
      score: score({ videoId: "mid", outlierScore: 6 }),
    },
    {
      video: video({ id: "big", viewCount: 90_000, channelStatistics: { hiddenSubscriberCount: false, subscriberCount: 900_000 } }),
      score: score({ videoId: "big", outlierScore: 5 }),
    },
  ];

  test("reports only the filters actually in use", () => {
    const rows = computeFilterFunnel(entries, { ...defaultLabFilters, minOutlierScore: 4 }, NOW);
    assert.deepEqual(rows.map((row) => row.key), ["minOutlierScore"]);
  });

  test("scores each filter independently, exposing the tightest one", () => {
    const rows = computeFilterFunnel(
      entries,
      { ...defaultLabFilters, minOutlierScore: 4, minViews: 10_000, maxSubscribers: 1_000 },
      NOW,
    );
    const byKey = Object.fromEntries(rows.map((row) => [row.key, row.passing]));
    assert.equal(byKey.minOutlierScore, 3);
    assert.equal(byKey.minViews, 3);
    // The subscriber ceiling is the binding constraint, admitting one video.
    assert.equal(byKey.maxSubscribers, 1);
    const tightest = rows.reduce((worst, row) => (row.passing < worst.passing ? row : worst));
    assert.equal(tightest.key, "maxSubscribers");
  });

  test("returns nothing when no filter is active", () => {
    assert.deepEqual(computeFilterFunnel(entries, defaultLabFilters, NOW), []);
  });
});
