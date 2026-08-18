/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Coverage gap named by github.com/LTplus-AG/ifc-lite/issues/2475: the
 * `hasEmittableHostBytes` gate in the non-georef attribute mutation
 * collection loop (`step-exporter.ts`, `for (const [entityId] of
 * modifiedAttributes)`) has two independent reasons to say "no" for a
 * source-backed host — no readable source bytes, and exclusion from a
 * `visibleOnly` closure (`allowedEntityIds`) — but no existing test combined
 * `visibleOnly` with `deltaOnly` for a plain attribute edit, so the
 * `visibleOnly` half of that gate was never exercised under `deltaOnly`.
 *
 * That combination matters because `deltaOnly`'s per-kind warning exists to
 * NAME an edit the delta format could not carry (`delta-modification-ledger.ts`).
 * A host hidden by `visibleOnly` was never going to have its line emitted —
 * full export or delta, visible or not — so nominating it here would produce
 * a warning that misattributes the drop to the delta format instead of to the
 * `hiddenEntityIds` the caller supplied. `hasEmittableHostBytes`'s
 * `allowedEntityIds` check (unlike its `isGeometryExcluded` check, which is
 * deliberately `!deltaOnly`-gated — see the block comment above it) runs
 * unconditionally, so `line 860`'s `continue` is what keeps the hidden host
 * out of `inPlaceNominees.attribute` and therefore out of the warning.
 *
 * Both cases are asserted against the same base file and the same edit, so
 * the only variable is whether the host is hidden.
 */

import { describe, expect, it } from 'vitest';
import { IfcParser, type IfcDataStore } from '@ifc-lite/parser';
import { MutablePropertyView, StoreEditor } from '@ifc-lite/mutations';
import { StepExporter } from './step-exporter.js';

function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
}

const WALL_ID = 8;

const BASE_IFC = `ISO-10303-21;
HEADER;
FILE_DESCRIPTION(('ViewDefinition[DesignTransferView]'),'2;1');
FILE_NAME('base.ifc','2026-08-08T10:00:00+01:00',(''),(''),'ifc-lite','ifc-lite','');
FILE_SCHEMA(('IFC4'));
ENDSEC;
DATA;
#1=IFCPROJECT('0OSuGGYUFyIf0LtE29OSuG',$,'My Project',$,$,$,$,$,$);
#8=IFCWALL('0OSuGGYUFyIf0LtE29OSuH',$,'Existing Wall',$,$,$,$,$,$);
ENDSEC;
END-ISO-10303-21;`;

async function parseBase(): Promise<IfcDataStore> {
  return new IfcParser().parseColumnar(toArrayBuffer(new TextEncoder().encode(BASE_IFC)));
}

function newSession(store: IfcDataStore) {
  const view = new MutablePropertyView(null, 'test-model');
  return { view, editor: new StoreEditor(store, view) };
}

describe('visibleOnly + deltaOnly: attribute nomination on a hidden host', () => {
  it('a hidden host\'s attribute edit is not nominated and produces no delta warning', async () => {
    const store = await parseBase();
    const { view, editor } = newSession(store);
    editor.setAttribute(WALL_ID, 'Name', 'Renamed Wall');

    const result = new StepExporter(store, view).export({
      schema: 'IFC4',
      visibleOnly: true,
      hiddenEntityIds: new Set([WALL_ID]),
      deltaOnly: true,
    });

    expect(result.stats.modifiedEntityCount).toBe(0);
    // The wrong outcome here is a warning that blames deltaOnly for a drop
    // that was actually caused by hiddenEntityIds.
    expect(result.stats.warnings).toEqual([]);
  });

  it('bounding control: the SAME edit on the SAME host, not hidden, still warns under deltaOnly', async () => {
    const store = await parseBase();
    const { view, editor } = newSession(store);
    editor.setAttribute(WALL_ID, 'Name', 'Renamed Wall');

    const result = new StepExporter(store, view).export({
      schema: 'IFC4',
      deltaOnly: true,
    });

    expect(result.stats.modifiedEntityCount).toBe(0);
    expect(result.stats.warnings).toHaveLength(1);
    expect(result.stats.warnings[0]).toContain(`#${WALL_ID}`);
    expect(result.stats.warnings[0]).toContain('attribute edits');
  });
});
