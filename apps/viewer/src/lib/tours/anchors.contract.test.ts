/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Tour anchor contract (#5608): every anchor a tour step targets must be
 * rendered by some component. `TOUR_ANCHORS` keeps renames honest at compile
 * time, but deleting the element that carried `{...tourAnchor(...)}` compiles
 * fine and only shows up at runtime as `tour_step_broken`. This reads every
 * non-test source file's AST for `tourAnchor(<id>)` calls, so a comment or a
 * string that merely mentions an anchor does not count as rendering it.
 *
 * Templated anchors (`activityAnchor(id)`, `toolAnchor(tool)`,
 * `lensCardAnchor(id)`) called with a literal must match a literal call; one
 * called with a variable (the activity bar's rail, the classic toolbar, the
 * lens cards) renders the whole family, so any member of that family passes.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { TOUR_ANCHORS } from './anchors.js';
import { TOUR_REGISTRY } from './registry.js';

const SRC = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

const TEMPLATE_PREFIX: Record<string, string> = {
  activityAnchor: 'activity-',
  toolAnchor: 'tool-',
  lensCardAnchor: 'lens-card-',
};

function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return entry.name === 'node_modules' ? [] : sourceFiles(full);
    return /\.tsx?$/.test(entry.name) && !/\.test\.tsx?$/.test(entry.name) ? [full] : [];
  });
}

/** Rendered anchor ids, plus the template prefixes rendered for every member. */
function renderedAnchors(): { ids: Set<string>; families: Set<string> } {
  const ids = new Set<string>();
  const families = new Set<string>();
  const byKey = TOUR_ANCHORS as Record<string, string>;
  for (const file of sourceFiles(SRC)) {
    const text = readFileSync(file, 'utf8');
    if (!text.includes('tourAnchor(')) continue;
    const sf = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
    const visit = (node: ts.Node): void => {
      if (
        ts.isCallExpression(node)
        && ts.isIdentifier(node.expression)
        && node.expression.text === 'tourAnchor'
        && node.arguments.length === 1
      ) {
        const arg = node.arguments[0];
        if (
          ts.isPropertyAccessExpression(arg)
          && ts.isIdentifier(arg.expression)
          && arg.expression.text === 'TOUR_ANCHORS'
          && arg.name.text in byKey
        ) {
          ids.add(byKey[arg.name.text]);
        } else if (ts.isCallExpression(arg) && ts.isIdentifier(arg.expression)) {
          const prefix = TEMPLATE_PREFIX[arg.expression.text];
          const inner = arg.arguments[0];
          if (prefix && inner && ts.isStringLiteralLike(inner)) ids.add(prefix + inner.text);
          else if (prefix) families.add(prefix);
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(sf);
  }
  return { ids, families };
}

test('every tour step anchor is rendered by some component', () => {
  const { ids, families } = renderedAnchors();
  const orphaned: string[] = [];
  for (const tour of TOUR_REGISTRY) {
    for (const step of tour.steps) {
      const anchor = step.anchor;
      if (!anchor || ids.has(anchor)) continue;
      if ([...families].some((prefix) => anchor.startsWith(prefix))) continue;
      orphaned.push(`${tour.id}/${step.id} -> ${anchor}`);
    }
  }
  assert.deepEqual(orphaned, [], 'tour steps target anchors no component renders');
});

test('the scan sees the anchors it must (guards the scanner itself)', () => {
  const { ids, families } = renderedAnchors();
  assert.ok(ids.has(TOUR_ANCHORS.idsLoad), 'IDSPanelStates renders the Load IDS File anchor');
  assert.ok(ids.has('tool-measure'), 'the ribbon Home tab renders a literal tool anchor');
  assert.ok(families.has('activity-'), 'the activity bar renders the rail family');
});
