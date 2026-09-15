#!/usr/bin/env node
/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/** Keep the viewer's IFC Z-up to Y-up RTC conversion in one module. */
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, join, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
export const CANONICAL = 'apps/viewer/src/lib/geo/coordinate-frame.ts';

export const PATTERNS = [
  {
    name: 'raw RTC offset alias',
    re: /\b(?:const|let)\s+\w+(?:\s*:\s*[^=;]+)?\s*=\s*[^;]*\bwasmRtcOffset\b/,
  },
  { name: 'destructured RTC offset', re: /\b(?:const|let)\s*\{[^}]*\bwasmRtcOffset\b[^}]*\}\s*=/ },
  { name: 'direct RTC component read', re: /\bwasmRtcOffset(?:\?\.|\.)[xyz]\b/ },
  { name: 'IFC-to-viewer RTC tuple', re: /\b(\w+)\.x\s*,\s*(?:y:\s*)?\1\.z\s*,\s*(?:z:\s*)?(?:-|−)\1\.y/ },
  { name: 'IFC-to-viewer axis object', re: /\by:\s*(\w+)\.z\s*,\s*z:\s*(?:0\s*-\s*|-)\1\.y/ },
  { name: 'viewer-to-IFC axis object', re: /\by:\s*(?:0\s*-\s*|-)(\w+)\.z\s*,\s*z:\s*\1\.y/ },
  { name: 'multiline Y from Z component', re: /^\s*y:\s*\w+\.z,?\s*(?:\/\/.*)?$/ },
  { name: 'multiline negated Z from Y component', re: /^\s*z:\s*(?:0\s*-\s*|-)\w+\.y,?\s*(?:\/\/.*)?$/ },
  { name: 'multiline negated Y from Z component', re: /^\s*y:\s*(?:0\s*-\s*|-)\w+\.z,?\s*(?:\/\/.*)?$/ },
  { name: 'multiline Z from Y component', re: /^\s*z:\s*\w+\.y,?\s*(?:\/\/.*)?$/ },
];

/** Intentional IFC-plan reads; exact lines cannot excuse adjacent new code. */
export const DISTINCT_FRAME_EXPRESSIONS = [
  {
    file: 'apps/viewer/src/hooks/dxfUnderlayMath.ts',
    text: 'const rtc = coordinateInfo?.wasmRtcOffset;',
  },
  {
    file: 'apps/viewer/src/lib/wall-rects-from-meshes.ts',
    text: 'const rtc = coord?.wasmRtcOffset ?? { x: 0, y: 0, z: 0 };',
  },
  {
    file: 'apps/viewer/src/hooks/useDrawingGeneration.ts',
    text: 'const shift = ci.wasmRtcOffset ? ifcToViewerAxes(ci.wasmRtcOffset) : ci.originShift;',
  },
];

/** Canonical helper calls that acquire the field without reimplementing it. */
export const CANONICAL_CALL_EXPRESSIONS = [
  {
    file: 'apps/viewer/src/lib/geo/reproject.ts',
    text: 'const rtcYup = ifcToViewerAxes(coordinateInfo.wasmRtcOffset ?? { x: 0, y: 0, z: 0 });',
  },
  {
    file: 'apps/viewer/src/lib/geo/map-absolute.ts',
    text: 'const rtcYup = ifcToViewerAxes(coordinateInfo.wasmRtcOffset ?? { x: 0, y: 0, z: 0 });',
  },
  {
    file: 'apps/viewer/src/lib/geo/cesium-bridge.ts',
    text: 'const rtcYup = ifcToViewerAxes(coordinateInfo?.wasmRtcOffset ?? { x: 0, y: 0, z: 0 });',
  },
  {
    file: 'apps/viewer/src/hooks/symbolic-parse-cache.ts',
    text: 'const rtcYupY = ifcToViewerAxes(info?.wasmRtcOffset ?? { x: 0, y: 0, z: 0 }).y;',
  },
  {
    file: 'apps/viewer/src/hooks/dxfUnderlayMath.ts',
    text: [
      'const rtcYup = ifcToViewerAxes(',
      '    coordinateInfo?.wasmRtcOffset ?? { x: 0, y: 0, z: 0 },',
      '  );',
    ].join('\n'),
  },
  {
    file: 'apps/viewer/src/lib/geo/cesium-placement.ts',
    text: [
      'const rtcYupY = ifcToViewerAxes(',
      '    coordinateInfo?.wasmRtcOffset ?? { x: 0, y: 0, z: 0 },',
      '  ).y;',
    ].join('\n'),
  },
  {
    file: 'apps/viewer/src/lib/geo/kmz-altitude-hint.ts',
    text: [
      'const rtcYupY = ifcToViewerAxes(',
      '    coordinateInfo?.wasmRtcOffset ?? { x: 0, y: 0, z: 0 },',
      '  ).y;',
    ].join('\n'),
  },
  {
    file: 'apps/viewer/src/lib/geo/kmz-export.ts',
    text: [
      'const rtcYupY = ifcToViewerAxes(',
      '    coordinateInfo?.wasmRtcOffset ?? { x: 0, y: 0, z: 0 },',
      '  ).y;',
    ].join('\n'),
  },
];

/** Comments that name the conversion contract; registered by exact line. */
export const PROSE_MENTIONS = [
  {
    file: 'apps/viewer/src/hooks/useDrawingGeneration.ts',
    text: '// the Y-up shift is (rtc.x, rtc.z, −rtc.y); the TS path instead',
  },
];

const registered = [
  ...DISTINCT_FRAME_EXPRESSIONS,
  ...CANONICAL_CALL_EXPRESSIONS,
  ...PROSE_MENTIONS,
];

export function validateProseMentions(mentions = PROSE_MENTIONS) {
  for (const mention of mentions) {
    const id = `PROSE_MENTIONS entry for ${mention.file}`;
    if (typeof mention.file !== 'string' || typeof mention.text !== 'string') {
      throw new Error(`${id}: file and text must be strings`);
    }
    if (mention.text !== mention.text.trim() || !mention.text.startsWith('//')) {
      throw new Error(`${id}: must be one trimmed // line comment`);
    }
    if (mention.text.includes('${') || mention.text.includes('*/')) {
      throw new Error(`${id}: template interpolation and block-comment terminators are unsafe`);
    }
    if (!PATTERNS.some((pattern) => pattern.re.test(mention.text))) {
      throw new Error(`${id}: matches no RTC-frame pattern`);
    }
  }
}
validateProseMentions();

function candidateFiles() {
  const output = execFileSync(
    'git',
    ['-C', REPO_ROOT, 'ls-files', '-z', 'apps/viewer/src/**/*.ts', 'apps/viewer/src/**/*.tsx'],
    { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 },
  );
  return output.split('\0').filter((file) => file && !/\.test\.tsx?$/.test(file));
}

export function scanText(file, source) {
  const normalized = file.split(sep).join('/');
  const hits = [];
  const lines = source.split('\n');
  for (const pattern of PATTERNS) {
    const flags = [...new Set(`${pattern.re.flags}gm`)].join('');
    const matches = source.matchAll(new RegExp(pattern.re.source, flags));
    for (const match of matches) {
      const index = match.index ?? 0;
      const line = source.slice(0, index).split('\n').length;
      const statementEnd = match[0].includes('\n') ? source.indexOf(';', index) : -1;
      const text =
        statementEnd >= 0
          ? source.slice(index, statementEnd + 1).trim()
          : (lines[line - 1]?.trim() ?? match[0].trim());
      hits.push({ file: normalized, line, text, pattern: pattern.name });
    }
  }
  return hits;
}

export function scanRepo(
  files = candidateFiles(),
  read = (file) => readFileSync(join(REPO_ROOT, file), 'utf8'),
  exceptions = registered,
) {
  if (files.length < 100) throw new Error(`refusing suspiciously small RTC scan (${files.length} files)`);
  const used = new Set();
  const violations = [];
  for (const file of files) {
    const normalized = file.split(sep).join('/');
    if (normalized === CANONICAL) continue;
    for (const hit of scanText(normalized, read(file))) {
      const index = exceptions.findIndex(
        (entry, entryIndex) =>
          !used.has(entryIndex) && entry.file === hit.file && entry.text === hit.text,
      );
      if (index >= 0) used.add(index);
      else violations.push(hit);
    }
  }
  const stale = exceptions.filter((_entry, index) => !used.has(index));
  return { violations, stale, scanned: files.length };
}

function main() {
  const { violations, stale, scanned } = scanRepo();
  if (violations.length || stale.length) {
    for (const hit of violations) {
      console.error(
        `${hit.file}:${hit.line}: ${hit.pattern}: ${hit.text}\n` +
          `  use apps/viewer/src/lib/geo/coordinate-frame.ts instead of copying the conversion`,
      );
    }
    for (const entry of stale) {
      console.error(
        `stale RTC-frame registry entry: ${entry.file}: ${entry.text}\n` +
          '  remove the obsolete registry entry or restore the approved distinct-frame expression',
      );
    }
    process.exitCode = 1;
    return;
  }
  console.log(`RTC frame copy gate passed (${scanned} viewer source files)`);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) main();
