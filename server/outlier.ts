import type { Video } from "@shared/schema";
import {
  computeOutlierScore,
  computeViewsPerHour,
  median,
  outlierBracket,
  parseIsoDurationSeconds,
  type ChannelBaselineSource,
  type LabVideoScore,
} from "@shared/lab";
import { fetchYouTubeJson } from "./youtube";

const BASE_URL = "https://www.googleapis.com/youtube/v3";

// Precise-everywhere scoring: every channel in a lane gets a baseline built
// from its recent uploads (2 quota units per channel). Baselines are cached
// per process so re-filtering and overlapping lanes cost nothing extra.
const BASELINE_TTL_MS = 6 * 60 * 60 * 1_000;
const BASELINE_FETCH_CONCURRENCY = 6;
const BASELINE_SAMPLE_TARGET = 20;
// Shorts drag a long-form channel's median toward noise, so the sample
// prefers uploads of at least three minutes when enough exist.
const LONG_FORM_MIN_SECONDS = 180;
const MIN_LONG_FORM_SAMPLE = 5;
const MIN_RECENT_SAMPLE = 3;

interface BaselineSampleVideo {
  videoId: string;
  viewCount: number;
}

interface ChannelBaselineRecord {
  channelId: string;
  source: ChannelBaselineSource;
  sample: BaselineSampleVideo[];
  expiresAt: number;
}

const baselineCache = new Map<string, ChannelBaselineRecord>();

export function clearBaselineCacheForTests(): void {
  baselineCache.clear();
}

// Every channel ID beginning UC has an uploads playlist at UU + the same
// suffix. Deriving it saves one channels.list call per channel.
export function uploadsPlaylistIdFor(channelId: string): string | null {
  if (!channelId.startsWith("UC") || channelId.length <= 2) return null;
  return `UU${channelId.slice(2)}`;
}

async function fetchRecentUploadSample(channelId: string, apiKey: string): Promise<BaselineSampleVideo[] | null> {
  const playlistId = uploadsPlaylistIdFor(channelId);
  if (!playlistId) return null;

  const playlistParams = new URLSearchParams({
    part: "contentDetails",
    playlistId,
    maxResults: "50",
    key: apiKey,
  });
  const playlistData = await fetchYouTubeJson(
    `${BASE_URL}/playlistItems?${playlistParams}`,
    "channel baseline uploads",
  );
  const videoIds = (Array.isArray(playlistData.items) ? playlistData.items : [])
    .map((item: any) => item?.contentDetails?.videoId)
    .filter((id: unknown): id is string => typeof id === "string" && id.length > 0);
  if (videoIds.length === 0) return null;

  const videosParams = new URLSearchParams({
    part: "statistics,contentDetails",
    id: videoIds.join(","),
    maxResults: "50",
    key: apiKey,
  });
  const videosData = await fetchYouTubeJson(
    `${BASE_URL}/videos?${videosParams}`,
    "channel baseline statistics",
  );

  const uploads: Array<BaselineSampleVideo & { durationSeconds: number | null }> = [];
  for (const item of Array.isArray(videosData.items) ? videosData.items : []) {
    const viewCount = Number(item?.statistics?.viewCount);
    if (typeof item?.id !== "string" || !Number.isFinite(viewCount)) continue;
    uploads.push({
      videoId: item.id,
      viewCount,
      durationSeconds: parseIsoDurationSeconds(item?.contentDetails?.duration),
    });
  }
  if (uploads.length === 0) return null;

  const longForm = uploads.filter(
    (upload) => upload.durationSeconds !== null && upload.durationSeconds >= LONG_FORM_MIN_SECONDS,
  );
  const pool = longForm.length >= MIN_LONG_FORM_SAMPLE ? longForm : uploads;
  return pool.slice(0, BASELINE_SAMPLE_TARGET).map(({ videoId, viewCount }) => ({ videoId, viewCount }));
}

async function getChannelBaseline(channelId: string, apiKey: string): Promise<ChannelBaselineRecord> {
  const cached = baselineCache.get(channelId);
  if (cached && cached.expiresAt > Date.now()) return cached;

  let record: ChannelBaselineRecord;
  try {
    const sample = await fetchRecentUploadSample(channelId, apiKey);
    record = sample && sample.length >= MIN_RECENT_SAMPLE
      ? { channelId, source: "recent_uploads", sample, expiresAt: Date.now() + BASELINE_TTL_MS }
      : { channelId, source: "lifetime_average", sample: sample ?? [], expiresAt: Date.now() + BASELINE_TTL_MS };
  } catch {
    // A channel whose uploads cannot be listed (terminated, empty, or a
    // transient error) falls back to its lifetime average, never a zero.
    record = { channelId, source: "lifetime_average", sample: [], expiresAt: Date.now() + BASELINE_TTL_MS };
  }
  baselineCache.set(channelId, record);
  return record;
}

async function mapWithConcurrency<T, R>(
  items: T[],
  limit: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const index = next++;
      results[index] = await fn(items[index]);
    }
  });
  await Promise.all(workers);
  return results;
}

function lifetimeAverageFor(video: Video): number | null {
  const totalViews = video.channelStatistics?.viewCount;
  const videoCount = video.channelStatistics?.videoCount;
  if (typeof totalViews !== "number" || typeof videoCount !== "number" || videoCount <= 0) return null;
  return totalViews / videoCount;
}

export function scoreVideoAgainstBaseline(
  video: Video,
  baseline: Pick<ChannelBaselineRecord, "source" | "sample">,
  nowIso: string,
): LabVideoScore {
  // A video never counts toward its own baseline; that would let a breakout
  // video inflate the median it is judged against.
  const sampleWithoutSelf = baseline.sample.filter((entry) => entry.videoId !== video.id);
  const recentMedian = median(sampleWithoutSelf.map((entry) => entry.viewCount));

  let baselineViews: number | null = null;
  let baselineSource: ChannelBaselineSource = "unavailable";
  let baselineSampleSize = 0;
  if (baseline.source === "recent_uploads" && recentMedian !== null && sampleWithoutSelf.length >= MIN_RECENT_SAMPLE - 1) {
    baselineViews = recentMedian;
    baselineSource = "recent_uploads";
    baselineSampleSize = sampleWithoutSelf.length;
  } else {
    const lifetime = lifetimeAverageFor(video);
    if (lifetime !== null) {
      baselineViews = lifetime;
      baselineSource = "lifetime_average";
    }
  }

  const score = computeOutlierScore(video.viewCount, baselineViews);
  return {
    videoId: video.id,
    outlierScore: score,
    bracket: score === null ? null : outlierBracket(score),
    viewsPerHour: computeViewsPerHour(video.viewCount, video.publishedAt, nowIso),
    baselineViews,
    baselineSampleSize,
    baselineSource: baselineViews === null ? "unavailable" : baselineSource,
    durationSeconds: parseIsoDurationSeconds(video.duration),
  };
}

export async function scoreVideosForLab(videos: Video[]): Promise<LabVideoScore[]> {
  const apiKey = process.env.YOUTUBE_API_KEY?.trim();
  const nowIso = new Date().toISOString();

  if (!apiKey || videos.length === 0) {
    return videos.map((video) => scoreVideoAgainstBaseline(video, { source: "lifetime_average", sample: [] }, nowIso));
  }

  const channelIds = Array.from(new Set(videos.map((video) => video.channelId)));
  const baselines = await mapWithConcurrency(channelIds, BASELINE_FETCH_CONCURRENCY, (channelId) =>
    getChannelBaseline(channelId, apiKey),
  );
  const baselineByChannel = new Map(baselines.map((record) => [record.channelId, record]));

  return videos.map((video) => {
    const baseline = baselineByChannel.get(video.channelId) ?? { source: "lifetime_average" as const, sample: [] };
    return scoreVideoAgainstBaseline(video, baseline, nowIso);
  });
}
