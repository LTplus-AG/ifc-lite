/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Issue #4206, structural analysis write / round-trip layer.
 *
 * Structural analysis is read-only today, so same-schema export must use the
 * canonical STEP source-record pass-through rather than synthesising a second
 * writer which can drift from the source. This fixture test pins that contract
 * at both levels: every source entity record stays byte-identical, and the
 * structural read model reconstructed from the exported file stays identical.
 */

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  IfcParser,
  extractStructuralOnDemand,
  type IfcDataStore,
} from '@ifc-lite/parser';
import { exportToStep } from './step-exporter.js';

const FIXTURE = fileURLToPath(
  new URL('../../../tests/models/ifcopenshell/structural_analysis_curve.ifc', import.meta.url),
);
const fixtureAvailable = existsSync(FIXTURE);
const describeFixture = fixtureAvailable ? describe : describe.skip;

function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
}

async function parse(bytes: Uint8Array): Promise<IfcDataStore> {
  return new IfcParser().parseColumnar(toArrayBuffer(bytes));
}

/** Exact source STEP record by express id, excluding only file/header framing. */
function recordSnapshot(store: IfcDataStore): Map<number, string> {
  const records = new Map<number, string>();
  for (const [expressId, ref] of store.entityIndex.byId) {
    records.set(
      expressId,
      store.source.decodeUtf8(ref.byteOffset, ref.byteOffset + ref.byteLength),
    );
  }
  return records;
}

function structuralRecordCount(store: IfcDataStore): number {
  const relationshipTypes = new Set([
    'IFCRELASSIGNSTOGROUP',
    'IFCRELCONNECTSSTRUCTURALACTIVITY',
    'IFCRELCONNECTSSTRUCTURALMEMBER',
  ]);
  let count = 0;
  for (const ref of store.entityIndex.byId.values()) {
    if (
      ref.type.startsWith('IFCSTRUCTURAL') ||
      ref.type.startsWith('IFCBOUNDARY') ||
      relationshipTypes.has(ref.type)
    ) {
      count += 1;
    }
  }
  return count;
}

describeFixture(
  `STEP structural-analysis round trip (#4206)${fixtureAvailable ? '' : ' (skipped: run pnpm fixtures)'}`,
  () => {
    it('preserves every fixture record and reconstructs the same structural read model', async () => {
      const source = new Uint8Array(readFileSync(FIXTURE));
      const original = await parse(source);
      const before = extractStructuralOnDemand(original);

      // Use the public one-call path with no target-schema override: this is
      // the production same-schema pass-through contract, not a test helper.
      const exported = new TextEncoder().encode(exportToStep(original));
      const reparsed = await parse(exported);
      const after = extractStructuralOnDemand(reparsed);

      // Non-vacuous guards tied to the real Constructivity export. These stop
      // a missing/misclassified structural domain from making equality of two
      // empty snapshots look like fidelity.
      expect(before.hasStructural).toBe(true);
      expect(before.analysisModels).toHaveLength(1);
      expect(before.members).toHaveLength(3);
      expect(before.connections).toHaveLength(4);
      expect(before.activities).toHaveLength(10);
      expect(structuralRecordCount(original)).toBeGreaterThan(30);

      // The fixture diff requested by #4206: headers may be regenerated, but
      // no DATA record may move semantically or textually. Map equality pins
      // express ids, entity membership and the exact original STEP lexemes.
      expect(recordSnapshot(reparsed)).toEqual(recordSnapshot(original));

      // The consumer-level proof catches relationship or reference damage
      // even if a future exporter happens to reformat records equivalently.
      expect(after).toEqual(before);
    });
  },
);
