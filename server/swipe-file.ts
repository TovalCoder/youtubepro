import { createHash } from "node:crypto";
import { mkdir, readFile, readdir, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { ProviderError } from "./provider-errors";

// Personal swipe file: thumbnails the creator screenshotted while scrolling
// YouTube because their own eye judged them exceptional. That judgment is a
// signal no API produces, so these sit alongside API-discovered outliers as
// first-class reference material.
//
// Everything stays on disk in the workspace. Analyses are cached by file
// content hash, so re-scanning costs nothing and editing an image re-analyzes
// it automatically.

export const SWIPE_DIR = path.resolve(process.cwd(), "swipe-file");
const ANALYSIS_DIR = path.join(SWIPE_DIR, ".analysis");

const MAX_FILE_BYTES = 10 * 1024 * 1024;
const MAX_ENTRIES = 200;

const EXTENSION_MIME: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
};

const README = `# Swipe file

Drop thumbnails here that you spotted while scrolling YouTube and judged
exceptional. Screenshots are fine.

- Supported: .png, .jpg, .jpeg, .webp (up to 10 MB each)
- The filename is passed to the analyzer as context, so descriptive names help:
  "transformation-before-after-fitness.png" beats "Screenshot 2026-08-27.png".
- Open Thumbnail Lab and use "Scan folder" to pick up new files, then
  "Analyze new" to dissect them.
- Analyses are cached in .analysis/ by file content. Re-analysis only happens
  when an image actually changes.
- This folder is gitignored: screenshots of other creators' work stay on your
  machine and are never pushed.
`;

export interface SwipeEntry {
  id: string;
  fileName: string;
  bytes: number;
  modifiedAt: string;
  analyzed: boolean;
  note: string;
  analysis: SwipeAnalysis | null;
}

export interface SwipeAnalysis {
  trigger: string;
  whyItWorks: string;
  focalPoint: string;
  separationTechnique: string;
  textTreatment: string;
  colorStrategy: string;
  transferableTechnique: string;
  stealThis: string;
}

interface SidecarRecord {
  fileName: string;
  note: string;
  analysis: SwipeAnalysis;
  analyzedAt: string;
}

export async function ensureSwipeDir(): Promise<void> {
  await mkdir(ANALYSIS_DIR, { recursive: true });
  const readmePath = path.join(SWIPE_DIR, "README.md");
  try {
    await stat(readmePath);
  } catch {
    await writeFile(readmePath, README, "utf8");
  }
}

// Resolves a caller-supplied file name to a path inside the swipe directory,
// refusing anything that escapes it or names an unsupported type.
export function resolveSwipeFile(fileName: string): { filePath: string; mimeType: string } | null {
  if (!fileName || fileName.includes("\0")) return null;
  const base = path.basename(fileName);
  if (base !== fileName || base.startsWith(".")) return null;
  const mimeType = EXTENSION_MIME[path.extname(base).toLowerCase()];
  if (!mimeType) return null;
  const filePath = path.join(SWIPE_DIR, base);
  const relative = path.relative(SWIPE_DIR, filePath);
  if (relative.startsWith("..") || path.isAbsolute(relative)) return null;
  return { filePath, mimeType };
}

function sidecarPathFor(id: string): string {
  return path.join(ANALYSIS_DIR, `${id}.json`);
}

async function readSidecar(id: string): Promise<SidecarRecord | null> {
  try {
    const raw = await readFile(sidecarPathFor(id), "utf8");
    const parsed = JSON.parse(raw) as SidecarRecord;
    return parsed?.analysis ? parsed : null;
  } catch {
    return null;
  }
}

export async function hashSwipeFile(filePath: string): Promise<string> {
  const buffer = await readFile(filePath);
  return createHash("sha256").update(buffer).digest("hex").slice(0, 32);
}

export async function listSwipeEntries(): Promise<SwipeEntry[]> {
  await ensureSwipeDir();
  let names: string[];
  try {
    names = await readdir(SWIPE_DIR);
  } catch {
    return [];
  }

  const entries: SwipeEntry[] = [];
  for (const name of names.sort()) {
    if (entries.length >= MAX_ENTRIES) break;
    const resolved = resolveSwipeFile(name);
    if (!resolved) continue;
    let fileStat;
    try {
      fileStat = await stat(resolved.filePath);
    } catch {
      continue;
    }
    if (!fileStat.isFile() || fileStat.size === 0 || fileStat.size > MAX_FILE_BYTES) continue;

    const id = await hashSwipeFile(resolved.filePath);
    const sidecar = await readSidecar(id);
    entries.push({
      id,
      fileName: name,
      bytes: fileStat.size,
      modifiedAt: fileStat.mtime.toISOString(),
      analyzed: sidecar !== null,
      note: sidecar?.note ?? "",
      analysis: sidecar?.analysis ?? null,
    });
  }
  return entries;
}

export async function readSwipeImage(fileName: string): Promise<{ buffer: Buffer; mimeType: string }> {
  const resolved = resolveSwipeFile(fileName);
  if (!resolved) {
    throw new ProviderError({
      message: "That swipe file name is not valid.",
      category: "invalid_response",
      code: "SWIPE_INVALID_NAME",
      status: 400,
      retryable: false,
    });
  }
  const fileStat = await stat(resolved.filePath).catch(() => null);
  if (!fileStat?.isFile() || fileStat.size === 0 || fileStat.size > MAX_FILE_BYTES) {
    throw new ProviderError({
      message: "That swipe file could not be read.",
      category: "invalid_response",
      code: "SWIPE_UNREADABLE",
      status: 404,
      retryable: false,
    });
  }
  return { buffer: await readFile(resolved.filePath), mimeType: resolved.mimeType };
}

export async function saveSwipeAnalysis(
  id: string,
  fileName: string,
  note: string,
  analysis: SwipeAnalysis,
): Promise<void> {
  await ensureSwipeDir();
  const record: SidecarRecord = { fileName, note, analysis, analyzedAt: new Date().toISOString() };
  await writeFile(sidecarPathFor(id), JSON.stringify(record, null, 2), "utf8");
}

export async function saveSwipeNote(id: string, fileName: string, note: string): Promise<void> {
  const existing = await readSidecar(id);
  if (!existing) return;
  await saveSwipeAnalysis(id, fileName, note, existing.analysis);
}

// Compact library summary fed into concept generation, so the creator's own
// taste steers packaging alongside API-discovered outliers.
export function summarizeSwipeLibrary(entries: SwipeEntry[]): string {
  const analyzed = entries.filter((entry) => entry.analysis !== null);
  if (analyzed.length === 0) return "";
  const lines = analyzed.map((entry) => {
    const analysis = entry.analysis as SwipeAnalysis;
    const note = entry.note ? ` | Creator note: ${entry.note}` : "";
    return `- [${analysis.trigger}] ${analysis.transferableTechnique} (steal: ${analysis.stealThis})${note}`;
  });
  return `Creator's personal swipe file (${analyzed.length} thumbnails they judged exceptional while scrolling):\n${lines.join("\n")}`;
}
