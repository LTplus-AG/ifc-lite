/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Prompt overlay storage helpers.
 *
 * The personal prompt overlay (RFC §06.4) is a small Markdown blob the
 * user owns that gets appended to the system prompt for every chat
 * turn. It's bounded — the spec sets a 4000-token soft cap. We do
 * token-counting cheaply (chars / 4 as a rough Claude/GPT estimate),
 * good enough for clamp + warn.
 *
 * Spec: docs/architecture/ai-customization/06-self-improvement.md §4.
 */

import type { PromptOverlay } from './types.js';

export interface OverlayClampOptions {
  /** Soft cap in tokens (chars/4 estimate). Default 4000. */
  maxTokens?: number;
  /** Hard cap in characters. Default 32000. */
  maxChars?: number;
  /** Optional clock for deterministic tests. */
  now?: () => Date;
}

export interface ClampedOverlay {
  overlay: PromptOverlay;
  /** True iff the input was longer than the cap and got truncated. */
  truncated: boolean;
  /** Estimated token count after clamping. */
  estimatedTokens: number;
}

const CHARS_PER_TOKEN = 4;
const DEFAULT_MAX_TOKENS = 4000;
const DEFAULT_MAX_CHARS = 32000;

/**
 * Normalise + clamp a prompt overlay before persisting. Trims trailing
 * whitespace, applies both caps (tokens and absolute chars), stamps
 * `updatedAt`.
 */
export function clampOverlay(content: string, opts: OverlayClampOptions = {}): ClampedOverlay {
  const maxTokens = opts.maxTokens ?? DEFAULT_MAX_TOKENS;
  const maxChars = opts.maxChars ?? DEFAULT_MAX_CHARS;
  const tokenLimitChars = maxTokens * CHARS_PER_TOKEN;
  const limit = Math.min(maxChars, tokenLimitChars);
  const trimmed = content.replace(/\s+$/g, '');
  const truncated = trimmed.length > limit;
  const final = truncated ? `${trimmed.slice(0, limit - 16).replace(/\s+$/g, '')}\n\n[truncated]` : trimmed;
  const now = (opts.now ?? (() => new Date()))().toISOString();
  return {
    overlay: { content: final, updatedAt: now },
    truncated,
    estimatedTokens: Math.ceil(final.length / CHARS_PER_TOKEN),
  };
}

/**
 * Produce a diff hint that the memory-extractor UI surfaces to the
 * user: highlight added paragraphs vs the previous overlay. Returns
 * { same, addedParagraphs, removedParagraphs } — a paragraph is a
 * blank-line-separated block.
 */
export function overlayParagraphDiff(
  previous: string | undefined,
  next: string,
): { same: boolean; addedParagraphs: string[]; removedParagraphs: string[] } {
  const prevParagraphs = new Set(splitParagraphs(previous ?? ''));
  const nextParagraphs = new Set(splitParagraphs(next));
  const added: string[] = [];
  const removed: string[] = [];
  for (const p of nextParagraphs) if (!prevParagraphs.has(p)) added.push(p);
  for (const p of prevParagraphs) if (!nextParagraphs.has(p)) removed.push(p);
  return {
    same: added.length === 0 && removed.length === 0,
    addedParagraphs: added,
    removedParagraphs: removed,
  };
}

function splitParagraphs(text: string): string[] {
  return text.split(/\n\s*\n/).map((p) => p.trim()).filter((p) => p.length > 0);
}
