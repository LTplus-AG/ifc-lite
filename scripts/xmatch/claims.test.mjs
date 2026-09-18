/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Regression pins from the #4974 review: a split claim repeating one piece
 * is not the split the key describes; the map digest survives a cyclic
 * subgraph without recursing; and only the `#<id>` segment of a container
 * path may differ between revisions.
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { indexModel } from './edits.mjs';
import { unnamedNodesNormalised } from './guards.mjs';
import { scoreSplits } from './score-claims.mjs';
import { parseStepFile } from './step-file.mjs';
import { representationMapDigest } from './successor-edits.mjs';

const fp = (ref) => ({ ref, key: `k${ref}`, ifcType: 'IfcWall', dataHash: 'd' });

test('a split claim that repeats one piece is wrong, not correct', () => {
  const key = { elements: [{ base: 1, kind: 'splitLength', class: 'prismatic', head: [11, 12] }] };
  const claim = (pieces) => ({ kind: 'split', confidence: 'extent', whole: fp(1), pieces: pieces.map(fp) });
  const options = { hasVolume: new Set(), kindOf: new Map(), headOrigin: new Map() };
  assert.equal(scoreSplits(key, [claim([11, 12])], options).bySplit.correct, 1);
  assert.equal(scoreSplits(key, [claim([11, 11])], options).bySplit.correct, 0);
  assert.equal(scoreSplits(key, [claim([11, 11])], options).bySplit.wrong, 1);
});

test('the map digest walks a cyclic, deep subgraph without recursion', () => {
  const lines = ['#1=IFCREPRESENTATIONMAP(#2,#3);', '#2=IFCAXIS2PLACEMENT3D(#3,$,$);'];
  // A chain of 20000 nodes, closing back on #2: recursion would overflow.
  const n = 20000;
  for (let i = 3; i < n; i++) lines.push(`#${i}=IFCSHAPEREPRESENTATION($,'Body','X',(#${i + 1}));`);
  lines.push(`#${n}=IFCSHAPEREPRESENTATION($,'Body','X',(#2));`);
  const file = parseStepFile(
    `ISO-10303-21;\nHEADER;\nFILE_SCHEMA(('IFC4'));\nENDSEC;\nDATA;\n${lines.join('\n')}\nENDSEC;\nEND-ISO-10303-21;\n`,
  );
  const digest = representationMapDigest(indexModel(file), 1);
  assert.equal(digest.split('\n').length, n);
  assert.match(digest, /^IFCREPRESENTATIONMAP\(#/m);
});

test('only the unnamed-node segment of a container path may differ', () => {
  const same = (a, b) => unnamedNodesNormalised(a) === unnamedNodesNormalised(b);
  assert.equal(same('P/S/#36/Level 1', 'P/S/#19404/Level 1'), true);
  assert.equal(same('P/S/#36/Level 1', 'P/S/#19404/Level 2'), false, 'a renamed storey is a leak');
  assert.equal(same('P/S/#36/Level 1', 'P/S/#19404/Level 1/#5'), false, 'a deeper path is not the same node');
});
