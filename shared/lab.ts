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
  englishOnly: z.boolean().default(false),
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
    if (filters.englishOnly && !isEnglishVideo(video)) return false;
    return true;
  });
}

// YouTube only reports a language when the uploader set one. When the creator
// asks for English only, an undeclared video cannot be confirmed English, so it
// is excluded rather than guessed at.
export function isEnglishVideo(video: Video): boolean {
  const declared = video.defaultAudioLanguage || video.defaultLanguage;
  return typeof declared === "string" && declared.toLowerCase().startsWith("en");
}

export interface LabFilterFunnelRow {
  key: string;
  label: string;
  active: boolean;
  passing: number;
}

// How many fetched videos each active filter admits on its own. Tight filter
// sets can collapse to nothing, and this shows which one is responsible
// instead of leaving the creator to guess.
export function computeFilterFunnel(
  entries: LabRankedVideo[],
  filters: LabFilters,
  nowIso: string,
): LabFilterFunnelRow[] {
  const only = (patch: Partial<LabFilters>) =>
    applyLabFilters(entries, { ...defaultLabFilters, ...patch }, nowIso).length;

  const rows: LabFilterFunnelRow[] = [
    { key: "minOutlierScore", label: "Min outlier", active: filters.minOutlierScore > 0, passing: only({ minOutlierScore: filters.minOutlierScore }) },
    { key: "minViews", label: "Min views", active: filters.minViews > 0, passing: only({ minViews: filters.minViews }) },
    { key: "minViewsPerHour", label: "Min VPH", active: filters.minViewsPerHour > 0, passing: only({ minViewsPerHour: filters.minViewsPerHour }) },
    { key: "maxSubscribers", label: "Max subs", active: filters.maxSubscribers !== null, passing: only({ maxSubscribers: filters.maxSubscribers }) },
    { key: "minDurationSeconds", label: "Min length", active: filters.minDurationSeconds !== null, passing: only({ minDurationSeconds: filters.minDurationSeconds }) },
    { key: "maxDurationSeconds", label: "Max length", active: filters.maxDurationSeconds !== null, passing: only({ maxDurationSeconds: filters.maxDurationSeconds }) },
    { key: "publishedWithinDays", label: "Within days", active: filters.publishedWithinDays !== null, passing: only({ publishedWithinDays: filters.publishedWithinDays }) },
    { key: "englishOnly", label: "English only", active: filters.englishOnly, passing: only({ englishOnly: filters.englishOnly }) },
  ];
  return rows.filter((row) => row.active);
}

export function rankByOutlierScore(entries: LabRankedVideo[]): LabRankedVideo[] {
  return [...entries].sort((a, b) => {
    const scoreA = a.score.outlierScore ?? -1;
    const scoreB = b.score.outlierScore ?? -1;
    if (scoreB !== scoreA) return scoreB - scoreA;
    return (b.video.viewCount ?? 0) - (a.video.viewCount ?? 0);
  });
}

// Publication recency is read at a glance, so it is expressed relative to the
// creator's own calendar rather than as an ISO date. Day boundaries are
// computed in their time zone: a video published late yesterday evening reads
// as "1 day ago" even when fewer than 24 hours have passed.
//
// Australia/Sydney rather than a fixed +10 offset, so the New South Wales
// daylight-saving switch is handled instead of silently shifting every date by
// an hour for half the year.
export const LAB_TIME_ZONE = "Australia/Sydney";

// Days since the Unix epoch for the calendar date this instant falls on in the
// given zone. Differencing these counts calendar days, not 24-hour spans.
function calendarDayInZone(iso: string, timeZone: string): number | null {
  const ms = Date.parse(iso);
  if (!Number.isFinite(ms)) return null;
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(new Date(ms));
  const valueOf = (type: string) => Number(parts.find((part) => part.type === type)?.value);
  const year = valueOf("year");
  const month = valueOf("month");
  const day = valueOf("day");
  if (!Number.isFinite(year) || !Number.isFinite(month) || !Number.isFinite(day)) return null;
  return Math.floor(Date.UTC(year, month - 1, day) / 86_400_000);
}

export function formatAbsolutePublished(publishedAt: string, timeZone: string = LAB_TIME_ZONE): string {
  const ms = Date.parse(publishedAt);
  if (!Number.isFinite(ms)) return "Unknown date";
  return new Intl.DateTimeFormat("en-GB", {
    timeZone,
    day: "numeric",
    month: "short",
    year: "numeric",
  }).format(new Date(ms));
}

// Days up to a week, weeks up to a month, months up to a year, then the
// actual date. Anything inside a year stays relative so recency is readable
// without doing arithmetic.
export function formatRelativePublished(
  publishedAt: string,
  nowIso: string,
  timeZone: string = LAB_TIME_ZONE,
): string {
  const publishedDay = calendarDayInZone(publishedAt, timeZone);
  const today = calendarDayInZone(nowIso, timeZone);
  if (publishedDay === null || today === null) return "Unknown date";

  const days = today - publishedDay;
  if (days < 0) return "Scheduled";
  if (days === 0) return "Today";
  if (days === 1) return "1 day ago";
  if (days < 7) return `${days} days ago`;
  if (days < 30) {
    const weeks = Math.floor(days / 7);
    return weeks === 1 ? "1 week ago" : `${weeks} weeks ago`;
  }
  if (days < 365) {
    const months = Math.floor(days / 30);
    return months === 1 ? "1 month ago" : `${months} months ago`;
  }
  return formatAbsolutePublished(publishedAt, timeZone);
}
