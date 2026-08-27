import { z } from "zod";
import type { Video } from "./schema";

// Thumbnail Lab outlier math. All functions are pure and deterministic so the
// same inputs always produce the same scores on the server and in tests.

export const labLanes = ["niche", "adjacent", "wildcard"] as const;
export const labLaneSchema = z.enum(labLanes);
export type LabLane = z.infer<typeof labLaneSchema>;

export const outlierBrackets = ["standard", "rising", "strong", "breakout"] as const;
export type OutlierBracket = (typeof outlierBrackets)[number];

export const channelBaselineSources = ["recent_uploads", "lifetime_average", "unavailable"] as const;
export const channelBaselineSourceSchema = z.enum(channelBaselineSources);
export type ChannelBaselineSource = z.infer<typeof channelBaselineSourceSchema>;

// Brackets mirror the vidIQ color bands: <2x, 2-5x, 5-10x, 10x+.
export function outlierBracket(score: number): OutlierBracket {
  if (!Number.isFinite(score) || score < 0) return "standard";
  if (score >= 10) return "breakout";
  if (score >= 5) return "strong";
  if (score >= 2) return "rising";
  return "standard";
}

export function median(values: number[]): number | null {
  const sorted = values
    .filter((value) => Number.isFinite(value) && value >= 0)
    .sort((a, b) => a - b);
  if (sorted.length === 0) return null;
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
}

// YouTube ISO 8601 durations: PT#H#M#S, with a day component for long streams.
export function parseIsoDurationSeconds(value: string | undefined): number | null {
  if (!value) return null;
  const match = /^P(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?)?$/.exec(value.trim());
  if (!match) return null;
  const [, days, hours, minutes, seconds] = match;
  if (!days && !hours && !minutes && !seconds) return null;
  return (
    Number(days || 0) * 86_400
    + Number(hours || 0) * 3_600
    + Number(minutes || 0) * 60
    + Number(seconds || 0)
  );
}

export function hoursSincePublished(publishedAt: string, nowIso: string): number | null {
  const published = Date.parse(publishedAt);
  const now = Date.parse(nowIso);
  if (!Number.isFinite(published) || !Number.isFinite(now)) return null;
  const hours = (now - published) / 3_600_000;
  return hours > 0 ? hours : null;
}

// Lifetime-average pace. The public API only exposes cumulative views, so this
// is total views over total hours, clamped to a minimum of one hour. It is a
// fair proxy for recent uploads and an understatement for old ones.
export function computeViewsPerHour(
  viewCount: number | undefined,
  publishedAt: string,
  nowIso: string,
): number | null {
  if (typeof viewCount !== "number" || !Number.isFinite(viewCount) || viewCount < 0) return null;
  const hours = hoursSincePublished(publishedAt, nowIso);
  if (hours === null) return null;
  return viewCount / Math.max(hours, 1);
}

// Outlier score follows the vidIQ definition: video views divided by the
// channel's typical views per video.
export function computeOutlierScore(
  viewCount: number | undefined,
  baselineViews: number | null | undefined,
): number | null {
  if (typeof viewCount !== "number" || !Number.isFinite(viewCount) || viewCount < 0) return null;
  if (typeof baselineViews !== "number" || !Number.isFinite(baselineViews) || baselineViews <= 0) return null;
  return viewCount / baselineViews;
}

export const labVideoScoreSchema = z.object({
  videoId: z.string().trim().min(1).max(128),
  outlierScore: z.number().nonnegative().nullable(),
  bracket: z.enum(outlierBrackets).nullable(),
  viewsPerHour: z.number().nonnegative().nullable(),
  baselineViews: z.number().nonnegative().nullable(),
  baselineSampleSize: z.number().int().nonnegative(),
  baselineSource: channelBaselineSourceSchema,
  durationSeconds: z.number().nonnegative().nullable(),
}).strict();

export type LabVideoScore = z.infer<typeof labVideoScoreSchema>;

export interface LabRankedVideo {
  video: Video;
  score: LabVideoScore;
}

export const labFiltersSchema = z.object({
  minOutlierScore: z.number().min(0).default(0),
  minViews: z.number().min(0).default(0),
  minViewsPerHour: z.number().min(0).default(0),
  maxSubscribers: z.number().min(0).nullable().default(null),
  minDurationSeconds: z.number().min(0).nullable().default(null),
  maxDurationSeconds: z.number().min(0).nullable().default(null),
  publishedWithinDays: z.number().min(1).nullable().default(null),
}).strict();

export type LabFilters = z.infer<typeof labFiltersSchema>;

export const defaultLabFilters: LabFilters = labFiltersSchema.parse({});

// Client-side smart filtering over an already-fetched lane. Missing public
// fields never zero-fill: a filter on a metric the video lacks excludes it
// only when the filter is actually active.
export function applyLabFilters(
  entries: LabRankedVideo[],
  filters: LabFilters,
  nowIso: string,
): LabRankedVideo[] {
  const now = Date.parse(nowIso);
  return entries.filter(({ video, score }) => {
    if (filters.minOutlierScore > 0) {
      if (score.outlierScore === null || score.outlierScore < filters.minOutlierScore) return false;
    }
    if (filters.minViews > 0) {
      if (typeof video.viewCount !== "number" || video.viewCount < filters.minViews) return false;
    }
    if (filters.minViewsPerHour > 0) {
      if (score.viewsPerHour === null || score.viewsPerHour < filters.minViewsPerHour) return false;
    }
    if (filters.maxSubscribers !== null) {
      const subs = video.channelStatistics?.subscriberCount;
      if (typeof subs !== "number" || subs > filters.maxSubscribers) return false;
    }
    if (filters.minDurationSeconds !== null) {
      if (score.durationSeconds === null || score.durationSeconds < filters.minDurationSeconds) return false;
    }
    if (filters.maxDurationSeconds !== null) {
      if (score.durationSeconds === null || score.durationSeconds > filters.maxDurationSeconds) return false;
    }
    if (filters.publishedWithinDays !== null) {
      const published = Date.parse(video.publishedAt);
      if (!Number.isFinite(published) || !Number.isFinite(now)) return false;
      if (now - published > filters.publishedWithinDays * 86_400_000) return false;
    }
    return true;
  });
}

export function rankByOutlierScore(entries: LabRankedVideo[]): LabRankedVideo[] {
  return [...entries].sort((a, b) => {
    const scoreA = a.score.outlierScore ?? -1;
    const scoreB = b.score.outlierScore ?? -1;
    if (scoreB !== scoreA) return scoreB - scoreA;
    return (b.video.viewCount ?? 0) - (a.video.viewCount ?? 0);
  });
}
