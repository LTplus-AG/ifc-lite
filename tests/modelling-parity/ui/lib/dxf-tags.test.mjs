/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import test from 'node:test';
import assert from 'node:assert/strict';
import { dxfTagTextsMatch } from './dxf-tags.mjs';

const tagLayer = 'DXF_Element_tags_IFC-TAGS';
const door = ['Parity entry 01', tagLayer];
const room = ['Room 1 · ? 18.24 m²', tagLayer];
const dimension = ['5.200 m', 'IFC-DIMENSIONS'];
const download = rows => ({ bytes: Buffer.from('0\nSECTION\n2\nENTITIES\n'+rows.map(([text,layer,type='TEXT'])=>`0\n${type}\n8\n${layer}\n10\n0\n1\n${text}\n`).join('')+'0\nENDSEC\n0\nEOF\n','latin1') });
const check = rows => dxfTagTextsMatch(download(rows), 'Parity entry 01', 'Room 1', 18.24);

test('#9328 dimension TEXT on its own layer does not replace or invalidate tags (#10020)', () => {
  assert.equal(check([door,room]),true);
  assert.equal(check([door,room,dimension]),true);
  for(const rows of [[door,dimension],[room,dimension],[door,door,dimension],[door,room,room,dimension]]) {
    assert.equal(check(rows),false,'a dimension or duplicate cannot replace a missing tag');
  }
});
test('#9328 DXF tags require their exact content and tag layer', () => {
  for(const replacement of [
    ['Room 1 · ? 18.25 m²',tagLayer], ['Room 2 · ? 18.24 m²',tagLayer],
    ['Room 1 · wrong 18.24 m²',tagLayer], [room[0],'IFC-DIMENSIONS'], [room[0],tagLayer,'MTEXT'],
  ]) assert.equal(check([door,replacement,dimension]),false);
  assert.equal(dxfTagTextsMatch(null,'Parity entry 01','Room 1',18.24),false);
});
