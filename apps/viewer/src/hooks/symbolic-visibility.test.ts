/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { it } from 'node:test';
import assert from 'node:assert/strict';
import { buildSymbolicLineChannels, symbolicLineVertexData } from './symbolic-line-channels.js';
import { buildSymbolicRichChannels } from './symbolic-rich-channels.js';
import type { ParseResult, AnnotationText2D, AnnotationFill2D } from '../lib/overlay-parse/symbolic-parse.js';

const text = (ownerId: number): AnnotationText2D => ({ ownerId, x: ownerId, y: 0, dirX: 1, dirY: 0, height: 1, content: String(ownerId), alignment: 'center' });
const fill = (ownerId: number): AnnotationFill2D => ({ ownerId, points: new Float32Array([0,0,0,1,1,1]), holesOffsets: new Uint32Array(), color: [1,1,1,1] });
const line = (ownerId: number) => ({ ownerId, category: 'annotation' as const, line: { start: { x: ownerId, y: 0 }, end: { x: ownerId, y: 1 } } });
const cached: ParseResult = {
  byStorey: new Map([[10, { storeyId: 10, storeyElevation: 0, lines: [line(1),line(2)], texts: [text(1),text(2)], fills: [fill(1),fill(2)] }]]),
  loose: [line(1),line(2)], looseTexts: [text(1),text(2)], looseFills: [fill(1),fill(2)],
  gridByStorey: new Map(), gridLoose: [line(3)], gridLooseTexts: [text(3)], gridLooseFills: [fill(3)],
};
const params = { enabled: true, effectiveGridEnabled: true, clipEnabled: false, clipPos: 0, clipDepth: 0, fallbackY: 0, theme: 'light' as const };
it('#8767 builders filter annotation owners in bucket and loose paths, preserving reference grids', () => {
  const entries = [{ cached, isIsolatedOut: (id: number) => id !== 2 }];
  const lines = buildSymbolicLineChannels(entries, params);
  const rich = buildSymbolicRichChannels(entries, params);
  assert.equal(symbolicLineVertexData(lines.annotation).length, 12);
  assert.equal(symbolicLineVertexData(lines.grid).length, 6);
  assert.equal(rich.texts.map(t => t.content).join(','), '2,2,3');
  assert.equal(rich.fills.length, 3);
});
it('#8767 rich flags mark annotations for section clipping and leave grid references unclipped', () => {
  const rich = buildSymbolicRichChannels([{ cached }], params);
  assert.equal(rich.texts.map(t => String(t.sectionClipped)).join(','), 'true,true,true,true,false');
  assert.equal(rich.fills.map(f => String(f.sectionClipped)).join(','), 'true,true,true,true,false');
});
