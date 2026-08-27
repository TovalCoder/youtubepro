import { z } from "zod";
import { searchFiltersSchema } from "@shared/schema";
import { labLaneSchema } from "@shared/lab";
import { thumbnailReferenceImageSchema } from "./thumbnail-contract";

// Thumbnail Lab request contracts. The Lab deliberately carries none of the
// packaging-integrity restrictions used by the legacy Thumbnail Creator: the
// creator owns those judgment calls here.

export const labSearchRequestSchema = z.object({
  lane: labLaneSchema,
  filters: searchFiltersSchema,
  // Pages of 50 to fetch. Each page is one billable YouTube search call, so
  // the caller chooses the depth rather than the server assuming it.
  pages: z.number().int().min(1).max(6).default(2),
  // Mirrors the client's recency filter so the window is applied inside the
  // YouTube query instead of only to what relevance ranking happened to return.
  publishedWithinDays: z.number().min(1).max(3_650).nullable().default(null),
}).strict();

export const labSeedsRequestSchema = z.object({
  niche: z.string().trim().min(1).max(200),
  avoid: z.array(z.string().trim().min(1).max(200)).max(24).default([]),
  count: z.number().int().min(3).max(8).default(6),
}).strict();

export const labReferenceSchema = z.object({
  videoId: z.string().trim().min(1).max(128),
  title: z.string().trim().min(1).max(500),
  channelTitle: z.string().trim().min(1).max(200),
  thumbnailUrl: z.string().url().max(2_048),
  lane: labLaneSchema.optional(),
  viewCount: z.number().nonnegative().optional(),
  subscriberCount: z.number().nonnegative().optional(),
  outlierScore: z.number().nonnegative().nullable().optional(),
  viewsPerHour: z.number().nonnegative().nullable().optional(),
  publishedAt: z.string().trim().max(64).optional(),
}).strict();

export type LabReference = z.infer<typeof labReferenceSchema>;

export const labAnalyzeRequestSchema = z.object({
  topic: z.string().trim().min(1).max(200),
  references: z.array(labReferenceSchema).min(1).max(12),
}).strict();

export const labConceptsRequestSchema = z.object({
  topic: z.string().trim().min(1).max(200),
  angle: z.string().trim().max(2_000).default(""),
  patternSynthesis: z.string().trim().max(30_000).default(""),
  referenceImages: z.array(thumbnailReferenceImageSchema).max(3).default([]),
  referenceRightsConfirmed: z.boolean().default(false),
  includeSwipeFile: z.boolean().default(true),
}).strict().superRefine((request, ctx) => {
  if (request.referenceImages.length > 0 && !request.referenceRightsConfirmed) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["referenceRightsConfirmed"],
      message: "Confirm that you have permission to use every reference image",
    });
  }
});

const IMAGE_SPEC_MAX_JSON_CHARS = 8_000;

export const labRenderRequestSchema = z.object({
  title: z.string().trim().min(1).max(200),
  thumbnailText: z.string().trim().max(60).default(""),
  imageSpec: z.record(z.unknown()),
  referenceImages: z.array(thumbnailReferenceImageSchema).max(3).default([]),
  referenceRightsConfirmed: z.boolean().default(false),
}).strict().superRefine((request, ctx) => {
  if (JSON.stringify(request.imageSpec).length > IMAGE_SPEC_MAX_JSON_CHARS) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["imageSpec"],
      message: `Image spec JSON must stay under ${IMAGE_SPEC_MAX_JSON_CHARS} characters`,
    });
  }
  if (request.referenceImages.length > 0 && !request.referenceRightsConfirmed) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["referenceRightsConfirmed"],
      message: "Confirm that you have permission to use every reference image",
    });
  }
});

export const labTopicsRequestSchema = z.object({
  mode: z.enum(["refine", "suggest"]),
  niche: z.string().trim().min(1).max(200),
  topic: z.string().trim().max(200).default(""),
  evidence: z.string().trim().max(30_000).default(""),
}).strict().superRefine((request, ctx) => {
  if (request.mode === "refine" && !request.topic) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["topic"],
      message: "Refine mode needs the topic to refine",
    });
  }
});

// ---- Gemini output contracts ----

export const labSeedSchema = z.object({
  topic: z.string().trim().min(1).max(200),
  why: z.string().trim().min(1).max(500),
}).strict();

export const labSeedsOutputSchema = z.array(labSeedSchema).min(3).max(8);

export const labPatternReferenceReportSchema = z.object({
  videoId: z.string().trim().min(1).max(128),
  trigger: z.string().trim().min(1).max(120),
  triggerExecution: z.string().trim().min(1).max(1_000),
  elementCount: z.number().int().min(1).max(12),
  focalPoint: z.string().trim().min(1).max(500),
  separationTechnique: z.string().trim().min(1).max(500),
  textInThumbnail: z.string().trim().max(200),
  titleSynergy: z.string().trim().min(1).max(1_000),
  emotion: z.string().trim().min(1).max(300),
  colorStrategy: z.string().trim().min(1).max(500),
  clickReason: z.string().trim().min(1).max(1_000),
  skyscraperPattern: z.string().trim().min(1).max(1_000),
}).strict();

export const labPatternSynthesisSchema = z.object({
  repeatedPatterns: z.array(z.object({
    pattern: z.string().trim().min(1).max(500),
    evidence: z.string().trim().min(1).max(1_000),
  }).strict()).min(1).max(8),
  topicAdaptation: z.string().trim().min(1).max(3_000),
  packagingDirections: z.array(z.object({
    direction: z.string().trim().min(1).max(500),
    trigger: z.string().trim().min(1).max(120),
    why: z.string().trim().min(1).max(1_000),
  }).strict()).min(2).max(4),
}).strict();

export const labPatternReportSchema = z.object({
  references: z.array(labPatternReferenceReportSchema).min(1).max(12),
  synthesis: labPatternSynthesisSchema,
}).strict();

export type LabPatternReport = z.infer<typeof labPatternReportSchema>;

export const labConceptSchema = z.object({
  id: z.string().trim().min(1).max(64),
  trigger: z.string().trim().min(1).max(120),
  title: z.string().trim().min(1).max(160),
  thumbnailText: z.string().trim().max(60),
  rationale: z.string().trim().min(1).max(1_500),
  synergyNote: z.string().trim().min(1).max(1_000),
  imageSpec: z.record(z.unknown()),
}).strict();

export const labConceptsOutputSchema = z.array(labConceptSchema).length(3);

export type LabConcept = z.infer<typeof labConceptSchema>;

export const labTopicSuggestionSchema = z.object({
  topic: z.string().trim().min(1).max(300),
  title: z.string().trim().min(1).max(160),
  thumbnailText: z.string().trim().max(60),
  trigger: z.string().trim().min(1).max(120),
  why: z.string().trim().min(1).max(1_000),
}).strict();

export const labTopicsOutputSchema = z.array(labTopicSuggestionSchema).min(3).max(6);

// ---- Swipe file ----

export const swipeAnalyzeRequestSchema = z.object({
  fileNames: z.array(z.string().trim().min(1).max(260)).min(1).max(12),
  notes: z.record(z.string().trim().max(300)).default({}),
}).strict();

export const swipeNoteRequestSchema = z.object({
  id: z.string().trim().min(1).max(64),
  fileName: z.string().trim().min(1).max(260),
  note: z.string().trim().max(300),
}).strict();

export const swipeAnalysisSchema = z.object({
  trigger: z.string().trim().min(1).max(120),
  whyItWorks: z.string().trim().min(1).max(1_500),
  focalPoint: z.string().trim().min(1).max(500),
  separationTechnique: z.string().trim().min(1).max(500),
  textTreatment: z.string().trim().max(500),
  colorStrategy: z.string().trim().min(1).max(500),
  transferableTechnique: z.string().trim().min(1).max(1_000),
  stealThis: z.string().trim().min(1).max(500),
}).strict();

export const swipeAnalysisOutputSchema = z.object({
  fileName: z.string().trim().min(1).max(260),
  analysis: swipeAnalysisSchema,
}).strict();

export const swipeAnalysisListSchema = z.array(swipeAnalysisOutputSchema).min(1).max(12);
