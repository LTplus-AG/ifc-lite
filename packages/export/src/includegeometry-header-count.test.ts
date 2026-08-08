/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Regression cover for a CodeRabbit finding on
 * github.com/LTplus-AG/ifc-lite/pull/2414: `hasEmittableHostBytes` and
 * `willBeEmitted` decide whether an entity's line survives by byte-range
 * (and, since the sibling fix in this PR, by the `visibleOnly` closure) but
 * never consult `options.includeGeometry`. The source-iteration pass, and
 * the overlay new-entities pass, both separately skip a geometry-classified
 * entity when `includeGeometry === false` (`isGeometryEntity` checks at
 * step-exporter.ts:840 and :1004) — so a geometry entity carrying an
 * attribute edit had its line dropped from `DATA` while the header still
 * counted it as a modification, the exact class of mismatch the rest of
 * this file guards.
 *
 * Every assertion here is against the emitted file TEXT, never against an
 * internal counter alone — `dataEntityLineCount`/`grep`-style matching
 * proves what actually landed in `DATA`.
 */

import { describe, expect, it } from 'vitest';
import { IfcParser, type IfcDataStore } from '@ifc-lite/parser';
import { MutablePropertyView, StoreEditor } from '@ifc-lite/mutations';
import { StepExporter } from './step-exporter.js';

function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
}

/** The "N modification(s)" count the HEADER's FILE_DESCRIPTION claims, or
 *  null when the header makes no such claim. */
function headerClaimedModifications(stepText: string): number | null {
  const m = /Re-exported by ifc-lite, (\d+) modification/.exec(stepText);
  return m ? Number(m[1]) : null;
}

const BASE_IFC = `ISO-10303-21;
HEADER;
FILE_DESCRIPTION(('ViewDefinition[DesignTransferView]'),'2;1');
FILE_NAME('base.ifc','2026-08-08T10:00:00+01:00',(''),(''),'ifc-lite','ifc-lite','');
FILE_SCHEMA(('IFC4'));
ENDSEC;
DATA;
#1=IFCPROJECT('0OSuGGYUFyIf0LtE29OSuG',$,'My Project',$,$,$,$,$,$);
#8=IFCWALL('0OSuGGYUFyIf0LtE29OSuH',$,'Existing Wall',$,$,$,$,$,$);
#20=IFCSHAPEREPRESENTATION($,'Body','SweptSolid',(#21));
ENDSEC;
END-ISO-10303-21;`;

async function parseBase(): Promise<IfcDataStore> {
  return new IfcParser().parseColumnar(toArrayBuffer(new TextEncoder().encode(BASE_IFC)));
}

describe('STEP header modification count vs includeGeometry:false', () => {
  it('an attribute edit on a geometry-classified host excluded by includeGeometry:false must not claim a modification the DATA section does not contain', async () => {
    const store = await parseBase();
    const view = new MutablePropertyView(null, 'test-model');
    const editor = new StoreEditor(store, view);
    // #20 is IFCSHAPEREPRESENTATION — on `isGeometryEntity`'s list, so the
    // source-iteration pass drops its line entirely under includeGeometry:false.
    editor.setAttribute(20, 'RepresentationIdentifier', 'Reference');

    const result = new StepExporter(store, view).export({
      schema: 'IFC4',
      includeGeometry: false,
    });
    const text = new TextDecoder().decode(result.content);

    // The geometry line must actually be gone.
    expect(text).not.toContain('IFCSHAPEREPRESENTATION');
    // ...and the header must not claim a modification for it either.
    expect(result.stats.modifiedEntityCount).toBe(0);
    expect(headerClaimedModifications(text)).toBeNull();
  });

  it('bounding control: the SAME edit with geometry included still reports the modification and emits the line', async () => {
    const store = await parseBase();
    const view = new MutablePropertyView(null, 'test-model');
    const editor = new StoreEditor(store, view);
    editor.setAttribute(20, 'RepresentationIdentifier', 'Reference');

    const result = new StepExporter(store, view).export({ schema: 'IFC4' });
    const text = new TextDecoder().decode(result.content);

    expect(text).toContain('IFCSHAPEREPRESENTATION');
    expect(result.stats.modifiedEntityCount).toBe(1);
    expect(headerClaimedModifications(text)).toBe(
      result.stats.newEntityCount + result.stats.modifiedEntityCount,
    );
  });
});
