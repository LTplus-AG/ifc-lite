/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, expect, it } from 'vitest';
import { diffModels } from '@ifc-lite/diff';
import { loadIfcBytes } from '../loader.js';
import { buildFileFingerprints } from './diff-engine.js';

const TYPE_GUID = '0aaaaaaaaaaaaaaaaaaaaa';
const schemas = [
  { schema: 'IFC2X3', ifcType: 'IfcWindowStyle', tail: '.SINGLE_PANEL.,.WOOD.,.T.,.F.' },
  { schema: 'IFC4', ifcType: 'IfcWallType', tail: "'Wall',.STANDARD." },
  { schema: 'IFC4X3', ifcType: 'IfcRailType', tail: "'Rail',.RACKRAIL." },
] as const;

/** No occurrences or geometry: the type owns both definitions directly. */
function source(fixture: (typeof schemas)[number], rating: string, length: number): Uint8Array {
  return new TextEncoder().encode([
    'ISO-10303-21;', 'HEADER;',
    "FILE_DESCRIPTION((''),'2;1');",
    "FILE_NAME('','',(''),(''),'','','');",
    `FILE_SCHEMA(('${fixture.schema}'));`,
    'ENDSEC;', 'DATA;',
    `#1=${fixture.ifcType.toUpperCase()}('${TYPE_GUID}',$,'Type A',$,$,(#3,#5),$,'T-001',${fixture.tail});`,
    `#2=IFCPROPERTYSINGLEVALUE('FireRating',$,IFCLABEL('${rating}'),$);`,
    "#3=IFCPROPERTYSET('0bbbbbbbbbbbbbbbbbbbbb',$,'Pset_TestType',$,(#2));",
    `#4=IFCQUANTITYLENGTH('Length',$,$,${length}.,$);`,
    "#5=IFCELEMENTQUANTITY('0ccccccccccccccccccccc',$,'Qto_TestType',$,$,(#4));",
    'ENDSEC;', 'END-ISO-10303-21;',
  ].join('\n'));
}

describe('CLI type-owned property and quantity changes (#8040, PR #8054)', () => {
  for (const fixture of schemas) {
    describe(`${fixture.schema} ${fixture.ifcType}`, () => {
      for (const edit of [
        { rating: '90', length: 2, component: 'pset:Pset_TestType' },
        { rating: '60', length: 3, component: 'qset:Qto_TestType' },
      ]) {
        it(`reports only the owning type for a ${edit.component} edit`, async () => {
          const base = buildFileFingerprints(await loadIfcBytes(source(fixture, '60', 2), 'base'));
          const head = buildFileFingerprints(await loadIfcBytes(source(fixture, edit.rating, edit.length), 'head'));
          const diff = diffModels(base, head, { scope: 'data' });
          expect(diff.counts).toEqual({ added: 0, deleted: 0, modified: 1, unchanged: 0 });
          const entry = diff.byKey.get(TYPE_GUID);
          expect(entry?.state).toBe('modified');
          expect(entry?.head?.ifcType).toBe(fixture.ifcType);
          expect(entry?.changeKinds).toEqual(['data']);
          expect(entry?.changedComponents).toEqual([edit.component]);
        });
      }

      it('keeps identical type-owned data unchanged across stores', async () => {
        const base = buildFileFingerprints(await loadIfcBytes(source(fixture, '60', 2), 'base'));
        const head = buildFileFingerprints(await loadIfcBytes(source(fixture, '60', 2), 'head'));
        expect(diffModels(base, head, { scope: 'data' }).counts)
          .toEqual({ added: 0, deleted: 0, modified: 0, unchanged: 1 });
      });
    });
  }
});
