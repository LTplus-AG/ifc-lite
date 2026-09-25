/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Icon-only buttons go through `IconButton` (#5811), which requires a label.
 *
 * A `<Button size="icon…">` can be written with no accessible name, and 46 of
 * them were, so each one left outside `components/ui` is a place the defect
 * can come back. This is a two-way per-file ratchet over the source: a file
 * may not gain one (a new file is allowed none), and a file that loses one
 * must lower its row here so the slack is not spent by the next regression.
 *
 * The files still listed belong to other charters' surfaces (#5478: the
 * drawing, measure, section, placement and presentation panels and the
 * viewport HUD; #5610: the two desktop toolbars; #5817: the shortcuts
 * dialog), plus text-glyph buttons that already carry an `aria-label`.
 * The follow-up under #5811 migrates them.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const COMPONENTS = join(dirname(fileURLToPath(import.meta.url)), '..');

const BASELINE: Record<string, number> = {
  'viewer/BulkPropertyEditor.tsx': 1,
  'viewer/DrawingSettingsPanel.tsx': 1,
  'viewer/GeometryAxisRow.tsx': 2,
  'viewer/GeometryEditCard.tsx': 3,
  'viewer/KeyboardShortcutsDialog.tsx': 1,
  'viewer/MainToolbar.tsx': 21,
  'viewer/MeasurementsPanel.tsx': 2,
  'viewer/MobileToolbar.tsx': 7,
  'viewer/PointCloudPanel.tsx': 1,
  'viewer/SheetSetupPanel.tsx': 2,
  'viewer/ViewportOverlays.tsx': 3,
  'viewer/chat/ExecutableCodeBlock.tsx': 1,
  'viewer/drawing/DrawingExportMenu.tsx': 1,
  'viewer/drawing/DrawingPanel.tsx': 2,
  'viewer/drawing/DrawingToolbar.tsx': 1,
  'viewer/placement/PlacementPanel.tsx': 1,
  'viewer/presentation/PresentationPanel.tsx': 9,
  'viewer/presentation/PresentationViewCard.tsx': 3,
  'viewer/ribbon/RibbonToolbar.tsx': 2,
  'viewer/tools/MeasurePointReadout.tsx': 2,
  'viewer/tools/MeasureToolbar.tsx': 2,
  'viewer/tools/MeasurementList.tsx': 6,
  'viewer/tools/SectionToolbar.tsx': 1,
};

function* sourceFiles(dir: string): Generator<string> {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) yield* sourceFiles(path);
    else if (entry.name.endsWith('.tsx') && !entry.name.includes('.test.')) yield path;
  }
}

/** The text of the opening tag starting at `start` (`<Button`), up to its
 *  closing `>`: braces and quotes are skipped so `onClick={() => …}` does not
 *  end the tag early. */
function openingTag(source: string, start: number): string {
  let depth = 0;
  let quote: string | null = null;
  for (let i = start + 1; i < source.length; i += 1) {
    const ch = source[i];
    if (quote) {
      if (ch === '\\') i += 1;
      else if (ch === quote) quote = null;
    } else if (depth > 0 && ch === '/' && source[i + 1] === '/') {
      i = source.indexOf('\n', i); // a comment's apostrophe is not a quote
      if (i < 0) break;
    } else if (depth > 0 && ch === '/' && source[i + 1] === '*') {
      i = source.indexOf('*/', i) + 1;
      if (i <= 0) break;
    } else if (ch === '"' || ch === "'" || ch === '`') quote = ch;
    else if (ch === '{') depth += 1;
    else if (ch === '}') depth -= 1;
    else if (ch === '>' && depth === 0) return source.slice(start, i + 1);
  }
  return source.slice(start);
}

function countIconSizedButtons(source: string): number {
  let count = 0;
  for (const match of source.matchAll(/<Button(?=[\s>])/g)) {
    if (/\ssize="icon[\w-]*"/.test(openingTag(source, match.index))) count += 1;
  }
  return count;
}

describe('icon-only buttons use IconButton (#5811)', () => {
  it('counts a multi-line opening tag whose handler contains `=>` and a commented apostrophe', () => {
    const src = '<Button\n  onClick={() => {\n    // don\'t stop at this apostrophe\n    go();\n  }}\n  size="icon-xs"\n>\n  <X />\n</Button>\n<Button size="sm">Text</Button>';
    assert.equal(countIconSizedButtons(src), 1);
  });

  it('no file gains a <Button size="icon…">, and fixed files lower their row', () => {
    const measured: Record<string, number> = {};
    for (const file of sourceFiles(COMPONENTS)) {
      const key = relative(COMPONENTS, file).split('\\').join('/');
      if (key.startsWith('ui/')) continue;
      const n = countIconSizedButtons(readFileSync(file, 'utf8'));
      if (n > 0) measured[key] = n;
    }
    const keys = [...new Set([...Object.keys(measured), ...Object.keys(BASELINE)])].sort();
    const rises = keys.filter((k) => (measured[k] ?? 0) > (BASELINE[k] ?? 0))
      .map((k) => `${k}: ${measured[k]} (allowed ${BASELINE[k] ?? 0})`);
    const slack = keys.filter((k) => (measured[k] ?? 0) < (BASELINE[k] ?? 0))
      .map((k) => `${k}: ${measured[k] ?? 0} (baseline ${BASELINE[k]})`);
    assert.deepEqual(rises, [], `use IconButton (it requires a label) instead of <Button size="icon…">:\n${rises.join('\n')}`);
    assert.deepEqual(slack, [], `lower these rows in BASELINE to tighten the ratchet:\n${slack.join('\n')}`);
  });
});
