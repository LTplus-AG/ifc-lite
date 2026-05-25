/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Bundle synthesis — parse LLM output into structured bundle pieces.
 *
 * The authoring pipeline runs the model multiple times: once to
 * propose a plan, once for the manifest, once for code, once per
 * widget. Each call's output is text the model emits; this module
 * turns that text into structured values that downstream validators
 * + the runtime accept.
 *
 * The model is asked to wrap each piece in a specific fenced block:
 *
 *   ```ifc-extension-manifest
 *   { ... JSON ... }
 *   ```
 *
 *   ```ifc-extension-code path="src/commands/foo.js"
 *   ... JS ...
 *   ```
 *
 *   ```ifc-extension-widget path="widgets/foo.json"
 *   { ... JSON ... }
 *   ```
 *
 * This is the same fenced-codeblock pattern the existing chat
 * `extract-code-blocks` uses; reusing the convention keeps prompt
 * caching warm.
 *
 * Spec: docs/architecture/ai-customization/04-ai-authoring.md §2.C.
 */

import type { ValidationError, ValidationResult } from '../types.js';

// Horizontal whitespace only (`[ \t]`) — using `\s+` would let `\n`
// match as whitespace and the attribute capture would greedily eat
// the entire JSON content. Bug found via test; reproducer in
// `synthesize.test.ts`.
const FENCE_RE = /```ifc-extension-(manifest|code|widget)(?:[ \t]+([^\n]*))?\n([\s\S]*?)```/g;

export interface ExtractedBundlePiece {
  kind: 'manifest' | 'code' | 'widget';
  /** Path inside the bundle for code/widget. Empty for manifest. */
  path?: string;
  /** Raw text content of the block. */
  content: string;
  /** Character offset in the source. */
  offset: number;
}

export interface ParsedBundleOutput {
  manifest?: unknown;
  files: Record<string, string>;
  widgets: Record<string, unknown>;
  /** Pieces the parser couldn't classify. Useful for debugging the model. */
  unknown: string[];
}

/** Extract structured bundle pieces from a chat response. */
export function extractBundlePieces(response: string): ExtractedBundlePiece[] {
  const out: ExtractedBundlePiece[] = [];
  for (const m of response.matchAll(FENCE_RE)) {
    const [, kind, attrLine, content] = m;
    const path = parsePathAttr(attrLine ?? '');
    out.push({
      kind: kind as 'manifest' | 'code' | 'widget',
      path,
      content: content ?? '',
      offset: m.index ?? 0,
    });
  }
  return out;
}

/**
 * Parse a chat response into a bundle structure. Manifest text is
 * JSON-parsed; widgets are JSON-parsed; code stays as text. Returns
 * the structured shape plus any per-piece parse errors.
 */
export function parseBundleOutput(response: string): ValidationResult<ParsedBundleOutput> {
  const errors: ValidationError[] = [];
  const pieces = extractBundlePieces(response);
  const result: ParsedBundleOutput = { files: {}, widgets: {}, unknown: [] };

  for (const piece of pieces) {
    switch (piece.kind) {
      case 'manifest': {
        try {
          if (result.manifest) {
            errors.push({
              path: '<manifest>',
              code: 'invalid_value',
              message: 'Multiple `ifc-extension-manifest` blocks; only one is allowed.',
            });
            continue;
          }
          result.manifest = JSON.parse(piece.content);
        } catch (err) {
          errors.push({
            path: '<manifest>',
            code: 'invalid_format',
            message: `manifest JSON did not parse: ${err instanceof Error ? err.message : err}`,
          });
        }
        break;
      }
      case 'code': {
        if (!piece.path) {
          errors.push({
            path: '<code>',
            code: 'required',
            message: 'Code block missing `path="..."` attribute.',
          });
          continue;
        }
        result.files[piece.path] = piece.content;
        break;
      }
      case 'widget': {
        if (!piece.path) {
          errors.push({
            path: '<widget>',
            code: 'required',
            message: 'Widget block missing `path="..."` attribute.',
          });
          continue;
        }
        try {
          result.widgets[piece.path] = JSON.parse(piece.content);
          // Also expose the widget JSON as a file in the bundle for
          // downstream packaging. Downstream callers can choose to use
          // `widgets` for early validation and `files` for packing.
          result.files[piece.path] = piece.content;
        } catch (err) {
          errors.push({
            path: `<widget:${piece.path}>`,
            code: 'invalid_format',
            message: `widget JSON did not parse: ${err instanceof Error ? err.message : err}`,
          });
        }
        break;
      }
    }
  }

  if (!result.manifest && pieces.length > 0) {
    errors.push({
      path: '<manifest>',
      code: 'required',
      message: 'Response includes code/widget blocks but no `ifc-extension-manifest` block.',
    });
  }

  if (errors.length > 0) return { ok: false, errors };
  return { ok: true, value: result };
}

const PATH_RE = /path="([^"]+)"/;
function parsePathAttr(attrLine: string): string | undefined {
  const m = attrLine.match(PATH_RE);
  return m ? m[1] : undefined;
}
