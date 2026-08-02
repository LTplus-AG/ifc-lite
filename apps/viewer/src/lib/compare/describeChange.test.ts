/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, it } from 'node:test';
import assert from 'node:assert';
import { IfcParser, type IfcDataStore } from '@ifc-lite/parser';
import type { DiffEntry } from '@ifc-lite/diff';
import type { FederatedModel } from '../../store/types.js';
import type { CompareRef } from './buildFingerprints.js';
import { describeChange, summarizeGeometryChange, type Aabb } from './describeChange.js';

const box = (min: [number, number, number], max: [number, number, number]): Aabb => ({ min, max });

describe('summarizeGeometryChange (#1197)', () => {
  it('reports no move and no reshape for an identical bounding box', () => {
    // The wall that "moved 1.09 m" had an identical bbox between revisions — a
    // re-tessellation dragged the old *vertex-weighted* centroid, not the box.
    const b = box([0, 0, 0], [3, 0.3, 2.7]);
    const summary = summarizeGeometryChange(b, { min: [...b.min] as [number, number, number], max: [...b.max] as [number, number, number] });
    assert.ok(summary);
    assert.strictEqual(summary!.movedDistance, 0, 'identical box must not read as moved');
    assert.strictEqual(summary!.reshaped, false);
  });

  it('reports a real translation as a move (box centre shifts)', () => {
    const a = box([0, 0, 0], [3, 0.3, 2.7]);
    const b = box([1, 0, 0], [4, 0.3, 2.7]); // +1 in x
    const summary = summarizeGeometryChange(a, b)!;
    assert.ok(Math.abs(summary.movedDistance - 1) < 1e-6, `expected ~1 m, got ${summary.movedDistance}`);
    assert.strictEqual(summary.reshaped, false);
  });

  it('snaps sub-tolerance jitter to zero (float noise is not a move)', () => {
    const a = box([0, 0, 0], [3, 0.3, 2.7]);
    const b = box([0.0005, 0, 0], [3.0005, 0.3, 2.7]); // 0.5 mm < MOVE_EPS
    const summary = summarizeGeometryChange(a, b)!;
    assert.strictEqual(summary.movedDistance, 0);
    assert.strictEqual(summary.reshaped, false);
  });

  it('detects a reshape when the box size changes', () => {
    const a = box([0, 0, 0], [3, 0.3, 2.7]);
    const b = box([0, 0, 0], [3.5, 0.3, 2.7]); // grew 0.5 m in x
    const summary = summarizeGeometryChange(a, b)!;
    assert.strictEqual(summary.reshaped, true);
    // Growing only in +x shifts the centre by half the growth — that is a
    // reshape, reported alongside any centre move.
    assert.ok(summary.movedDistance > 0);
    assert.ok(Math.abs(summary.sizeDelta.x - 0.5) < 1e-6);
  });

  it('treats a missing side as a (re)shaped change, never a phantom move', () => {
    const summary = summarizeGeometryChange(null, box([0, 0, 0], [1, 1, 1]))!;
    assert.strictEqual(summary.movedDistance, 0);
    assert.strictEqual(summary.reshaped, true);
  });
});

// ── USERDEFINED enum qualifier (#1401) ────────────────────────────────
// Version Compare used to render a removed/changed `.USERDEFINED.` enum as the
// bare, meaningless token "USERDEFINED". The real user-defined label lives in a
// companion attribute (ObjectType on occurrences, ElementType on type objects),
// so the display string must read "USERDEFINED (origin)". The raw comparison
// key is unchanged — only the presentation gains the qualifier.

/** Wrap one STEP body line in a minimal IFC4 envelope. */
function ifc4(body: string): string {
  return [
    'ISO-10303-21;',
    'HEADER;',
    "FILE_DESCRIPTION((''),'2;1');",
    "FILE_NAME('','',(''),(''),'','','');",
    "FILE_SCHEMA(('IFC4'));",
    'ENDSEC;',
    'DATA;',
    body,
    'ENDSEC;',
    'END-ISO-10303-21;',
    '',
  ].join('\n');
}

async function storeFromStep(body: string): Promise<IfcDataStore> {
  const bytes = new TextEncoder().encode(ifc4(body));
  const parser = new IfcParser();
  // disableWorkerScan keeps the scan in-process (no Worker in node test).
  return parser.parseColumnar(bytes.buffer as ArrayBuffer, { disableWorkerScan: true });
}

/** A two-model compare entry for the same element (local id 1) across A and B. */
function modifiedEntry(ifcType: string): DiffEntry<CompareRef> {
  const ref = (modelId: string): CompareRef => ({ modelId, localId: 1, globalId: 1 });
  return {
    key: 'element-key',
    state: 'modified',
    changeKinds: ['data'],
    base: { key: 'element-key', ifcType, dataHash: 'a', ref: ref('A') },
    head: { key: 'element-key', ifcType, dataHash: 'b', ref: ref('B') },
  };
}

function modelsFor(aStore: IfcDataStore, bStore: IfcDataStore): ReadonlyMap<string, FederatedModel> {
  return new Map<string, FederatedModel>([
    ['A', { ifcDataStore: aStore, geometryResult: null } as FederatedModel],
    ['B', { ifcDataStore: bStore, geometryResult: null } as FederatedModel],
  ]);
}

describe('describeChange — USERDEFINED enum qualifier (#1401)', () => {
  it('expands an occurrence PredefinedType=USERDEFINED with its ObjectType companion', async () => {
    // IfcWall attrs: [GlobalId, OwnerHistory, Name, Description, ObjectType,
    // ObjectPlacement, Representation, Tag, PredefinedType]. ObjectType="origin".
    const aStore = await storeFromStep(
      "#1=IFCWALL('1wall_a_guid_aaaaaaaaa',$,'Wall',$,'origin',$,$,$,.USERDEFINED.);",
    );
    const bStore = await storeFromStep(
      "#1=IFCWALL('1wall_b_guid_aaaaaaaaa',$,'Wall',$,'origin',$,$,$,.NOTDEFINED.);",
    );

    const detail = describeChange(modifiedEntry('IfcWall'), modelsFor(aStore, bStore));
    assert.ok(detail, 'expected a change detail for a modified entry');

    const predefined = detail!.data.find((d) => d.name === 'PredefinedType');
    assert.ok(predefined, 'expected a PredefinedType delta');
    assert.strictEqual(predefined!.before, 'USERDEFINED (origin)');
    // The non-USERDEFINED side stays a bare token (no spurious qualifier).
    assert.strictEqual(predefined!.after, 'NOTDEFINED');
  });

  it('keeps the bare token when the change is a removal but still qualifies the before side', async () => {
    // B drops PredefinedType entirely (8-attr wall) → the delta is a removal,
    // and the surviving A-side value must still read "USERDEFINED (origin)".
    const aStore = await storeFromStep(
      "#1=IFCWALL('1wall_c_guid_aaaaaaaaa',$,'Wall',$,'origin',$,$,$,.USERDEFINED.);",
    );
    const bStore = await storeFromStep(
      "#1=IFCWALL('1wall_d_guid_aaaaaaaaa',$,'Wall',$,'origin',$,$,$);",
    );

    const detail = describeChange(modifiedEntry('IfcWall'), modelsFor(aStore, bStore));
    const predefined = detail!.data.find((d) => d.name === 'PredefinedType');
    assert.ok(predefined, 'expected a PredefinedType delta');
    assert.strictEqual(predefined!.kind, 'removed');
    assert.strictEqual(predefined!.before, 'USERDEFINED (origin)');
  });

  it('uses the ElementType companion for type objects (IfcWallType)', async () => {
    // IfcWallType attrs: [GlobalId, OwnerHistory, Name, Description,
    // ApplicableOccurrence, HasPropertySets, RepresentationMaps, Tag,
    // ElementType, PredefinedType]. ElementType="origin".
    const aStore = await storeFromStep(
      "#1=IFCWALLTYPE('1type_a_guid_aaaaaaaaa',$,'Wall Type',$,$,$,$,$,'origin',.USERDEFINED.);",
    );
    const bStore = await storeFromStep(
      "#1=IFCWALLTYPE('1type_b_guid_aaaaaaaaa',$,'Wall Type',$,$,$,$,$,'origin',.NOTDEFINED.);",
    );

    const detail = describeChange(modifiedEntry('IfcWallType'), modelsFor(aStore, bStore));
    const predefined = detail!.data.find((d) => d.name === 'PredefinedType');
    assert.ok(predefined, 'expected a PredefinedType delta');
    assert.strictEqual(predefined!.before, 'USERDEFINED (origin)');
  });
});
