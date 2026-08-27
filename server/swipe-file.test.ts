import assert from "node:assert/strict";
import path from "node:path";
import { describe, test } from "node:test";
import { resolveSwipeFile, summarizeSwipeLibrary, SWIPE_DIR, type SwipeEntry } from "./swipe-file";

function entry(overrides: Partial<SwipeEntry>): SwipeEntry {
  return {
    id: "abc123",
    fileName: "example.png",
    bytes: 1_024,
    modifiedAt: "2026-08-27T12:00:00.000Z",
    analyzed: false,
    note: "",
    analysis: null,
    ...overrides,
  };
}

describe("swipe file path safety", () => {
  test("accepts supported image names directly inside the folder", () => {
    for (const name of ["shot.png", "a.jpg", "b.JPEG", "c.webp"]) {
      const resolved = resolveSwipeFile(name);
      assert.ok(resolved, `${name} should resolve`);
      assert.equal(path.dirname(resolved.filePath), SWIPE_DIR);
    }
  });

  test("maps extensions to the right mime type", () => {
    assert.equal(resolveSwipeFile("a.png")?.mimeType, "image/png");
    assert.equal(resolveSwipeFile("a.jpg")?.mimeType, "image/jpeg");
    assert.equal(resolveSwipeFile("a.jpeg")?.mimeType, "image/jpeg");
    assert.equal(resolveSwipeFile("a.webp")?.mimeType, "image/webp");
  });

  test("refuses traversal, nesting, and absolute paths", () => {
    assert.equal(resolveSwipeFile("../.env"), null);
    assert.equal(resolveSwipeFile("../../secret.png"), null);
    assert.equal(resolveSwipeFile("nested/shot.png"), null);
    assert.equal(resolveSwipeFile("nested\\shot.png"), null);
    assert.equal(resolveSwipeFile("C:/Windows/system32/a.png"), null);
  });

  test("refuses unsupported types, dotfiles, empty names, and null bytes", () => {
    assert.equal(resolveSwipeFile("notes.txt"), null);
    assert.equal(resolveSwipeFile("script.svg"), null);
    assert.equal(resolveSwipeFile(".hidden.png"), null);
    assert.equal(resolveSwipeFile(""), null);
    assert.equal(resolveSwipeFile("shot.png\u0000.txt"), null);
  });
});

describe("swipe library summary", () => {
  const analysis = {
    trigger: "transformational",
    whyItWorks: "Shows the gap",
    focalPoint: "Split face",
    separationTechnique: "Hard rim light",
    textTreatment: "Two words, left",
    colorStrategy: "Warm vs cool halves",
    transferableTechnique: "Split-frame before and after with one number",
    stealThis: "Put the number on the after side only",
  };

  test("summarizes only analyzed entries", () => {
    const summary = summarizeSwipeLibrary([
      entry({ id: "1", analyzed: true, analysis }),
      entry({ id: "2", analyzed: false, analysis: null }),
    ]);
    assert.match(summary, /1 thumbnails/);
    assert.match(summary, /Split-frame before and after/);
    assert.match(summary, /steal: Put the number/);
  });

  test("includes the creator note when present", () => {
    const summary = summarizeSwipeLibrary([
      entry({ id: "1", analyzed: true, analysis, note: "loved the tension here" }),
    ]);
    assert.match(summary, /Creator note: loved the tension here/);
  });

  test("returns an empty string when nothing is analyzed", () => {
    assert.equal(summarizeSwipeLibrary([entry({})]), "");
    assert.equal(summarizeSwipeLibrary([]), "");
  });
});
