import { useEffect, useMemo, useState } from "react";
import { Accordion, AccordionContent, AccordionItem, AccordionTrigger } from "@/components/ui/accordion";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Separator } from "@/components/ui/separator";
import { Textarea } from "@/components/ui/textarea";
import {
  AlertCircle,
  Copy,
  Download,
  FlaskConical,
  FolderOpen,
  Lightbulb,
  Loader2,
  RefreshCw,
  Search,
  Sparkles,
  Star,
  Wand2,
  X,
} from "lucide-react";
import type { Video } from "@shared/schema";
import {
  applyLabFilters,
  computeFilterFunnel,
  defaultLabFilters,
  formatAbsolutePublished,
  formatRelativePublished,
  rankByOutlierScore,
  topicMatchTerms,
  type LabFilterFunnelRow,
  type LabFilters,
  type LabLane,
  type LabRankedVideo,
  type LabVideoScore,
} from "@shared/lab";

// Thumbnail Lab: outlier research lanes, reference pattern analysis, and
// title-plus-thumbnail packaging generation. Deliberately separate from the
// legacy Thumbnail Creator and free of its packaging-integrity constraints.

const MAX_INPUT_IMAGE_BYTES = 10 * 1024 * 1024;
const MAX_GENERATION_IMAGE_BYTES = 5 * 1024 * 1024;
const MAX_TRAY = 12;

interface RequestFailure {
  error: string;
  suggestion: string;
}

async function postJson<T>(path: string, body: unknown): Promise<T> {
  const response = await fetch(path, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    const failure: RequestFailure = {
      error: payload.error || `Request failed with status ${response.status}`,
      suggestion: payload.suggestion || "Retry once. If this continues, review Settings and server logs.",
    };
    throw failure;
  }
  return payload as T;
}

function failureFrom(error: unknown): RequestFailure {
  if (error && typeof error === "object" && "error" in error) return error as RequestFailure;
  return { error: "The request could not be completed.", suggestion: "Check that the local server is running and retry." };
}

function readFileAsDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(new Error("The selected file could not be read."));
    reader.readAsDataURL(file);
  });
}

function loadImage(dataUrl: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const image = new window.Image();
    image.onload = () => resolve(image);
    image.onerror = () => reject(new Error("The selected file could not be decoded as an image."));
    image.src = dataUrl;
  });
}

async function prepareReferenceImage(file: File): Promise<string> {
  if (file.type !== "image/png" && file.type !== "image/jpeg") throw new Error("Choose a PNG or JPEG image.");
  if (file.size > MAX_INPUT_IMAGE_BYTES) throw new Error("Choose an image smaller than 10 MB.");
  const original = await readFileAsDataUrl(file);
  const image = await loadImage(original);
  if (image.naturalWidth < 128 || image.naturalHeight < 128 || image.naturalWidth > 4096 || image.naturalHeight > 4096) {
    throw new Error("Image dimensions must be between 128 and 4096 pixels.");
  }
  const scale = Math.min(1, 1600 / Math.max(image.naturalWidth, image.naturalHeight));
  const canvas = document.createElement("canvas");
  canvas.width = Math.round(image.naturalWidth * scale);
  canvas.height = Math.round(image.naturalHeight * scale);
  const context = canvas.getContext("2d");
  if (!context) throw new Error("This browser could not prepare the image.");
  context.imageSmoothingEnabled = true;
  context.imageSmoothingQuality = "high";
  context.drawImage(image, 0, 0, canvas.width, canvas.height);
  const prepared = canvas.toDataURL("image/jpeg", 0.86);
  const approximateBytes = Math.ceil((prepared.length - prepared.indexOf(",") - 1) * 0.75);
  if (approximateBytes > MAX_GENERATION_IMAGE_BYTES) throw new Error("The prepared image is still larger than 5 MB. Choose a simpler or smaller image.");
  return prepared;
}

const compactNumber = new Intl.NumberFormat("en", { notation: "compact", maximumFractionDigits: 1 });

function formatCount(value: number | undefined | null): string {
  return typeof value === "number" && Number.isFinite(value) ? compactNumber.format(value) : "—";
}

function formatScore(value: number | null): string {
  if (value === null) return "—";
  return `${value >= 100 ? Math.round(value) : value.toFixed(1)}x`;
}

function formatDuration(seconds: number | null): string {
  if (seconds === null) return "—";
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = Math.floor(seconds % 60);
  return h > 0 ? `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}` : `${m}:${String(s).padStart(2, "0")}`;
}

function bracketClasses(bracket: LabVideoScore["bracket"]): string {
  switch (bracket) {
    case "breakout":
      return "bg-red-500/90 text-white border-transparent";
    case "strong":
      return "bg-purple-500/90 text-white border-transparent";
    case "rising":
      return "bg-blue-500/90 text-white border-transparent";
    default:
      return "bg-black/70 text-white border-transparent";
  }
}

interface LaneConfig {
  id: LabLane;
  title: string;
  hint: string;
}

const LANES: LaneConfig[] = [
  { id: "niche", title: "My niche", hint: "What is ranking and breaking out on your exact topic." },
  { id: "adjacent", title: "Adjacent topics", hint: "Related territory one door over: e-commerce, side hustles, online income." },
  { id: "wildcard", title: "Wildcard outliers", hint: "Unrelated topics. Small channels with huge multipliers = pure packaging wins." },
];

interface LaneState {
  query: string;
  entries: LabRankedVideo[];
  loading: boolean;
  error: RequestFailure | null;
  searchedAt: string | null;
}

const emptyLane: LaneState = { query: "", entries: [], loading: false, error: null, searchedAt: null };

interface TrayReference {
  videoId: string;
  title: string;
  channelTitle: string;
  thumbnailUrl: string;
  lane: LabLane;
  viewCount?: number;
  subscriberCount?: number;
  outlierScore: number | null;
  viewsPerHour: number | null;
  publishedAt?: string;
}

interface PatternReference {
  videoId: string;
  trigger: string;
  triggerExecution: string;
  elementCount: number;
  focalPoint: string;
  separationTechnique: string;
  textInThumbnail: string;
  titleSynergy: string;
  emotion: string;
  colorStrategy: string;
  clickReason: string;
  skyscraperPattern: string;
}

interface PatternReport {
  references: PatternReference[];
  synthesis: {
    repeatedPatterns: Array<{ pattern: string; evidence: string }>;
    topicAdaptation: string;
    packagingDirections: Array<{ direction: string; trigger: string; why: string }>;
  };
}

interface LabConcept {
  id: string;
  trigger: string;
  title: string;
  thumbnailText: string;
  rationale: string;
  synergyNote: string;
  imageSpec: Record<string, unknown>;
}

interface RenderState {
  loading: boolean;
  error: RequestFailure | null;
  imageData: string | null;
  model: string | null;
}

interface SwipeAnalysis {
  trigger: string;
  whyItWorks: string;
  focalPoint: string;
  separationTechnique: string;
  textTreatment: string;
  colorStrategy: string;
  transferableTechnique: string;
  stealThis: string;
}

interface SwipeEntry {
  id: string;
  fileName: string;
  bytes: number;
  modifiedAt: string;
  analyzed: boolean;
  note: string;
  analysis: SwipeAnalysis | null;
}

interface TopicSuggestion {
  topic: string;
  title: string;
  thumbnailText: string;
  trigger: string;
  why: string;
}

function usePersistentText(key: string, fallback: string): [string, (value: string) => void] {
  const [value, setValue] = useState<string>(() => {
    try {
      return window.localStorage.getItem(key) ?? fallback;
    } catch {
      return fallback;
    }
  });
  useEffect(() => {
    try {
      window.localStorage.setItem(key, value);
    } catch {
      // Storage can be unavailable; the Lab still works per-session.
    }
  }, [key, value]);
  return [value, setValue];
}

function FailureNote({ failure }: { failure: RequestFailure }) {
  return (
    <Alert variant="destructive" className="mt-3">
      <AlertCircle className="h-4 w-4" />
      <AlertTitle>{failure.error}</AlertTitle>
      <AlertDescription>{failure.suggestion}</AlertDescription>
    </Alert>
  );
}


// Reads the funnel badges back as sentences about this specific result set.
// A generic glossary does not answer the question the badges provoke, which is
// why these particular numbers produced this particular result.
function FilterExplainer({
  rows,
  filters,
  entries,
  nowIso,
  showing,
  fetched,
  onSolo,
}: {
  rows: LabFilterFunnelRow[];
  onSolo: (key: string) => void;
  filters: LabFilters;
  entries: LabRankedVideo[];
  nowIso: string;
  showing: number;
  fetched: number;
}) {
  const describe = (row: LabFilterFunnelRow): string => {
    switch (row.key) {
      case "minOutlierScore":
        return `scored at least ${filters.minOutlierScore}x their channel's normal views`;
      case "minViews":
        return `have at least ${formatCount(filters.minViews)} views`;
      case "minViewsPerHour":
        return `are gaining at least ${formatCount(filters.minViewsPerHour)} views per hour`;
      case "maxSubscribers":
        return `come from channels with ${formatCount(filters.maxSubscribers)} subscribers or fewer`;
      case "minDurationSeconds":
        return `run at least ${Math.round((filters.minDurationSeconds || 0) / 60)} minutes`;
      case "maxDurationSeconds":
        return `run ${Math.round((filters.maxDurationSeconds || 0) / 60)} minutes or less`;
      case "publishedWithinDays":
        return `were published in the last ${filters.publishedWithinDays} days`;
      case "englishOnly":
        return "are declared English by their uploader";
      case "topicMatchQuery":
        return `actually mention ${topicMatchTerms(filters.topicMatchQuery || "").map((term) => JSON.stringify(term)).join(" and ")} in their title, tags, or description`;
      default:
        return "pass this filter";
    }
  };

  const tightest = rows.reduce((worst, row) => (row.passing < worst.passing ? row : worst));
  // What the result would be if the tightest filter were switched off, which is
  // the number that tells the creator whether loosening it is worth doing.
  const withoutTightest = applyLabFilters(
    entries,
    { ...filters, [tightest.key]: defaultLabFilters[tightest.key as keyof LabFilters] } as LabFilters,
    nowIso,
  ).length;

  return (
    <Accordion type="single" collapsible className="w-full basis-full">
      <AccordionItem value="explain" className="border-none">
        <AccordionTrigger className="py-1 text-xs font-normal text-muted-foreground hover:no-underline">
          What do these numbers mean?
        </AccordionTrigger>
        <AccordionContent className="space-y-3 pb-2 text-xs leading-relaxed">
          <p className="text-muted-foreground">Out of {fetched} videos fetched:</p>
          <ul className="space-y-1">
            {rows.map((row) => (
              <li key={row.key}>
                <button
                  type="button"
                  onClick={() => onSolo(row.key)}
                  className={`text-left hover:underline ${row.key === tightest.key ? "font-medium" : ""}`}
                  data-testid={`button-solo-${row.key}`}
                >
                  <span className="tabular-nums">{row.passing}</span> {describe(row)}
                  {row.key === tightest.key && <span className="text-destructive"> &larr; fewest</span>}
                  <span className="ml-1 text-primary">show these {row.passing}</span>
                </button>
              </li>
            ))}
          </ul>
          <p className="text-muted-foreground">
            Click any line to see just those videos. The other filters are ignored, except your length limits, which stay on so Shorts do not come back.
          </p>
          <p>
            But a video has to be in <strong>every one</strong> of those groups at the same time, and they
            barely overlap. Only <strong>{showing}</strong> {showing === 1 ? "video is" : "videos are"} in all{" "}
            {rows.length} at once. That is what you are seeing above.
          </p>
          <p className="rounded-md border border-border bg-muted/50 p-2">
            <strong>{tightest.label}</strong> is the bottleneck at {tightest.passing}. Turn it off and you
            would see <strong>{withoutTightest}</strong> {withoutTightest === 1 ? "video" : "videos"} instead
            of {showing}.
          </p>
          <p className="text-muted-foreground">
            Raising search depth fetches more candidates, but it cannot help when a filter is the limit.
          </p>
        </AccordionContent>
      </AccordionItem>
    </Accordion>
  );
}

export default function LabPage() {
  const [niche, setNiche] = usePersistentText("lab.niche", "");
  const [topic, setTopic] = usePersistentText("lab.topic", "");

  const [lanes, setLanes] = useState<Record<LabLane, LaneState>>({
    niche: { ...emptyLane },
    adjacent: { ...emptyLane },
    wildcard: { ...emptyLane },
  });

  const [seeds, setSeeds] = useState<Array<{ topic: string; why: string }>>([]);
  const [seedsLoading, setSeedsLoading] = useState(false);
  const [seedsError, setSeedsError] = useState<RequestFailure | null>(null);

  const [filterDraft, setFilterDraft] = useState({
    minOutlierScore: "",
    minViews: "1000",
    minViewsPerHour: "",
    maxSubscribers: "",
    minDurationMinutes: "",
    maxDurationMinutes: "",
    publishedWithinDays: "",
  });

  const [searchDepth, setSearchDepth] = useState(2);
  // Lets one filter be viewed on its own. Outliers matter enough on their own
  // that they should be reachable without satisfying the rest of the rubric.
  const [soloFilter, setSoloFilter] = useState<{ lane: LabLane; key: string } | null>(null);
  const [englishOnly, setEnglishOnly] = useState(false);
  const [topicMatch, setTopicMatch] = useState(true);

  const [tray, setTray] = useState<TrayReference[]>([]);
  const [analysisLoading, setAnalysisLoading] = useState(false);
  const [analysisError, setAnalysisError] = useState<RequestFailure | null>(null);
  const [report, setReport] = useState<PatternReport | null>(null);
  const [skippedIds, setSkippedIds] = useState<string[]>([]);

  const [angle, setAngle] = useState("");
  const [faceRefs, setFaceRefs] = useState<string[]>([]);
  const [rightsConfirmed, setRightsConfirmed] = useState(false);
  const [uploadError, setUploadError] = useState<string | null>(null);
  const [conceptsLoading, setConceptsLoading] = useState(false);
  const [conceptsError, setConceptsError] = useState<RequestFailure | null>(null);
  const [concepts, setConcepts] = useState<LabConcept[]>([]);
  const [renders, setRenders] = useState<Record<string, RenderState>>({});
  const [copiedId, setCopiedId] = useState<string | null>(null);

  const [swipeEntries, setSwipeEntries] = useState<SwipeEntry[]>([]);
  const [swipeFolder, setSwipeFolder] = useState("");
  const [swipeScanning, setSwipeScanning] = useState(false);
  const [swipeAnalyzing, setSwipeAnalyzing] = useState(false);
  const [swipeError, setSwipeError] = useState<RequestFailure | null>(null);
  const [includeSwipe, setIncludeSwipe] = useState(true);
  const [expandedSwipe, setExpandedSwipe] = useState<string | null>(null);

  const [topicsLoading, setTopicsLoading] = useState<"refine" | "suggest" | null>(null);
  const [topicsError, setTopicsError] = useState<RequestFailure | null>(null);
  const [topicSuggestions, setTopicSuggestions] = useState<TopicSuggestion[]>([]);

  const scanSwipeFolder = async (silent = false) => {
    if (!silent) setSwipeScanning(true);
    setSwipeError(null);
    try {
      const response = await fetch("/api/lab/swipe");
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) throw payload;
      setSwipeEntries(payload.entries ?? []);
      setSwipeFolder(payload.folder ?? "");
    } catch (error) {
      if (!silent) setSwipeError(failureFrom(error));
    } finally {
      setSwipeScanning(false);
    }
  };

  useEffect(() => {
    void scanSwipeFolder(true);
    // Scans once on mount; the Scan folder button refreshes on demand.
  }, []);

  const unanalyzedSwipe = useMemo(() => swipeEntries.filter((entry) => !entry.analyzed), [swipeEntries]);

  const analyzeSwipe = async (fileNames: string[]) => {
    if (fileNames.length === 0) return;
    setSwipeAnalyzing(true);
    setSwipeError(null);
    try {
      const notes: Record<string, string> = {};
      for (const entry of swipeEntries) {
        if (fileNames.includes(entry.fileName) && entry.note) notes[entry.fileName] = entry.note;
      }
      const data = await postJson<{ entries: SwipeEntry[] }>("/api/lab/swipe/analyze", {
        fileNames: fileNames.slice(0, 12),
        notes,
      });
      setSwipeEntries(data.entries);
    } catch (error) {
      setSwipeError(failureFrom(error));
    } finally {
      setSwipeAnalyzing(false);
    }
  };

  const saveSwipeNote = async (entry: SwipeEntry, note: string) => {
    setSwipeEntries((current) => current.map((item) => (item.id === entry.id ? { ...item, note } : item)));
    if (!entry.analyzed) return;
    try {
      await postJson("/api/lab/swipe/note", { id: entry.id, fileName: entry.fileName, note });
    } catch {
      // Notes are a convenience; a failed save should not interrupt the Lab.
    }
  };

  const filters: LabFilters = useMemo(() => {
    const num = (raw: string): number | null => {
      const parsed = Number(raw);
      return raw.trim() !== "" && Number.isFinite(parsed) && parsed >= 0 ? parsed : null;
    };
    return {
      ...defaultLabFilters,
      minOutlierScore: num(filterDraft.minOutlierScore) ?? 0,
      minViews: num(filterDraft.minViews) ?? 0,
      minViewsPerHour: num(filterDraft.minViewsPerHour) ?? 0,
      maxSubscribers: num(filterDraft.maxSubscribers),
      minDurationSeconds: num(filterDraft.minDurationMinutes) !== null ? (num(filterDraft.minDurationMinutes) as number) * 60 : null,
      maxDurationSeconds: num(filterDraft.maxDurationMinutes) !== null ? (num(filterDraft.maxDurationMinutes) as number) * 60 : null,
      publishedWithinDays: num(filterDraft.publishedWithinDays),
      englishOnly,
    };
  }, [filterDraft, englishOnly]);

  const nowIso = useMemo(() => new Date().toISOString(), [lanes]);

  const filtersForLane = (lane: LabLane): LabFilters => ({
    ...filters,
    topicMatchQuery: topicMatch ? lanes[lane].query.trim() || null : null,
  });

  const visibleByLane = useMemo(() => {
    const result: Record<LabLane, LabRankedVideo[]> = { niche: [], adjacent: [], wildcard: [] };
    for (const lane of LANES) {
      const laneFilters: LabFilters = {
        ...filters,
        topicMatchQuery: topicMatch ? lanes[lane.id].query.trim() || null : null,
      };
      const soloKey = soloFilter?.lane === lane.id ? soloFilter.key : null;
      const applied = soloKey
        ? ({
            ...defaultLabFilters,
            [soloKey]: laneFilters[soloKey as keyof LabFilters],
            // Length bounds are what exclude Shorts, so isolating another
            // filter must not quietly let them back in.
            minDurationSeconds: laneFilters.minDurationSeconds,
            maxDurationSeconds: laneFilters.maxDurationSeconds,
          } as LabFilters)
        : laneFilters;
      result[lane.id] = rankByOutlierScore(applyLabFilters(lanes[lane.id].entries, applied, nowIso));
    }
    return result;
  }, [lanes, filters, nowIso, soloFilter, topicMatch]);

  const evidence = useMemo(() => {
    const lines: Array<{ score: number; line: string }> = [];
    for (const lane of LANES) {
      for (const { video, score } of visibleByLane[lane.id]) {
        lines.push({
          score: score.outlierScore ?? 0,
          line: `[${lane.id}] ${formatScore(score.outlierScore)} | ${score.viewsPerHour === null ? "—" : Math.round(score.viewsPerHour)} VPH | ${formatCount(video.viewCount)} views | ${formatCount(video.channelStatistics?.subscriberCount)} subs | "${video.title}" — ${video.channelTitle}`,
        });
      }
    }
    return lines
      .sort((a, b) => b.score - a.score)
      .slice(0, 18)
      .map((entry) => entry.line)
      .join("\n");
  }, [visibleByLane]);

  const updateLane = (lane: LabLane, patch: Partial<LaneState>) => {
    setLanes((current) => ({ ...current, [lane]: { ...current[lane], ...patch } }));
  };

  const runLaneSearch = async (lane: LabLane) => {
    const query = lanes[lane].query.trim();
    if (!query) {
      updateLane(lane, { error: { error: "Add a search topic first", suggestion: "Type what this lane should search for." } });
      return;
    }
    setSoloFilter((current) => (current?.lane === lane ? null : current));
    updateLane(lane, { loading: true, error: null });
    try {
      const data = await postJson<{ search: { videos: Video[] }; scores: LabVideoScore[]; pagesFetched: number }>("/api/lab/search", {
        lane,
        filters: { query, maxResults: 50 },
        pages: searchDepth,
        // Recency goes into the YouTube query itself, so the fetched pages are
        // already inside the window instead of being filtered down to nothing.
        publishedWithinDays: filters.publishedWithinDays,
        englishOnly,
      });
      const scoreById = new Map(data.scores.map((score) => [score.videoId, score]));
      const entries: LabRankedVideo[] = data.search.videos
        .map((video) => {
          const score = scoreById.get(video.id);
          return score ? { video, score } : null;
        })
        .filter((entry): entry is LabRankedVideo => entry !== null);
      updateLane(lane, { loading: false, entries, searchedAt: new Date().toISOString() });
    } catch (error) {
      updateLane(lane, { loading: false, error: failureFrom(error) });
    }
  };

  const proposeSeeds = async () => {
    if (!niche.trim()) {
      setSeedsError({ error: "Set your niche first", suggestion: "Wildcard seeds are picked to be far from your niche, so the Lab needs to know it." });
      return;
    }
    setSeedsLoading(true);
    setSeedsError(null);
    try {
      const data = await postJson<{ seeds: Array<{ topic: string; why: string }> }>("/api/lab/seeds", {
        niche: niche.trim(),
        avoid: [lanes.niche.query, lanes.adjacent.query].filter(Boolean),
      });
      setSeeds(data.seeds);
    } catch (error) {
      setSeedsError(failureFrom(error));
    } finally {
      setSeedsLoading(false);
    }
  };

  const inTray = (videoId: string) => tray.some((entry) => entry.videoId === videoId);

  const toggleTray = (lane: LabLane, entry: LabRankedVideo) => {
    setTray((current) => {
      if (current.some((item) => item.videoId === entry.video.id)) {
        return current.filter((item) => item.videoId !== entry.video.id);
      }
      if (current.length >= MAX_TRAY) return current;
      return [
        ...current,
        {
          videoId: entry.video.id,
          title: entry.video.title,
          channelTitle: entry.video.channelTitle,
          thumbnailUrl: entry.video.thumbnailUrl,
          lane,
          viewCount: entry.video.viewCount,
          subscriberCount: entry.video.channelStatistics?.subscriberCount,
          outlierScore: entry.score.outlierScore,
          viewsPerHour: entry.score.viewsPerHour,
          publishedAt: entry.video.publishedAt,
        },
      ];
    });
  };

  const runAnalysis = async () => {
    if (!topic.trim()) {
      setAnalysisError({ error: "Set a working topic first", suggestion: "The pattern report adapts what it finds to your topic." });
      return;
    }
    if (tray.length === 0) {
      setAnalysisError({ error: "Pick reference thumbnails first", suggestion: "Star thumbnails in the lanes above to add them here." });
      return;
    }
    setAnalysisLoading(true);
    setAnalysisError(null);
    try {
      const data = await postJson<{ report: PatternReport; skippedVideoIds: string[] }>("/api/lab/analyze", {
        topic: topic.trim(),
        references: tray.map((entry) => ({
          videoId: entry.videoId,
          title: entry.title,
          channelTitle: entry.channelTitle,
          thumbnailUrl: entry.thumbnailUrl,
          lane: entry.lane,
          viewCount: entry.viewCount,
          subscriberCount: entry.subscriberCount,
          outlierScore: entry.outlierScore,
          viewsPerHour: entry.viewsPerHour,
          publishedAt: entry.publishedAt,
        })),
      });
      setReport(data.report);
      setSkippedIds(data.skippedVideoIds);
    } catch (error) {
      setAnalysisError(failureFrom(error));
    } finally {
      setAnalysisLoading(false);
    }
  };

  const onFaceUpload = async (files: FileList | null) => {
    if (!files || files.length === 0) return;
    setUploadError(null);
    try {
      const prepared: string[] = [];
      for (const file of Array.from(files).slice(0, 3 - faceRefs.length)) {
        prepared.push(await prepareReferenceImage(file));
      }
      setFaceRefs((current) => [...current, ...prepared].slice(0, 3));
    } catch (error) {
      setUploadError(error instanceof Error ? error.message : "The image could not be prepared.");
    }
  };

  const referenceImagesPayload = () =>
    faceRefs.map((image, index) => ({ image, role: index === 0 ? "subject" : "style" }));

  const runConcepts = async () => {
    if (!topic.trim()) {
      setConceptsError({ error: "Set a working topic first", suggestion: "Concepts are packaged for one specific topic." });
      return;
    }
    setConceptsLoading(true);
    setConceptsError(null);
    try {
      const data = await postJson<{ concepts: LabConcept[] }>("/api/lab/concepts", {
        topic: topic.trim(),
        angle: angle.trim(),
        patternSynthesis: report ? JSON.stringify(report.synthesis, null, 2) : "",
        referenceImages: referenceImagesPayload(),
        referenceRightsConfirmed: faceRefs.length > 0 ? rightsConfirmed : false,
        includeSwipeFile: includeSwipe,
      });
      setConcepts(data.concepts);
      setRenders({});
    } catch (error) {
      setConceptsError(failureFrom(error));
    } finally {
      setConceptsLoading(false);
    }
  };

  const renderConcept = async (concept: LabConcept) => {
    setRenders((current) => ({
      ...current,
      [concept.id]: { loading: true, error: null, imageData: current[concept.id]?.imageData ?? null, model: null },
    }));
    try {
      const data = await postJson<{ imageData: string; model: string }>("/api/lab/render", {
        title: concept.title,
        thumbnailText: concept.thumbnailText,
        imageSpec: concept.imageSpec,
        referenceImages: referenceImagesPayload(),
        referenceRightsConfirmed: faceRefs.length > 0 ? rightsConfirmed : false,
      });
      setRenders((current) => ({
        ...current,
        [concept.id]: { loading: false, error: null, imageData: data.imageData, model: data.model },
      }));
    } catch (error) {
      setRenders((current) => ({
        ...current,
        [concept.id]: { loading: false, error: failureFrom(error), imageData: current[concept.id]?.imageData ?? null, model: null },
      }));
    }
  };

  const copyConceptJson = async (concept: LabConcept) => {
    const exportJson = {
      target: "gpt-image-2",
      video_title: concept.title,
      thumbnail_text: concept.thumbnailText,
      dominant_trigger: concept.trigger,
      ...concept.imageSpec,
    };
    try {
      await navigator.clipboard.writeText(JSON.stringify(exportJson, null, 2));
      setCopiedId(concept.id);
      window.setTimeout(() => setCopiedId((current) => (current === concept.id ? null : current)), 2_000);
    } catch {
      setCopiedId(null);
    }
  };

  const downloadRender = (concept: LabConcept) => {
    const render = renders[concept.id];
    if (!render?.imageData) return;
    const anchor = document.createElement("a");
    anchor.href = render.imageData;
    anchor.download = `${concept.id}-${concept.title.toLowerCase().replace(/[^a-z0-9]+/g, "-").slice(0, 60)}.png`;
    anchor.click();
  };

  const runTopics = async (mode: "refine" | "suggest") => {
    if (!niche.trim()) {
      setTopicsError({ error: "Set your niche first", suggestion: "Topic packages are strategized for your niche." });
      return;
    }
    if (mode === "refine" && !topic.trim()) {
      setTopicsError({ error: "Set the topic to refine", suggestion: "Refine mode sharpens the topic in the working-topic box." });
      return;
    }
    setTopicsLoading(mode);
    setTopicsError(null);
    try {
      const data = await postJson<{ suggestions: TopicSuggestion[] }>("/api/lab/topics", {
        mode,
        niche: niche.trim(),
        topic: topic.trim(),
        evidence,
      });
      setTopicSuggestions(data.suggestions);
    } catch (error) {
      setTopicsError(failureFrom(error));
    } finally {
      setTopicsLoading(null);
    }
  };

  return (
    <div className="mx-auto w-full max-w-6xl space-y-6 p-4 md:p-6">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h1 className="flex items-center gap-2 text-2xl font-semibold">
            <FlaskConical className="h-6 w-6 text-primary" aria-hidden="true" />
            Thumbnail Lab
          </h1>
          <p className="mt-1 text-sm text-muted-foreground">
            Hunt outlier thumbnails, extract what makes them clickable, and package your next video: title and thumbnail together.
          </p>
        </div>
      </div>

      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-base">Setup</CardTitle>
          <CardDescription>The niche steers wildcard seeds and topic strategy. The working topic is what you are packaging.</CardDescription>
        </CardHeader>
        <CardContent className="grid gap-4 md:grid-cols-2">
          <div className="space-y-1.5">
            <Label htmlFor="lab-niche">My niche</Label>
            <Input
              id="lab-niche"
              value={niche}
              maxLength={200}
              placeholder="e.g. Google Shopping dropshipping"
              onChange={(event) => setNiche(event.target.value)}
              data-testid="input-lab-niche"
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="lab-topic">Working topic</Label>
            <Input
              id="lab-topic"
              value={topic}
              maxLength={200}
              placeholder="The video you are packaging right now"
              onChange={(event) => setTopic(event.target.value)}
              data-testid="input-lab-topic"
            />
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-base">Smart filters</CardTitle>
          <CardDescription>
            Applied to every lane below, vidIQ-style. Drop max subscribers and raise the outlier floor to surface small channels doing exceptional numbers.
            A day window also narrows the YouTube query itself, so lanes fetch inside the window instead of filtering afterwards. Min views defaults to 1000 because a channel with a handful of subscribers produces meaningless multipliers; clear it to see everything.
          </CardDescription>
        </CardHeader>
        <CardContent className="grid grid-cols-2 gap-3 md:grid-cols-4 lg:grid-cols-7">
          {[
            { key: "minOutlierScore", label: "Min outlier ×" },
            { key: "minViews", label: "Min views" },
            { key: "minViewsPerHour", label: "Min VPH" },
            { key: "maxSubscribers", label: "Max subs" },
            { key: "minDurationMinutes", label: "Min length (min)" },
            { key: "maxDurationMinutes", label: "Max length (min)" },
            { key: "publishedWithinDays", label: "Within (days)" },
          ].map((field) => (
            <div key={field.key} className="space-y-1">
              <Label htmlFor={`lab-filter-${field.key}`} className="text-xs">{field.label}</Label>
              <Input
                id={`lab-filter-${field.key}`}
                inputMode="numeric"
                placeholder="—"
                value={filterDraft[field.key as keyof typeof filterDraft]}
                onChange={(event) => setFilterDraft((current) => ({ ...current, [field.key]: event.target.value }))}
                data-testid={`input-lab-filter-${field.key}`}
              />
            </div>
          ))}
          <div className="col-span-2 flex items-center gap-2 md:col-span-4 lg:col-span-7">
            <Checkbox
              id="lab-topic-match"
              checked={topicMatch}
              onCheckedChange={(checked) => setTopicMatch(checked === true)}
              data-testid="checkbox-topic-match"
            />
            <Label htmlFor="lab-topic-match" className="text-xs font-normal">
              Topic match
              <span className="ml-1 text-muted-foreground">
                (drops videos that do not mention your search words. YouTube pads deep result pages with loosely-related videos, and this removes them)
              </span>
            </Label>
          </div>
          <div className="col-span-2 flex items-center gap-2 md:col-span-4 lg:col-span-7">
            <Checkbox
              id="lab-english"
              checked={englishOnly}
              onCheckedChange={(checked) => setEnglishOnly(checked === true)}
              data-testid="checkbox-english-only"
            />
            <Label htmlFor="lab-english" className="text-xs font-normal">
              English only
              <span className="ml-1 text-muted-foreground">
                (asks YouTube for English and keeps only videos whose declared language is English; videos with no declared language are excluded)
              </span>
            </Label>
          </div>
          <div className="col-span-2 space-y-1 md:col-span-4 lg:col-span-7">
            <Label htmlFor="lab-depth" className="text-xs">
              Search depth: {searchDepth} page{searchDepth === 1 ? "" : "s"} ({searchDepth * 50} videos per lane, {searchDepth * 100} quota units)
            </Label>
            <input
              id="lab-depth"
              type="range"
              min={1}
              max={6}
              step={1}
              value={searchDepth}
              onChange={(event) => setSearchDepth(Number(event.target.value))}
              className="w-full accent-primary"
              data-testid="input-lab-depth"
            />
            <p className="text-xs text-muted-foreground">
              Tight filters need more depth, but YouTube's relevance drops sharply after page 2: on a sample search, page 1 was 90% on-topic and page 3 was 22%. Keep Topic match on when going deep.
            </p>
          </div>
        </CardContent>
      </Card>

      {LANES.map((lane) => {
        const state = lanes[lane.id];
        const visible = visibleByLane[lane.id];
        return (
          <Card key={lane.id} data-testid={`lane-${lane.id}`}>
            <CardHeader className="pb-3">
              <CardTitle className="text-base">{lane.title}</CardTitle>
              <CardDescription>{lane.hint}</CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="flex flex-col gap-2 sm:flex-row">
                <Input
                  value={state.query}
                  maxLength={200}
                  placeholder={lane.id === "wildcard" ? "Pick a proposed seed below or type any far-away topic" : "Search topic for this lane"}
                  onChange={(event) => updateLane(lane.id, { query: event.target.value })}
                  onKeyDown={(event) => {
                    if (event.key === "Enter") void runLaneSearch(lane.id);
                  }}
                  data-testid={`input-lane-query-${lane.id}`}
                />
                <Button
                  onClick={() => void runLaneSearch(lane.id)}
                  disabled={state.loading}
                  className="min-w-28"
                  data-testid={`button-lane-search-${lane.id}`}
                >
                  {state.loading ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Search className="mr-2 h-4 w-4" />}
                  Search
                </Button>
                {lane.id === "wildcard" && (
                  <Button variant="outline" onClick={() => void proposeSeeds()} disabled={seedsLoading} data-testid="button-propose-seeds">
                    {seedsLoading ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Sparkles className="mr-2 h-4 w-4" />}
                    Propose seeds
                  </Button>
                )}
              </div>

              {lane.id === "wildcard" && seeds.length > 0 && (
                <div className="flex flex-wrap gap-2">
                  {seeds.map((seed) => (
                    <button
                      key={seed.topic}
                      type="button"
                      title={seed.why}
                      onClick={() => updateLane("wildcard", { query: seed.topic })}
                      className="rounded-full border border-border bg-muted px-3 py-1 text-xs hover:bg-accent"
                      data-testid="chip-wildcard-seed"
                    >
                      {seed.topic}
                    </button>
                  ))}
                </div>
              )}
              {lane.id === "wildcard" && seedsError && <FailureNote failure={seedsError} />}
              {state.error && <FailureNote failure={state.error} />}

              {state.entries.length > 0 && (
                <div className="space-y-1.5">
                  {soloFilter?.lane === lane.id ? (
                    <div className="flex flex-wrap items-center gap-2 rounded-md border border-primary/40 bg-primary/10 px-2 py-1.5 text-xs">
                      <span>
                        {(() => {
                          const laneFilters = filtersForLane(lane.id);
                          const label = computeFilterFunnel(state.entries, laneFilters, nowIso)
                            .find((row) => row.key === soloFilter.key)?.label ?? soloFilter.key;
                          const soloOnly = applyLabFilters(
                            state.entries,
                            { ...defaultLabFilters, [soloFilter.key]: laneFilters[soloFilter.key as keyof LabFilters] } as LabFilters,
                            nowIso,
                          ).length;
                          const lengthActive = laneFilters.minDurationSeconds !== null || laneFilters.maxDurationSeconds !== null;
                          const trimmed = soloOnly - visible.length;
                          return (
                            <>
                              Showing <strong>{visible.length}</strong> videos that pass <strong>{label}</strong>.
                              {lengthActive
                                ? trimmed > 0
                                  ? ` Every other filter is ignored, except the length limits, which removed ${trimmed} short ${trimmed === 1 ? "video" : "videos"} from the ${soloOnly} that passed.`
                                  : " Every other filter is ignored, except the length limits, which stay on to keep Shorts out."
                                : " Every other filter is ignored."}
                            </>
                          );
                        })()}
                      </span>
                      <Button
                        size="sm"
                        variant="outline"
                        className="h-6 px-2 text-xs"
                        onClick={() => setSoloFilter(null)}
                        data-testid={`button-clear-solo-${lane.id}`}
                      >
                        Back to all filters
                      </Button>
                    </div>
                  ) : (
                    <p className="text-xs text-muted-foreground">
                      Showing {visible.length} of {state.entries.length} fetched videos after filters. Star a thumbnail to add it to the reference tray.
                    </p>
                  )}
                  {(() => {
                    const laneFilters = filtersForLane(lane.id);
                    const funnel = computeFilterFunnel(state.entries, laneFilters, nowIso);
                    if (funnel.length === 0) return null;
                    const tightest = funnel.reduce((worst, row) => (row.passing < worst.passing ? row : worst));
                    return (
                      <div className="flex flex-wrap items-center gap-1.5 text-xs">
                        <span className="text-muted-foreground">Each filter alone admits:</span>
                        {funnel.map((row) => (
                          <Badge
                            key={row.key}
                            variant={row.key === tightest.key ? "destructive" : "secondary"}
                            className="font-normal"
                          >
                            {row.label} {row.passing}
                          </Badge>
                        ))}
                        {visible.length < 5 && (
                          <span className="text-muted-foreground">
                            Tightest is {tightest.label}. Loosen it, or raise search depth.
                          </span>
                        )}
                        <FilterExplainer rows={funnel} filters={laneFilters} entries={state.entries} nowIso={nowIso} showing={visible.length} fetched={state.entries.length} onSolo={(key) => setSoloFilter({ lane: lane.id, key })} />
                      </div>
                    );
                  })()}
                </div>
              )}

              <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
                {visible.map((entry) => {
                  const selected = inTray(entry.video.id);
                  return (
                    <div key={entry.video.id} className="group overflow-hidden rounded-lg border border-border bg-card" data-testid={`video-card-${entry.video.id}`}>
                      <div className="relative aspect-video bg-muted">
                        <a
                          href={`https://www.youtube.com/watch?v=${entry.video.id}`}
                          target="_blank"
                          rel="noopener noreferrer"
                          aria-label={`Watch "${entry.video.title}" on YouTube`}
                          data-testid={`link-watch-${entry.video.id}`}
                        >
                          <img
                            src={entry.video.thumbnailUrl}
                            alt={entry.video.title}
                            loading="lazy"
                            className="h-full w-full object-cover transition-opacity hover:opacity-90"
                          />
                        </a>
                        <div className="absolute left-2 top-2 flex gap-1.5">
                          <Badge className={bracketClasses(entry.score.bracket)}>{formatScore(entry.score.outlierScore)}</Badge>
                          {entry.score.viewsPerHour !== null && (
                            <Badge className="border-transparent bg-black/70 text-white">{Math.round(entry.score.viewsPerHour)} VPH</Badge>
                          )}
                        </div>
                        <div className="absolute bottom-2 right-2">
                          <Badge className="border-transparent bg-black/70 text-white">{formatDuration(entry.score.durationSeconds)}</Badge>
                        </div>
                        <button
                          type="button"
                          onClick={() => toggleTray(lane.id, entry)}
                          aria-label={selected ? "Remove from reference tray" : "Add to reference tray"}
                          className={`absolute right-2 top-2 rounded-full p-1.5 ${selected ? "bg-primary text-primary-foreground" : "bg-black/60 text-white opacity-0 transition-opacity group-hover:opacity-100"}`}
                          data-testid={`button-tray-toggle-${entry.video.id}`}
                        >
                          <Star className="h-4 w-4" fill={selected ? "currentColor" : "none"} />
                        </button>
                      </div>
                      <div className="space-y-1 p-3">
                        <a
                          href={`https://www.youtube.com/watch?v=${entry.video.id}`}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="line-clamp-2 block text-sm font-medium leading-snug hover:underline"
                          data-testid={`link-title-${entry.video.id}`}
                        >
                          {entry.video.title}
                        </a>
                        <p className="text-xs text-muted-foreground">
                          {entry.video.channelTitle} · {formatCount(entry.video.channelStatistics?.subscriberCount)} subs
                        </p>
                        <p className="text-xs text-muted-foreground">
                          {formatCount(entry.video.viewCount)} views ·{" "}
                          <span title={formatAbsolutePublished(entry.video.publishedAt)}>
                            {formatRelativePublished(entry.video.publishedAt, nowIso)}
                          </span>
                          {entry.score.baselineSource === "recent_uploads"
                            ? ` · vs median ${formatCount(entry.score.baselineViews)}`
                            : entry.score.baselineSource === "lifetime_average"
                              ? ` · vs lifetime avg ${formatCount(entry.score.baselineViews)}`
                              : ""}
                        </p>
                      </div>
                    </div>
                  );
                })}
              </div>
            </CardContent>
          </Card>
        );
      })}

      <Card data-testid="reference-tray">
        <CardHeader className="pb-3">
          <CardTitle className="text-base">Reference tray ({tray.length}/{MAX_TRAY})</CardTitle>
          <CardDescription>
            The thumbnails Gemini will actually look at, pixel by pixel. Aim for around six, mixing lanes: your niche, adjacent wins, and wildcard outliers.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          {tray.length === 0 ? (
            <p className="text-sm text-muted-foreground">Nothing selected yet. Star thumbnails in the lanes above.</p>
          ) : (
            <div className="flex flex-wrap gap-3">
              {tray.map((entry) => (
                <div key={entry.videoId} className="relative w-40">
                  <img src={entry.thumbnailUrl} alt={entry.title} className="aspect-video w-full rounded-md object-cover" />
                  <Badge className={`absolute left-1 top-1 ${bracketClasses(entry.outlierScore !== null && entry.outlierScore >= 10 ? "breakout" : entry.outlierScore !== null && entry.outlierScore >= 5 ? "strong" : entry.outlierScore !== null && entry.outlierScore >= 2 ? "rising" : "standard")}`}>
                    {formatScore(entry.outlierScore)}
                  </Badge>
                  <button
                    type="button"
                    onClick={() => setTray((current) => current.filter((item) => item.videoId !== entry.videoId))}
                    aria-label="Remove reference"
                    className="absolute right-1 top-1 rounded-full bg-black/70 p-1 text-white"
                  >
                    <X className="h-3 w-3" />
                  </button>
                  <p className="mt-1 line-clamp-2 text-xs leading-snug">{entry.title}</p>
                </div>
              ))}
            </div>
          )}
          <div className="flex items-center gap-3">
            <Button onClick={() => void runAnalysis()} disabled={analysisLoading || tray.length === 0} data-testid="button-analyze-patterns">
              {analysisLoading ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Wand2 className="mr-2 h-4 w-4" />}
              Analyze patterns
            </Button>
            {skippedIds.length > 0 && (
              <p className="text-xs text-muted-foreground">{skippedIds.length} reference(s) could not be fetched and were skipped.</p>
            )}
          </div>
          {analysisError && <FailureNote failure={analysisError} />}
        </CardContent>
      </Card>

      {report && (
        <Card data-testid="pattern-report">
          <CardHeader className="pb-3">
            <CardTitle className="text-base">Pattern report</CardTitle>
            <CardDescription>What is earning the click across your references, weighted toward small-channel outliers.</CardDescription>
          </CardHeader>
          <CardContent className="space-y-5">
            <div>
              <h3 className="mb-2 text-sm font-semibold">Repeated patterns</h3>
              <ul className="space-y-2">
                {report.synthesis.repeatedPatterns.map((entry, index) => (
                  <li key={index} className="rounded-md border border-border p-3 text-sm">
                    <p className="font-medium">{entry.pattern}</p>
                    <p className="mt-1 text-xs text-muted-foreground">{entry.evidence}</p>
                  </li>
                ))}
              </ul>
            </div>
            <div>
              <h3 className="mb-2 text-sm font-semibold">Adapting this to your topic</h3>
              <p className="text-sm leading-relaxed">{report.synthesis.topicAdaptation}</p>
            </div>
            <div>
              <h3 className="mb-2 text-sm font-semibold">Packaging directions</h3>
              <div className="grid gap-3 md:grid-cols-3">
                {report.synthesis.packagingDirections.map((entry, index) => (
                  <div key={index} className="rounded-md border border-border p-3">
                    <Badge variant="secondary" className="mb-2">{entry.trigger}</Badge>
                    <p className="text-sm font-medium">{entry.direction}</p>
                    <p className="mt-1 text-xs text-muted-foreground">{entry.why}</p>
                  </div>
                ))}
              </div>
            </div>
            <Separator />
            <div>
              <h3 className="mb-2 text-sm font-semibold">Per-reference breakdown</h3>
              <div className="grid gap-3 md:grid-cols-2">
                {report.references.map((entry) => {
                  const trayEntry = tray.find((item) => item.videoId === entry.videoId);
                  return (
                    <div key={entry.videoId} className="rounded-md border border-border p-3 text-sm">
                      <div className="mb-2 flex items-center gap-2">
                        {trayEntry && <img src={trayEntry.thumbnailUrl} alt="" className="h-12 w-auto rounded" />}
                        <div>
                          <Badge variant="secondary">{entry.trigger}</Badge>
                          <p className="mt-1 line-clamp-1 text-xs text-muted-foreground">{trayEntry?.title ?? entry.videoId}</p>
                        </div>
                      </div>
                      <dl className="space-y-1 text-xs leading-relaxed">
                        <div><dt className="inline font-medium">Execution: </dt><dd className="inline">{entry.triggerExecution}</dd></div>
                        <div><dt className="inline font-medium">Focal point: </dt><dd className="inline">{entry.focalPoint}</dd></div>
                        <div><dt className="inline font-medium">Separation: </dt><dd className="inline">{entry.separationTechnique}</dd></div>
                        <div><dt className="inline font-medium">Text: </dt><dd className="inline">{entry.textInThumbnail || "(none)"}</dd></div>
                        <div><dt className="inline font-medium">Title synergy: </dt><dd className="inline">{entry.titleSynergy}</dd></div>
                        <div><dt className="inline font-medium">Click reason: </dt><dd className="inline">{entry.clickReason}</dd></div>
                        <div><dt className="inline font-medium">Transferable formula: </dt><dd className="inline">{entry.skyscraperPattern}</dd></div>
                      </dl>
                    </div>
                  );
                })}
              </div>
            </div>
          </CardContent>
        </Card>
      )}

      <Card data-testid="swipe-file">
        <CardHeader className="pb-3">
          <CardTitle className="text-base">Swipe file</CardTitle>
          <CardDescription>
            Thumbnails you saved while scrolling because your own eye judged them exceptional. Drop images into the folder below, scan, and analyze. Analyzed entries steer every packaging concept.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="flex flex-wrap items-center gap-2">
            <Button variant="outline" onClick={() => void scanSwipeFolder()} disabled={swipeScanning} data-testid="button-scan-swipe">
              {swipeScanning ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <RefreshCw className="mr-2 h-4 w-4" />}
              Scan folder
            </Button>
            <Button
              onClick={() => void analyzeSwipe(unanalyzedSwipe.map((entry) => entry.fileName))}
              disabled={swipeAnalyzing || unanalyzedSwipe.length === 0}
              data-testid="button-analyze-swipe"
            >
              {swipeAnalyzing ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Wand2 className="mr-2 h-4 w-4" />}
              Analyze new ({unanalyzedSwipe.length})
            </Button>
            <div className="flex items-center gap-2">
              <Checkbox
                id="include-swipe"
                checked={includeSwipe}
                onCheckedChange={(checked) => setIncludeSwipe(checked === true)}
                data-testid="checkbox-include-swipe"
              />
              <Label htmlFor="include-swipe" className="text-xs font-normal text-muted-foreground">
                Use swipe file when generating concepts
              </Label>
            </div>
          </div>

          {swipeFolder && (
            <p className="flex items-center gap-1.5 text-xs text-muted-foreground">
              <FolderOpen className="h-3.5 w-3.5" aria-hidden="true" />
              <code className="rounded bg-muted px-1.5 py-0.5">{swipeFolder}</code>
            </p>
          )}
          {swipeError && <FailureNote failure={swipeError} />}

          {swipeEntries.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              No images yet. Save thumbnails into the folder above (PNG, JPEG, or WebP), then press Scan folder. Descriptive file names help the analysis.
            </p>
          ) : (
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
              {swipeEntries.map((entry) => (
                <div key={entry.id} className="overflow-hidden rounded-lg border border-border bg-card" data-testid={`swipe-${entry.id}`}>
                  <div className="relative aspect-video bg-muted">
                    <img
                      src={`/api/lab/swipe/image?file=${encodeURIComponent(entry.fileName)}`}
                      alt={entry.fileName}
                      loading="lazy"
                      className="h-full w-full object-cover"
                    />
                    {entry.analysis && (
                      <Badge className="absolute left-2 top-2 border-transparent bg-primary text-primary-foreground">
                        {entry.analysis.trigger}
                      </Badge>
                    )}
                    {!entry.analyzed && (
                      <Badge className="absolute right-2 top-2 border-transparent bg-black/70 text-white">Not analyzed</Badge>
                    )}
                  </div>
                  <div className="space-y-2 p-3">
                    <p className="line-clamp-1 text-xs font-medium">{entry.fileName}</p>
                    <Input
                      value={entry.note}
                      maxLength={300}
                      placeholder="Why did you save this? (optional)"
                      onChange={(event) => void saveSwipeNote(entry, event.target.value)}
                      className="h-8 text-xs"
                      data-testid={`input-swipe-note-${entry.id}`}
                    />
                    {entry.analysis && (
                      <>
                        <p className="text-xs leading-relaxed">
                          <span className="font-medium">Steal: </span>{entry.analysis.stealThis}
                        </p>
                        <button
                          type="button"
                          onClick={() => setExpandedSwipe((current) => (current === entry.id ? null : entry.id))}
                          className="text-xs text-primary underline-offset-2 hover:underline"
                          data-testid={`button-swipe-details-${entry.id}`}
                        >
                          {expandedSwipe === entry.id ? "Hide breakdown" : "Full breakdown"}
                        </button>
                        {expandedSwipe === entry.id && (
                          <dl className="space-y-1 border-t border-border pt-2 text-xs leading-relaxed">
                            <div><dt className="inline font-medium">Why it works: </dt><dd className="inline">{entry.analysis.whyItWorks}</dd></div>
                            <div><dt className="inline font-medium">Focal point: </dt><dd className="inline">{entry.analysis.focalPoint}</dd></div>
                            <div><dt className="inline font-medium">Separation: </dt><dd className="inline">{entry.analysis.separationTechnique}</dd></div>
                            <div><dt className="inline font-medium">Text: </dt><dd className="inline">{entry.analysis.textTreatment || "(none)"}</dd></div>
                            <div><dt className="inline font-medium">Color: </dt><dd className="inline">{entry.analysis.colorStrategy}</dd></div>
                            <div><dt className="inline font-medium">Transferable: </dt><dd className="inline">{entry.analysis.transferableTechnique}</dd></div>
                          </dl>
                        )}
                      </>
                    )}
                    {!entry.analyzed && (
                      <Button
                        size="sm"
                        variant="outline"
                        onClick={() => void analyzeSwipe([entry.fileName])}
                        disabled={swipeAnalyzing}
                        data-testid={`button-analyze-one-${entry.id}`}
                      >
                        <Wand2 className="mr-1.5 h-3.5 w-3.5" />
                        Analyze
                      </Button>
                    )}
                  </div>
                </div>
              ))}
            </div>
          )}
        </CardContent>
      </Card>

      <Card data-testid="topic-engine">
        <CardHeader className="pb-3">
          <CardTitle className="text-base">Topic engine</CardTitle>
          <CardDescription>
            Topics and packaging are inseparable, so every suggestion arrives as topic + title + thumbnail text. Uses the filtered lane evidence above.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="flex flex-wrap gap-2">
            <Button variant="outline" onClick={() => void runTopics("refine")} disabled={topicsLoading !== null} data-testid="button-topics-refine">
              {topicsLoading === "refine" ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Wand2 className="mr-2 h-4 w-4" />}
              Refine my working topic
            </Button>
            <Button variant="outline" onClick={() => void runTopics("suggest")} disabled={topicsLoading !== null} data-testid="button-topics-suggest">
              {topicsLoading === "suggest" ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Lightbulb className="mr-2 h-4 w-4" />}
              What should I make right now?
            </Button>
            {evidence === "" && (
              <p className="self-center text-xs text-muted-foreground">Tip: run lane searches first so suggestions are grounded in outlier evidence.</p>
            )}
          </div>
          {topicsError && <FailureNote failure={topicsError} />}
          {topicSuggestions.length > 0 && (
            <div className="grid gap-3 md:grid-cols-2">
              {topicSuggestions.map((suggestion, index) => (
                <div key={index} className="rounded-md border border-border p-3">
                  <Badge variant="secondary" className="mb-2">{suggestion.trigger}</Badge>
                  <p className="text-sm font-semibold">{suggestion.title}</p>
                  <p className="mt-1 text-xs text-muted-foreground">Topic: {suggestion.topic}</p>
                  {suggestion.thumbnailText && (
                    <p className="mt-1 text-xs">Thumbnail text: <span className="font-medium">“{suggestion.thumbnailText}”</span></p>
                  )}
                  <p className="mt-2 text-xs leading-relaxed text-muted-foreground">{suggestion.why}</p>
                  <Button
                    size="sm"
                    variant="ghost"
                    className="mt-2"
                    onClick={() => setTopic(suggestion.topic)}
                    data-testid={`button-use-topic-${index}`}
                  >
                    Use as working topic
                  </Button>
                </div>
              ))}
            </div>
          )}
        </CardContent>
      </Card>

      <Card data-testid="packaging-studio">
        <CardHeader className="pb-3">
          <CardTitle className="text-base">Packaging studio</CardTitle>
          <CardDescription>
            Three complete packages: title + thumbnail born together, each on a different psychological trigger. Renders with Gemini, and exports the exact JSON spec for GPT Image 2 re-rendering.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="space-y-1.5">
            <Label htmlFor="lab-angle">Angle notes (optional)</Label>
            <Textarea
              id="lab-angle"
              value={angle}
              maxLength={2000}
              placeholder="Anything the packages must respect: your promise, the payoff, what to avoid..."
              onChange={(event) => setAngle(event.target.value)}
              className="min-h-20"
              data-testid="input-lab-angle"
            />
          </div>

          <div className="space-y-2">
            <Label>Your photo as the subject (up to 3 reference images)</Label>
            <div className="flex flex-wrap items-center gap-3">
              {faceRefs.map((image, index) => (
                <div key={index} className="relative">
                  <img src={image} alt={index === 0 ? "Subject reference" : "Style reference"} className="h-16 w-auto rounded-md object-cover" />
                  <Badge variant="secondary" className="absolute -bottom-2 left-1 text-[10px]">{index === 0 ? "subject" : "style"}</Badge>
                  <button
                    type="button"
                    onClick={() => setFaceRefs((current) => current.filter((_, i) => i !== index))}
                    aria-label="Remove reference image"
                    className="absolute -right-2 -top-2 rounded-full bg-black/80 p-1 text-white"
                  >
                    <X className="h-3 w-3" />
                  </button>
                </div>
              ))}
              {faceRefs.length < 3 && (
                <label className="flex h-16 w-28 cursor-pointer items-center justify-center rounded-md border border-dashed border-border text-xs text-muted-foreground hover:bg-accent">
                  Add image
                  <input
                    type="file"
                    accept="image/png,image/jpeg"
                    multiple
                    className="hidden"
                    onChange={(event) => {
                      void onFaceUpload(event.target.files);
                      event.target.value = "";
                    }}
                    data-testid="input-face-upload"
                  />
                </label>
              )}
            </div>
            {uploadError && <p className="text-xs text-destructive">{uploadError}</p>}
            {faceRefs.length > 0 && (
              <div className="flex items-center gap-2">
                <Checkbox
                  id="lab-rights"
                  checked={rightsConfirmed}
                  onCheckedChange={(checked) => setRightsConfirmed(checked === true)}
                  data-testid="checkbox-lab-rights"
                />
                <Label htmlFor="lab-rights" className="text-xs font-normal text-muted-foreground">
                  I have permission to use every uploaded reference image.
                </Label>
              </div>
            )}
          </div>

          <Button
            onClick={() => void runConcepts()}
            disabled={conceptsLoading || (faceRefs.length > 0 && !rightsConfirmed)}
            data-testid="button-generate-concepts"
          >
            {conceptsLoading ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Sparkles className="mr-2 h-4 w-4" />}
            Generate 3 packaging concepts
          </Button>
          {conceptsError && <FailureNote failure={conceptsError} />}

          {concepts.length > 0 && (
            <div className="grid gap-4 lg:grid-cols-3">
              {concepts.map((concept) => {
                const render = renders[concept.id];
                return (
                  <div key={concept.id} className="flex flex-col rounded-lg border border-border" data-testid={`concept-${concept.id}`}>
                    <div className="flex aspect-video items-center justify-center overflow-hidden rounded-t-lg bg-muted">
                      {render?.loading ? (
                        <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
                      ) : render?.imageData ? (
                        <img src={render.imageData} alt={concept.title} className="h-full w-full object-cover" />
                      ) : (
                        <p className="px-4 text-center text-xs text-muted-foreground">Not rendered yet</p>
                      )}
                    </div>
                    <div className="flex flex-1 flex-col gap-2 p-3">
                      <Badge variant="secondary" className="self-start">{concept.trigger}</Badge>
                      <p className="text-sm font-semibold leading-snug">{concept.title}</p>
                      {concept.thumbnailText && (
                        <p className="text-xs">Thumbnail text: <span className="font-medium">“{concept.thumbnailText}”</span></p>
                      )}
                      <p className="text-xs leading-relaxed text-muted-foreground">{concept.rationale}</p>
                      <p className="text-xs leading-relaxed text-muted-foreground"><span className="font-medium">Synergy:</span> {concept.synergyNote}</p>
                      {render?.error && <FailureNote failure={render.error} />}
                      {render?.model && <p className="text-[10px] text-muted-foreground">{render.model}</p>}
                      <div className="mt-auto flex flex-wrap gap-2 pt-2">
                        <Button size="sm" onClick={() => void renderConcept(concept)} disabled={render?.loading} data-testid={`button-render-${concept.id}`}>
                          {render?.loading ? <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" /> : <Wand2 className="mr-1.5 h-3.5 w-3.5" />}
                          {render?.imageData ? "Re-render" : "Render"}
                        </Button>
                        <Button size="sm" variant="outline" onClick={() => void copyConceptJson(concept)} data-testid={`button-copy-json-${concept.id}`}>
                          <Copy className="mr-1.5 h-3.5 w-3.5" />
                          {copiedId === concept.id ? "Copied!" : "GPT Image JSON"}
                        </Button>
                        {render?.imageData && (
                          <Button size="sm" variant="outline" onClick={() => downloadRender(concept)} data-testid={`button-download-${concept.id}`}>
                            <Download className="mr-1.5 h-3.5 w-3.5" />
                            Save
                          </Button>
                        )}
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
          {concepts.length > 0 && (
            <Button
              variant="outline"
              onClick={() => concepts.forEach((concept) => void renderConcept(concept))}
              disabled={concepts.some((concept) => renders[concept.id]?.loading)}
              data-testid="button-render-all"
            >
              <Wand2 className="mr-2 h-4 w-4" />
              Render all three
            </Button>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
