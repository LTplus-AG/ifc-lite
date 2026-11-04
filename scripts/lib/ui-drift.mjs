/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const patterns = {
  'palette-class': /(?<![\w-])(?:bg|text|border(?:-[trblxyse])?|ring|ring-offset|outline|fill|stroke|divide|from|via|to|placeholder|accent|caret|decoration|shadow)-(?:slate|gray|zinc|neutral|stone|red|orange|amber|yellow|lime|green|emerald|teal|cyan|sky|blue|indigo|violet|purple|fuchsia|pink|rose)-(?:50|[1-9]00|950)(?:\/\d{1,3})?(?![\w-])/g,
  'bw-class': /(?<![\w-])(?:bg|text|border(?:-[trblxyse])?|ring|outline|fill|stroke|divide|from|via|to|placeholder|decoration|shadow)-(?:white|black)(?:\/\d{1,3})?(?![\w-])/g,
  'hex-literal': /(?<=['"`[(,\s:])#(?:[0-9a-fA-F]{8}|[0-9a-fA-F]{6}|[0-9a-fA-F]{3,4})(?![0-9A-Za-z_-])/g,
  'arbitrary-value': /(?<![\w-])-?(?:text|p[xytrblse]?|m[xytrblse]?|gap(?:-[xy])?|space-[xy]|w|h|size|min-w|max-w|min-h|max-h|rounded(?:-[a-z]{1,2})?|bg|border(?:-[trblxyse])?|leading|tracking|shadow|ring|font|top|left|right|bottom|inset(?:-[xy])?|z)-\[[^\]\s]+\]/g,
  'native-control': /<(?:button|input|select|textarea)(?=[\s/>])/g,
};

const emptyCounts = () => Object.fromEntries(Object.keys(patterns).sort().map((key) => [key, 0]));

/** Preserve strings and template expressions, masking comments without joining tokens. */
function stripComments(text) {
  const output = [];
  const stack = [{ kind: 'code', depth: 0 }];
  for (let i = 0; i < text.length; i++) {
    const char = text[i];
    const next = text[i + 1];
    const state = stack.at(-1);
    if (state.kind === 'line' || state.kind === 'block') {
      output.push(char === '\n' || char === '\r' ? char : ' ');
      if (state.kind === 'line' && /[\n\r]/.test(char)) stack.pop();
      else if (state.kind === 'block' && char === '*' && next === '/') {
        output.push(' ');
        i++;
        stack.pop();
      }
      continue;
    }
    output.push(char);
    if (state.kind === 'string' || state.kind === 'template') {
      if (char === '\\') {
        if (next !== undefined) output.push(text[++i]);
      } else if (char === state.quote) stack.pop();
      // A quote string cannot span lines, so a newline ends it. Without this an
      // apostrophe in JSX text ("Don't") swallowed the rest of the file and left
      // later comments, with their "#1234" issue refs, counted as hex colours.
      else if (state.kind === 'string' && (char === '\n' || char === '\r')) stack.pop();
      else if (state.kind === 'template' && char === '$' && next === '{') {
        output.push(text[++i]);
        stack.push({ kind: 'code', depth: 1 });
      }
      continue;
    }
    if (char === '/' && (next === '/' || next === '*')) {
      output[output.length - 1] = ' ';
      output.push(' ');
      stack.push({ kind: next === '/' ? 'line' : 'block' });
      i++;
    } else if (char === '"' || char === "'" || char === '`') {
      stack.push({ kind: char === '`' ? 'template' : 'string', quote: char });
    } else if (state.depth && char === '{') state.depth++;
    else if (state.depth && char === '}' && --state.depth === 0) stack.pop();
  }
  return output.join('');
}

/** Count occurrences, including repeats, in one source file. */
export function scanSource(text, { path }) {
  const source = stripComments(text);
  const counts = emptyCounts();
  for (const [category, pattern] of Object.entries(patterns)) {
    if (!path.endsWith('.tsx') && ['hex-literal', 'native-control'].includes(category)) continue;
    counts[category] = [...source.matchAll(pattern)].length;
  }
  return counts;
}

/** Scan tracked working-tree contents only; primitives deliberately own raw values. */
export function scanTree(repoRoot) {
  const paths = execFileSync('git', ['ls-files', '-z', '--', 'apps/viewer/src/'], {
    cwd: repoRoot, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024,
  }).split('\0').filter(Boolean).sort();
  const totals = emptyCounts();
  const files = {};
  for (const path of paths) {
    if (!/\.tsx?$/.test(path) || /\.(?:test|spec)\.tsx?$|\.d\.ts$/.test(path)
      || /^apps\/viewer\/src\/(?:test|components\/ui)\//.test(path)) continue;
    const counts = scanSource(readFileSync(join(repoRoot, path), 'utf8'), { path });
    files[path] = counts;
    for (const category of Object.keys(totals)) totals[category] += counts[category];
  }
  return { totals, files };
}
