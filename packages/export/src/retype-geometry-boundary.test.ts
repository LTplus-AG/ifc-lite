/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Regression cover for #2861's sibling sweep: the source-iteration pass's
 * own geometry skip (step-exporter.ts, "Skip geometry if not included")
 * classified a source entity by its RAW authored type
 * (`entityRef.type.toUpperCase()`) instead of the EFFECTIVE type
 * (`pass.effective.effectiveType`, which folds in a retype). That skip must
 * agree with `isGeometryExcluded` — the predicate `hasEmittableHostBytes`
 * and `willBeEmitted` both consult to decide whether an edit gets counted
 * as a delivered modification (see the comment at `isGeometryExcluded`'s
 * definition, "this predicate must agree or a geometry entity's attribute
 * edit inflates the count over an omitted line", CodeRabbit finding on
 * #2414) — or a retype crossing the geometry boundary makes the two passes
 * disagree about whether a line survives `includeGeometry: false`.
 *
 * Every assertion here is against the emitted file TEXT, never against an
 * internal counter alone.
 */

import { describe, expect, it } from 'vitest';
import { IfcParser, type IfcDataStore } from '@ifc-lite/parser';
import { MutablePropertyView, StoreEditor } from '@ifc-lite/mutations';
import { StepExporter } from './step-exporter.js';

function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
}

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
#20=IFCCARTESIANPOINT((0.,0.,0.));
ENDSEC;
END-ISO-10303-21;`;

async function parseBase(): Promise<IfcDataStore> {
  return new IfcParser().parseColumnar(toArrayBuffer(new TextEncoder().encode(BASE_IFC)));
}

describe('STEP geometry skip vs a retype crossing the geometry boundary', () => {
  it('retyping a non-geometry entity INTO a geometry class must exclude its line under includeGeometry:false, the same as an entity born geometry', async () => {
    const store = await parseBase();
    const view = new MutablePropertyView(null, 'test-model');
    const editor = new StoreEditor(store, view);
    // #8 is authored as IFCWALL (not geometry). Retype it to IfcCartesianPoint
    // (on `isGeometryEntity`'s list) and edit an attribute.
    editor.setEntityType(8, 'IfcCartesianPoint');
    editor.setAttribute(8, 'Name', 'renamed');

    const result = new StepExporter(store, view).export({
      schema: 'IFC4',
      includeGeometry: false,
    });
    const text = new TextDecoder().decode(result.content);

    // The retyped-to-geometry line must not land in DATA.
    expect(text).not.toContain('#8=');
    expect(text).not.toContain('IFCCARTESIANPOINT($)');
    // ...and the header must not claim a modification for it either.
    expect(result.stats.modifiedEntityCount).toBe(0);
    expect(headerClaimedModifications(text)).toBeNull();
  });

  it('retyping a geometry entity OUT of a geometry class must emit its line under includeGeometry:false, the same as an entity born non-geometry', async () => {
    const store = await parseBase();
    const view = new MutablePropertyView(null, 'test-model');
    const editor = new StoreEditor(store, view);
    // #20 is authored as IFCCARTESIANPOINT (geometry). Retype it to IfcWall
    // (not geometry) and edit an attribute.
    editor.setEntityType(20, 'IfcWall');
    editor.setAttribute(20, 'Name', 'renamed');

    const result = new StepExporter(store, view).export({
      schema: 'IFC4',
      includeGeometry: false,
    });
    const text = new TextDecoder().decode(result.content);

    expect(text).toContain("#20=IFCWALL($,$,'renamed'");
    expect(result.stats.modifiedEntityCount).toBe(1);
    expect(headerClaimedModifications(text)).toBe(1);
  });

  it('bounding control: with geometry included, the retyped-to-geometry line survives and is counted', async () => {
    const store = await parseBase();
    const view = new MutablePropertyView(null, 'test-model');
    const editor = new StoreEditor(store, view);
    editor.setEntityType(8, 'IfcCartesianPoint');
    editor.setAttribute(8, 'Name', 'renamed');

    const result = new StepExporter(store, view).export({ schema: 'IFC4' });
    const text = new TextDecoder().decode(result.content);

    expect(text).toContain('#8=IFCCARTESIANPOINT($)');
    expect(result.stats.modifiedEntityCount).toBe(1);
  });
});
