import type { Express } from "express";
import { createServer, type Server } from "http";
import { searchVideos } from "./youtube";
import { generateScript, generateIdeas, generateResearchInsights, regenerateTitles, regenerateSection, regenerateParagraph, generateThumbnail, generateThumbnailSuggestions, extractNarrationText } from "./gemini";
import { ideaGenerationRequestSchema, researchInsightsRequestSchema, searchFiltersSchema, scriptInputSchema } from "@shared/schema";
import { z } from "zod";
import { apiKeySettingsSchema, getApiKeyStatus, isLocalSettingsRequest, saveApiKeySettings } from "./settings";
import { normalizeProviderError, providerErrorPayload } from "./provider-errors";
import { thumbnailGenerationRequestSchema, thumbnailSuggestionsRequestSchema } from "./thumbnail-contract";
import {
  paragraphRegenerationRequestSchema,
  sectionRegenerationRequestSchema,
} from "./script-regeneration-contract";
import {
  narrationExtractionRequestSchema,
  titleRegenerationRequestSchema,
} from "./api-contracts";
import { createRateLimiter } from "./rate-limit";
import {
  labAnalyzeRequestSchema,
  labConceptsRequestSchema,
  labRenderRequestSchema,
  labSearchRequestSchema,
  labSeedsRequestSchema,
  labTopicsRequestSchema,
  swipeAnalyzeRequestSchema,
  swipeNoteRequestSchema,
} from "./lab-contracts";
import {
  hashSwipeFile,
  listSwipeEntries,
  readSwipeImage,
  resolveSwipeFile,
  saveSwipeAnalysis,
  saveSwipeNote,
  summarizeSwipeLibrary,
  SWIPE_DIR,
} from "./swipe-file";
import { scoreVideosForLab } from "./outlier";
import {
  analyzeSwipeThumbnails,
  analyzeThumbnailPatterns,
  generateLabTopics,
  generatePackagingConcepts,
  generateWildcardSeeds,
  renderLabConcept,
} from "./thumbnail-lab";

const { middleware: rateLimit } = createRateLimiter();

function getUserFriendlyError(error: any, context: string): { message: string; suggestion: string } {
  const errorMessage = error?.message?.toLowerCase() || "";

  if (errorMessage.includes("api key") || errorMessage.includes("authentication") || errorMessage.includes("unauthorized")) {
    return {
      message: `${context} is temporarily unavailable`,
      suggestion: "Please try again in a moment. If the problem persists, contact support."
    };
  }

  if (errorMessage.includes("rate limit") || errorMessage.includes("quota") || errorMessage.includes("too many")) {
    return {
      message: `${context} is experiencing high demand`,
      suggestion: "Please wait a minute and try again."
    };
  }

  if (errorMessage.includes("timeout") || errorMessage.includes("timed out") || errorMessage.includes("network")) {
    return {
      message: `${context} took too long to respond`,
      suggestion: "Please check your connection and try again."
    };
  }

  if (errorMessage.includes("content") || errorMessage.includes("safety") || errorMessage.includes("blocked")) {
    return {
      message: `${context} couldn't process this content`,
      suggestion: "Try rephrasing your request or using different keywords."
    };
  }

  return {
    message: `${context} encountered an issue`,
    suggestion: "Please try again. If the problem persists, try refreshing the page."
  };
}

export async function registerRoutes(
  httpServer: Server,
  app: Express
): Promise<Server> {
  app.get("/api/settings/status", (req, res) => {
    res.setHeader("Cache-Control", "no-store");
    if (!isLocalSettingsRequest(req)) {
      return res.status(403).json({ error: "Settings are available only from this machine." });
    }
    return res.json(getApiKeyStatus());
  });

  app.put("/api/settings/api-keys", async (req, res) => {
    res.setHeader("Cache-Control", "no-store");
    if (!isLocalSettingsRequest(req)) {
      return res.status(403).json({ error: "Settings are available only from this machine." });
    }

    try {
      const input = apiKeySettingsSchema.parse(req.body);
      const status = await saveApiKeySettings(input);
      return res.json({ success: true, status });
    } catch (error: any) {
      return res.status(400).json({
        error: error?.message || "Unable to save API settings.",
      });
    }
  });

  app.get("/api/youtube/search", rateLimit, async (req, res) => {
    try {
      const { query, uploadDate, duration, sortBy, maxResults } = req.query;

      if (!query || typeof query !== "string") {
        return res.status(400).json({ error: "Query parameter is required" });
      }

      const filters = searchFiltersSchema.parse({
        query,
        uploadDate: uploadDate || "any",
        duration: duration || "any",
        sortBy: sortBy || "relevance",
        maxResults: maxResults ? parseInt(maxResults as string, 10) : 25,
      });

      const result = await searchVideos(filters);
      res.json(result);
    } catch (error: any) {
      console.error("YouTube search error:", error);
      if (error instanceof z.ZodError) {
        return res.status(400).json({ error: "Invalid search parameters", details: error.errors });
      }
      const providerError = normalizeProviderError(error, "youtube");
      res.status(providerError.status).json(providerErrorPayload(providerError, "YouTube Data API"));
    }
  });

  app.post("/api/script/generate", rateLimit, async (req, res) => {
    try {
      const input = scriptInputSchema.parse(req.body);
      const result = await generateScript(input);
      res.json(result);
    } catch (error: any) {
      console.error("Script generation error:", error);
      if (error instanceof z.ZodError) {
        return res.status(400).json({ error: "Invalid script input", details: error.errors });
      }
      const friendly = getUserFriendlyError(error, "Script generation");
      res.status(500).json({ error: friendly.message, suggestion: friendly.suggestion });
    }
  });

  app.post("/api/script/extract-narration", rateLimit, async (req, res) => {
    try {
      const { scriptContent } = narrationExtractionRequestSchema.parse(req.body);
      const narration = await extractNarrationText(scriptContent);
      res.json({ narration });
    } catch (error: any) {
      console.error("Narration extraction error:", error);
      if (error instanceof z.ZodError) {
        return res.status(400).json({ error: "Invalid narration extraction request", details: error.errors });
      }
      const friendly = getUserFriendlyError(error, "Narration extraction");
      res.status(500).json({ error: friendly.message, suggestion: friendly.suggestion });
    }
  });

  app.post("/api/ideas/generate", rateLimit, async (req, res) => {
    try {
      const parsed = ideaGenerationRequestSchema.safeParse(req.body);
      if (!parsed.success) {
        return res.status(400).json({ error: "Invalid grounded idea request", details: parsed.error.errors });
      }

      const result = await generateIdeas(parsed.data);
      res.json(result);
    } catch (error: unknown) {
      console.error("Ideas generation error:", error);
      const providerError = normalizeProviderError(error, "gemini");
      res.status(providerError.status).json(providerErrorPayload(providerError, "Gemini Ideas"));
    }
  });

  app.post("/api/research/insights", rateLimit, async (req, res) => {
    try {
      const parsed = researchInsightsRequestSchema.safeParse(req.body);

      if (!parsed.success) {
        return res.status(400).json({
          error: "A query and between 1 and 50 valid videos are required.",
          code: "RESEARCH_REQUEST_INVALID",
          details: parsed.error.errors,
        });
      }

      const result = await generateResearchInsights(parsed.data);
      res.json(result);
    } catch (error: unknown) {
      console.error("Research insights error:", error);
      const providerError = normalizeProviderError(error, "gemini");
      res.status(providerError.status).json(providerErrorPayload(providerError, "Gemini research"));
    }
  });

  app.post("/api/script/regenerate-titles", rateLimit, async (req, res) => {
    try {
      const { topic, format, audience, evidenceContext } = titleRegenerationRequestSchema.parse(req.body);
      const titles = await regenerateTitles(
        topic,
        format,
        audience,
        evidenceContext,
      );
      res.json({ titles });
    } catch (error: any) {
      console.error("Title regeneration error:", error);
      if (error instanceof z.ZodError) {
        return res.status(400).json({ error: "Invalid title regeneration request", details: error.errors });
      }
      const friendly = getUserFriendlyError(error, "Title regeneration");
      res.status(500).json({ error: friendly.message, suggestion: friendly.suggestion });
    }
  });

  app.post("/api/script/regenerate-section", rateLimit, async (req, res) => {
    try {
      const parsed = sectionRegenerationRequestSchema.safeParse(req.body);
      if (!parsed.success) {
        return res.status(400).json({
          error: "Invalid section regeneration request",
          code: "SCRIPT_SECTION_REGENERATION_REQUEST_INVALID",
          category: "invalid_response",
          retryable: false,
          suggestion: "Keep the current section and review its topic, format, audience, and evidence context.",
          details: parsed.error.flatten(),
        });
      }

      const result = await regenerateSection(parsed.data);
      res.json(result);
    } catch (error: unknown) {
      console.error("Section regeneration error:", error);
      const providerError = normalizeProviderError(error, "gemini");
      res.status(providerError.status).json(providerErrorPayload(providerError, "Gemini section regeneration"));
    }
  });

  app.post("/api/script/regenerate-paragraph", rateLimit, async (req, res) => {
    try {
      const parsed = paragraphRegenerationRequestSchema.safeParse(req.body);
      if (!parsed.success) {
        return res.status(400).json({
          error: "Invalid paragraph regeneration request",
          code: "SCRIPT_PARAGRAPH_REGENERATION_REQUEST_INVALID",
          category: "invalid_response",
          retryable: false,
          suggestion: "Keep the current paragraph and review its section, topic, format, audience, and evidence context.",
          details: parsed.error.flatten(),
        });
      }

      const result = await regenerateParagraph(parsed.data);
      res.json(result);
    } catch (error: unknown) {
      console.error("Paragraph regeneration error:", error);
      const providerError = normalizeProviderError(error, "gemini");
      res.status(providerError.status).json(providerErrorPayload(providerError, "Gemini paragraph regeneration"));
    }
  });

  app.post("/api/thumbnail/generate", rateLimit, async (req, res) => {
    try {
      const parsed = thumbnailGenerationRequestSchema.safeParse(req.body);
      if (!parsed.success) {
        return res.status(400).json({
          error: "Invalid thumbnail generation request",
          code: "THUMBNAIL_REQUEST_INVALID",
          category: "invalid_response",
          retryable: false,
          suggestion: "Review the thumbnail fields and reference image requirements, then try again.",
          details: parsed.error.flatten(),
        });
      }

      const { topic, ...config } = parsed.data;
      const result = await generateThumbnail(topic, config);
      res.json(result);
    } catch (error: unknown) {
      console.error("Thumbnail generation error:", error);
      const providerError = normalizeProviderError(error, "gemini");
      res.status(providerError.status).json(providerErrorPayload(providerError, "Gemini image generation"));
    }
  });

  app.post("/api/thumbnail/suggestions", rateLimit, async (req, res) => {
    try {
      const parsed = thumbnailSuggestionsRequestSchema.safeParse(req.body);
      if (!parsed.success) {
        return res.status(400).json({
          error: "Invalid thumbnail suggestions request",
          code: "THUMBNAIL_SUGGESTIONS_REQUEST_INVALID",
          category: "invalid_response",
          retryable: false,
          suggestion: "Add a valid topic and shorten any supplied idea context.",
          details: parsed.error.flatten(),
        });
      }

      const suggestions = await generateThumbnailSuggestions(parsed.data);
      res.json({ suggestions });
    } catch (error: unknown) {
      console.error("Thumbnail suggestions error:", error);
      const providerError = normalizeProviderError(error, "gemini");
      res.status(providerError.status).json(providerErrorPayload(providerError, "Gemini thumbnail suggestions"));
    }
  });

  app.post("/api/lab/search", rateLimit, async (req, res) => {
    try {
      const parsed = labSearchRequestSchema.safeParse(req.body);
      if (!parsed.success) {
        return res.status(400).json({
          error: "Invalid lab search request",
          code: "LAB_SEARCH_REQUEST_INVALID",
          category: "invalid_response",
          retryable: false,
          suggestion: "Review the lane and search filters, then try again.",
          details: parsed.error.flatten(),
        });
      }
      const search = await searchVideos(parsed.data.filters);
      const scores = await scoreVideosForLab(search.videos);
      res.json({ lane: parsed.data.lane, search, scores });
    } catch (error: unknown) {
      console.error("Lab search error:", error);
      const providerError = normalizeProviderError(error, "youtube");
      res.status(providerError.status).json(providerErrorPayload(providerError, "Lab outlier search"));
    }
  });

  app.post("/api/lab/seeds", rateLimit, async (req, res) => {
    try {
      const parsed = labSeedsRequestSchema.safeParse(req.body);
      if (!parsed.success) {
        return res.status(400).json({
          error: "Invalid wildcard seed request",
          code: "LAB_SEEDS_REQUEST_INVALID",
          category: "invalid_response",
          retryable: false,
          suggestion: "Provide your niche so unrelated seed topics can be proposed.",
          details: parsed.error.flatten(),
        });
      }
      const seeds = await generateWildcardSeeds(parsed.data.niche, parsed.data.avoid, parsed.data.count);
      res.json({ seeds });
    } catch (error: unknown) {
      console.error("Lab seeds error:", error);
      const providerError = normalizeProviderError(error, "gemini");
      res.status(providerError.status).json(providerErrorPayload(providerError, "Lab wildcard seeds"));
    }
  });

  app.post("/api/lab/analyze", rateLimit, async (req, res) => {
    try {
      const parsed = labAnalyzeRequestSchema.safeParse(req.body);
      if (!parsed.success) {
        return res.status(400).json({
          error: "Invalid pattern analysis request",
          code: "LAB_ANALYZE_REQUEST_INVALID",
          category: "invalid_response",
          retryable: false,
          suggestion: "Select between 1 and 12 reference thumbnails and set a topic.",
          details: parsed.error.flatten(),
        });
      }
      const result = await analyzeThumbnailPatterns(parsed.data.topic, parsed.data.references);
      res.json(result);
    } catch (error: unknown) {
      console.error("Lab analyze error:", error);
      const providerError = normalizeProviderError(error, "gemini");
      res.status(providerError.status).json(providerErrorPayload(providerError, "Lab pattern analysis"));
    }
  });

  app.post("/api/lab/concepts", rateLimit, async (req, res) => {
    try {
      const parsed = labConceptsRequestSchema.safeParse(req.body);
      if (!parsed.success) {
        return res.status(400).json({
          error: "Invalid packaging concepts request",
          code: "LAB_CONCEPTS_REQUEST_INVALID",
          category: "invalid_response",
          retryable: false,
          suggestion: "Set a topic, and confirm rights for any uploaded reference images.",
          details: parsed.error.flatten(),
        });
      }
      const swipeSummary = parsed.data.includeSwipeFile
        ? summarizeSwipeLibrary(await listSwipeEntries())
        : "";
      const combinedEvidence = [parsed.data.patternSynthesis, swipeSummary]
        .filter((part) => part.trim().length > 0)
        .join("\n\n");
      const concepts = await generatePackagingConcepts(
        parsed.data.topic,
        parsed.data.angle,
        combinedEvidence,
        parsed.data.referenceImages.length > 0,
      );
      res.json({ concepts });
    } catch (error: unknown) {
      console.error("Lab concepts error:", error);
      const providerError = normalizeProviderError(error, "gemini");
      res.status(providerError.status).json(providerErrorPayload(providerError, "Lab packaging concepts"));
    }
  });

  app.post("/api/lab/render", rateLimit, async (req, res) => {
    try {
      const parsed = labRenderRequestSchema.safeParse(req.body);
      if (!parsed.success) {
        return res.status(400).json({
          error: "Invalid render request",
          code: "LAB_RENDER_REQUEST_INVALID",
          category: "invalid_response",
          retryable: false,
          suggestion: "Render a generated concept, and confirm rights for any uploaded reference images.",
          details: parsed.error.flatten(),
        });
      }
      const result = await renderLabConcept(
        parsed.data.title,
        parsed.data.thumbnailText,
        parsed.data.imageSpec,
        parsed.data.referenceImages,
      );
      res.json(result);
    } catch (error: unknown) {
      console.error("Lab render error:", error);
      const providerError = normalizeProviderError(error, "gemini");
      res.status(providerError.status).json(providerErrorPayload(providerError, "Lab thumbnail render"));
    }
  });

  app.post("/api/lab/topics", rateLimit, async (req, res) => {
    try {
      const parsed = labTopicsRequestSchema.safeParse(req.body);
      if (!parsed.success) {
        return res.status(400).json({
          error: "Invalid topic request",
          code: "LAB_TOPICS_REQUEST_INVALID",
          category: "invalid_response",
          retryable: false,
          suggestion: "Set your niche, and include the topic when refining one.",
          details: parsed.error.flatten(),
        });
      }
      const suggestions = await generateLabTopics(
        parsed.data.mode,
        parsed.data.niche,
        parsed.data.topic,
        parsed.data.evidence,
      );
      res.json({ suggestions });
    } catch (error: unknown) {
      console.error("Lab topics error:", error);
      const providerError = normalizeProviderError(error, "gemini");
      res.status(providerError.status).json(providerErrorPayload(providerError, "Lab topic packages"));
    }
  });

  app.get("/api/lab/swipe", async (_req, res) => {
    try {
      const entries = await listSwipeEntries();
      res.json({ entries, folder: SWIPE_DIR });
    } catch (error: unknown) {
      console.error("Swipe list error:", error);
      const providerError = normalizeProviderError(error, "youtube");
      res.status(providerError.status).json(providerErrorPayload(providerError, "Swipe file listing"));
    }
  });

  app.get("/api/lab/swipe/image", async (req, res) => {
    try {
      const fileName = typeof req.query.file === "string" ? req.query.file : "";
      const { buffer, mimeType } = await readSwipeImage(fileName);
      res.setHeader("Content-Type", mimeType);
      res.setHeader("Cache-Control", "no-store");
      res.send(buffer);
    } catch (error: unknown) {
      const providerError = normalizeProviderError(error, "youtube");
      res.status(providerError.status).json(providerErrorPayload(providerError, "Swipe file image"));
    }
  });

  app.post("/api/lab/swipe/analyze", rateLimit, async (req, res) => {
    try {
      const parsed = swipeAnalyzeRequestSchema.safeParse(req.body);
      if (!parsed.success) {
        return res.status(400).json({
          error: "Invalid swipe analysis request",
          code: "SWIPE_ANALYZE_REQUEST_INVALID",
          category: "invalid_response",
          retryable: false,
          suggestion: "Select between 1 and 12 swipe files to analyze.",
          details: parsed.error.flatten(),
        });
      }

      const inputs = [];
      for (const fileName of parsed.data.fileNames) {
        const resolved = resolveSwipeFile(fileName);
        if (!resolved) continue;
        const { buffer, mimeType } = await readSwipeImage(fileName);
        inputs.push({
          fileName,
          note: parsed.data.notes[fileName] || "",
          mimeType,
          data: buffer.toString("base64"),
          id: await hashSwipeFile(resolved.filePath),
        });
      }
      if (inputs.length === 0) {
        return res.status(400).json({
          error: "No readable swipe files were selected",
          code: "SWIPE_NO_READABLE_FILES",
          category: "invalid_response",
          retryable: false,
          suggestion: "Add PNG, JPEG, or WebP thumbnails to the swipe-file folder and scan again.",
        });
      }

      const results = await analyzeSwipeThumbnails(
        inputs.map(({ fileName, note, mimeType, data }) => ({ fileName, note, mimeType, data })),
      );
      const byName = new Map(inputs.map((input) => [input.fileName, input]));
      for (const result of results) {
        const input = byName.get(result.fileName);
        if (!input) continue;
        await saveSwipeAnalysis(input.id, input.fileName, input.note, result.analysis as any);
      }

      const entries = await listSwipeEntries();
      res.json({ entries, analyzed: results.length });
    } catch (error: unknown) {
      console.error("Swipe analyze error:", error);
      const providerError = normalizeProviderError(error, "gemini");
      res.status(providerError.status).json(providerErrorPayload(providerError, "Swipe file analysis"));
    }
  });

  app.post("/api/lab/swipe/note", async (req, res) => {
    try {
      const parsed = swipeNoteRequestSchema.safeParse(req.body);
      if (!parsed.success) {
        return res.status(400).json({
          error: "Invalid swipe note request",
          code: "SWIPE_NOTE_REQUEST_INVALID",
          category: "invalid_response",
          retryable: false,
          suggestion: "Keep the note under 300 characters.",
          details: parsed.error.flatten(),
        });
      }
      await saveSwipeNote(parsed.data.id, parsed.data.fileName, parsed.data.note);
      res.json({ success: true });
    } catch (error: unknown) {
      const providerError = normalizeProviderError(error, "youtube");
      res.status(providerError.status).json(providerErrorPayload(providerError, "Swipe file note"));
    }
  });

  return httpServer;
}
