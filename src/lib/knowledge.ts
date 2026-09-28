import fs from "node:fs";
import path from "node:path";
import type Anthropic from "@anthropic-ai/sdk";

const CONTENT_DIR = path.join(process.cwd(), "content");

export type KnowledgeDoc = {
  /** Path relative to content/, e.g. "projects/portfolio-agent.md". */
  source: string;
  title: string;
  text: string;
};

function listMarkdownFiles(dir: string): string[] {
  return fs
    .readdirSync(dir, { withFileTypes: true })
    .filter((entry) => !entry.name.startsWith("_") && !entry.name.startsWith("."))
    .flatMap((entry) => {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) return listMarkdownFiles(full);
      return entry.name.endsWith(".md") ? [full] : [];
    })
    .sort(); // deterministic order keeps the prompt-cache prefix stable
}

function loadDocs(): KnowledgeDoc[] {
  return listMarkdownFiles(CONTENT_DIR).map((file) => {
    const raw = fs.readFileSync(file, "utf8");
    // HTML comments are notes for the site owner, not for the model.
    const text = raw.replace(/<!--[\s\S]*?-->/g, "").trim();
    const heading = text.match(/^#\s+(.+)$/m)?.[1]?.trim();
    const source = path.relative(CONTENT_DIR, file).split(path.sep).join("/");
    return { source, title: heading ?? source, text };
  });
}

let cached: KnowledgeDoc[] | null = null;

/** Knowledge base docs. Re-read on every call in development so edits show up without a restart. */
export function getKnowledgeDocs(): KnowledgeDoc[] {
  if (process.env.NODE_ENV !== "production") return loadDocs();
  cached ??= loadDocs();
  return cached;
}

/** The knowledge base as citable document blocks, with a cache breakpoint after the last one. */
export function toDocumentBlocks(
  docs: KnowledgeDoc[],
): Anthropic.Beta.BetaRequestDocumentBlock[] {
  return docs.map((doc, i) => ({
    type: "document",
    source: { type: "text", media_type: "text/plain", data: doc.text },
    title: doc.title,
    citations: { enabled: true },
    ...(i === docs.length - 1 ? { cache_control: { type: "ephemeral" as const } } : {}),
  }));
}
