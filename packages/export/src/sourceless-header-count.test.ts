/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Regression cover for the reporting mismatch flagged out-of-scope in
 * github.com/LTplus-AG/ifc-lite/pull/2398: on a store with no source bytes,
 * a property-set edit made the exported STEP header claim "N modifications"
 * over an empty `DATA` section.
 *
 * The store shape here is not a test-only construction: `createSyntheticDataStore`
 * is the same function `apps/viewer/src/hooks/ingest/pointCloudIngest.ts` calls
 * for every LAS/LAZ scan the viewer ingests — a real product entity with
 * `byteLength: 0` (see `packages/parser/src/synthetic-data-store.ts:85-93`). A
 * user who renames a pset property on an ingested point-cloud "entity" and
 * exports STEP hits this exact path.
 *
 * Every assertion here is against the emitted file TEXT (the header string,
 * the `DATA` section), never against an internal counter — the counter is
 * exactly what might be lying.
 */

import { describe, expect, it } from 'vitest';
import { createSyntheticDataStore, IfcParser, type IfcDataStore } from '@ifc-lite/parser';
import { MutablePropertyView, StoreEditor } from '@ifc-lite/mutations';
import { StepExporter } from './step-exporter.js';

function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
}

/** How many `#id=` entity lines the DATA section actually contains. */
function dataEntityLineCount(stepText: string): number {
  const match = /DATA;\r?\n([\s\S]*?)ENDSEC;\r?\nEND-ISO-10303-21;/.exec(stepText);
  const body = match ? match[1] : '';
  const lines = body.split(/\r?\n/).filter((l) => l.trim().length > 0);
  return lines.length;
}

/** The "N modification(s)" count the HEADER's FILE_DESCRIPTION claims, or
 *  null when the header makes no such claim. */
function headerClaimedModifications(stepText: string): number | null {
  const m = /Re-exported by ifc-lite, (\d+) modification/.exec(stepText);
  return m ? Number(m[1]) : null;
}

const SCAN_ENTITY_ID = 42;

/** A store with EMPTY_SOURCE_BYTES carrying one real (non-overlay) entity row
 *  with a zero-length byte range — exactly what point-cloud/GLB ingest builds. */
function sourcelessScanStore(): IfcDataStore {
  return createSyntheticDataStore({
    schemaVersion: 'IFC4',
    fileSize: 9999,
    entityCount: 1,
    entities: [{
      expressId: SCAN_ENTITY_ID,
      type: 'IfcGeographicElement',
      globalId: 'pointcloud-scan-0000001',
      name: 'scan.las',
      hasGeometry: true,
    }],
  });
}

const BASE_IFC = `ISO-10303-21;
HEADER;
FILE_DESCRIPTION(('ViewDefinition[DesignTransferView]'),'2;1');
FILE_NAME('base.ifc','2026-08-07T10:00:00+01:00',(''),(''),'ifc-lite','ifc-lite','');
FILE_SCHEMA(('IFC4'));
ENDSEC;
DATA;
#1=IFCPROJECT('0OSuGGYUFyIf0LtE29OSuG',$,'My Project',$,$,$,$,$,$);
#8=IFCWALL('0OSuGGYUFyIf0LtE29OSuH',$,'Existing Wall',$,$,$,$,$,$);
#10=IFCPROPERTYSINGLEVALUE('Width',$,IFCLENGTHMEASURE(200.),$);
#11=IFCPROPERTYSET('0OSuGGYUFyIf0LtE29OSuI',$,'Pset_WallCommon',$,(#10));
#12=IFCRELDEFINESBYPROPERTIES('0OSuGGYUFyIf0LtE29OSuJ',$,$,$,(#8),#11);
ENDSEC;
END-ISO-10303-21;`;

async function parseBase(): Promise<IfcDataStore> {
  return new IfcParser().parseColumnar(toArrayBuffer(new TextEncoder().encode(BASE_IFC)));
}

describe('STEP header modification count vs actual DATA content', () => {
  it('a pset edit on a sourceless-store entity must not claim a modification the DATA section does not contain', () => {
    const store = sourcelessScanStore();
    const view = new MutablePropertyView(null, 'test-model');
    const editor = new StoreEditor(store, view);
    editor.addPropertySet(SCAN_ENTITY_ID, 'Pset_ScanMetadata', [
      { name: 'Source', value: 'lidar', type: 'TEXT' },
    ]);

    const result = new StepExporter(store, view).export({ schema: 'IFC4' });
    const text = new TextDecoder().decode(result.content);

    const claimed = headerClaimedModifications(text);
    const actualLines = dataEntityLineCount(text);

    // The honest invariant: the DATA section is empty (the entity has no
    // source bytes and its pset generation is gated behind `willBeEmitted`,
    // which agrees), so the header must not claim a modification either.
    expect(actualLines).toBe(0);
    expect(claimed).toBeNull();
    expect(result.stats.modifiedEntityCount).toBe(0);
  });

  it('bounding control: a NORMAL file-parsed store still reports the correct non-zero count and emits the modification', async () => {
    const store = await parseBase();
    const view = new MutablePropertyView(null, 'test-model');
    const editor = new StoreEditor(store, view);
    editor.addPropertySet(8, 'Pset_WallCommon', [
      { name: 'IsExternal', value: true, type: 'BOOLEAN' },
    ]);

    const result = new StepExporter(store, view).export({ schema: 'IFC4' });
    const text = new TextDecoder().decode(result.content);

    // The wall is a modified host (its pset relation changed) and the header's
    // claim is newEntityCount + modifiedEntityCount — the fresh pset atom,
    // IFCPROPERTYSET and IFCRELDEFINESBYPROPERTIES this edit generated, plus
    // the modified wall itself.
    expect(result.stats.modifiedEntityCount).toBe(1);
    expect(result.stats.newEntityCount).toBe(3);
    expect(headerClaimedModifications(text)).toBe(
      result.stats.newEntityCount + result.stats.modifiedEntityCount,
    );
    // The wall itself, plus its replacement pset + rel, must actually be present.
    expect(text).toContain('#8=IFCWALL');
    expect(text).toMatch(/IFCPROPERTYSET\([^)]*'Pset_WallCommon'/);
  });

  it('a pset edit on a source-backed host EXCLUDED by visibleOnly must not claim a modification the DATA section does not contain', async () => {
    const store = await parseBase();
    const view = new MutablePropertyView(null, 'test-model');
    const editor = new StoreEditor(store, view);
    editor.addPropertySet(8, 'Pset_WallCommon', [
      { name: 'IsExternal', value: true, type: 'BOOLEAN' },
    ]);

    // The wall (#8) is hidden, so the visible-only closure must exclude it and
    // its host line never lands in DATA — the same closure `willBeEmitted`
    // consults for emission itself.
    const result = new StepExporter(store, view).export({
      schema: 'IFC4',
      visibleOnly: true,
      hiddenEntityIds: new Set([8]),
    });
    const text = new TextDecoder().decode(result.content);

    expect(text).not.toContain('#8=IFCWALL');
    // The header's modification claim must agree with what DATA actually
    // contains, not with the raw (visibility-blind) mutation record.
    expect(result.stats.modifiedEntityCount).toBe(0);
  });
});
