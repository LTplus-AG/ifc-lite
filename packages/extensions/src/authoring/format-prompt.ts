/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Format a bundle into the chat-prompt fenced shape the authoring loop
 * accepts. Centralises the format so every call site (fork, repair,
 * accepted-suggestion) produces identical structure for the parser
 * downstream.
 *
 * The output uses the same `ifc-extension-manifest` / `ifc-extension-code`
 * / `ifc-extension-widget` fences that `parseBundleOutput` reads.
 *
 * Spec: docs/architecture/ai-customization/04-ai-authoring.md §2.C.
 */

import type { Bundle, BundleFile } from '../types.js';

export interface FormatBundleForPromptOptions {
  /** Maximum number of files to include (manifest excluded). Default 6. */
  maxFiles?: number;
  /** Maximum characters per file before truncating with a marker. Default 4000. */
  maxFileChars?: number;
  /** Files matching this prefix get the `widget` fence; everything else `code`. Default `widgets/`. */
  widgetPathPrefix?: string;
}

export interface FormattedBundle {
  /** The prompt-ready fenced string. */
  text: string;
  /** Number of files actually included (excluding manifest). */
  filesShown: number;
  /** Number of files in the bundle that were skipped (over `maxFiles`). */
  filesSkipped: number;
  /** Whether any included file was truncated. */
  truncated: boolean;
}

const DECODER = new TextDecoder();

/**
 * Produce a chat-prompt fenced representation of the bundle.
 *
 * - The manifest always lands first, fully serialised.
 * - At most `maxFiles` code/widget files follow.
 * - Each file is capped at `maxFileChars` with a `[truncated]` marker.
 * - Widget files (path starts with `widgetPathPrefix`) get the
 *   `ifc-extension-widget` fence; everything else gets
 *   `ifc-extension-code`.
 *
 * Pure: no side effects, deterministic for a given input.
 */
export function formatBundleForPrompt(
  bundle: Bundle,
  opts: FormatBundleForPromptOptions = {},
): FormattedBundle {
  const maxFiles = opts.maxFiles ?? 6;
  const maxFileChars = opts.maxFileChars ?? 4000;
  const widgetPrefix = opts.widgetPathPrefix ?? 'widgets/';

  const manifestText = JSON.stringify(bundle.manifest, null, 2);
  const allFiles = Array.from(bundle.files.keys()).filter((p) => p !== 'manifest.json');
  const shown = allFiles.slice(0, maxFiles);
  let truncated = false;

  const fileBlocks: string[] = [];
  for (const path of shown) {
    const file = bundle.files.get(path);
    if (!file) continue;
    const fullText = fileToText(file);
    const fenceText = fullText.length > maxFileChars
      ? `${fullText.slice(0, maxFileChars)}\n\n/* …truncated (${fullText.length - maxFileChars} chars omitted) */`
      : fullText;
    if (fullText.length > maxFileChars) truncated = true;
    const fence = path.startsWith(widgetPrefix)
      ? 'ifc-extension-widget'
      : 'ifc-extension-code';
    fileBlocks.push(`\`\`\`${fence} path="${path}"\n${fenceText}\n\`\`\``);
  }

  const skipped = Math.max(0, allFiles.length - shown.length);
  const sections = [
    '```ifc-extension-manifest',
    manifestText,
    '```',
  ];
  if (fileBlocks.length > 0) {
    sections.push('');
    sections.push(...fileBlocks);
  }
  if (skipped > 0) {
    sections.push('');
    sections.push(`/* …plus ${skipped} more files not shown. */`);
  }

  return {
    text: sections.join('\n'),
    filesShown: shown.length,
    filesSkipped: skipped,
    truncated,
  };
}

function fileToText(file: BundleFile): string {
  if (file.text) return file.text;
  try {
    return DECODER.decode(file.bytes);
  } catch {
    return `/* (${file.bytes.byteLength} bytes — binary, omitted) */`;
  }
}
