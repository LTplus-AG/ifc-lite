/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Extract executable code blocks from LLM markdown responses.
 */

import type { CodeBlock } from './types.js';

/**
 * Parse fenced code blocks from a markdown string.
 * Supports ```js, ```javascript, ```typescript, ```ts, and bare ``` blocks.
 */
export function extractCodeBlocks(markdown: string): CodeBlock[] {
  const blocks: CodeBlock[] = [];
  // Match ```lang\n...code...\n```. `\r?` before the newline tolerates CRLF
  // source text (pasted/Windows-authored messages) - without it, the fence's
  // opening line never matches, the block is silently treated as plain text,
  // and its "Run" affordance never appears.
  const regex = /```(\w*)\r?\n([\s\S]*?)```/g;
  let match: RegExpExecArray | null;
  let index = 0;

  while ((match = regex.exec(markdown)) !== null) {
    const language = match[1] || 'js';
    const code = match[2].trim();

    // Only extract JS/TS code blocks (skip html, css, json, etc. unless they look like scripts)
    const isExecutable = ['js', 'javascript', 'ts', 'typescript', ''].includes(language.toLowerCase());
    // Also include unlabeled blocks that reference `bim.`
    const referencesBim = code.includes('bim.');

    if (isExecutable || referencesBim) {
      blocks.push({ index, language, code });
      index++;
    }
  }

  return blocks;
}

/**
 * Inject CSV data into a script as a `const DATA = [...]` declaration.
 * Prepends the data array before the LLM-generated script body.
 */
export function injectCsvData(
  script: string,
  data: Record<string, string>[],
): string {
  const dataDeclaration = `const DATA = ${JSON.stringify(data)};\n\n`;
  return dataDeclaration + script;
}
