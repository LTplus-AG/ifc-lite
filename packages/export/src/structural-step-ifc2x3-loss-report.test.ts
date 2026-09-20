/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Issue #4206, IFC2X3 loss-report bar: "the loss report on export and IFC2X3
 * conversion is empty or names each attribute it could not carry."
 *
 * `structural-step-roundtrip.test.ts` proves the SAME-schema pass-through is
 * lossless. Converting the real Constructivity fixture DOWN to IFC2X3 is a
 * different question: IFC2X3 genuinely cannot represent every structural-
 * analysis entity IFC4 does (no curve/surface reaction type at all; no
 * varying-load configuration entity), and one of those —
 * `IfcStructuralLoadConfiguration` — is not an IfcRoot subtype, so
 * `exportToStep` cannot even fall back to an IFCPROXY for it: it throws
 * (`resolveUnrepresentedEntity`'s documented, pre-existing contract, the same
 * one `IFCTRIANGULATEDFACESET` already hits). `analyzeConversionLoss` is what
 * lets a caller learn that BEFORE attempting the export, and completely —
 * every offending type, not just the first record the export would have
 * aborted on.
 */

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { IfcParser, type IfcDataStore } from '@ifc-lite/parser';
import { exportToStep } from './step-exporter.js';
import { analyzeConversionLoss } from './schema-conversion-loss-report.js';

const FIXTURE = fileURLToPath(
  new URL('../../../tests/models/ifcopenshell/structural_analysis_curve.ifc', import.meta.url),
);
const fixtureAvailable = existsSync(FIXTURE);
const describeFixture = fixtureAvailable ? describe : describe.skip;

async function parse(bytes: Uint8Array): Promise<IfcDataStore> {
  const buf = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
  return new IfcParser().parseColumnar(buf);
}

describeFixture(
  `structural analysis IFC4 → IFC2X3 loss report (#4206)${fixtureAvailable ? '' : ' (skipped: run pnpm fixtures)'}`,
  () => {
    it('names every structural type IFC2X3 cannot carry, with express ids, before the export is attempted', async () => {
      const store = await parse(new Uint8Array(readFileSync(FIXTURE)));
      const report = analyzeConversionLoss(store, 'IFC4', 'IFC2X3');

      expect(report.hasLoss).toBe(true);
      expect(report.hasBlocking).toBe(true);

      const byType = new Map(report.entries.map((e) => [e.sourceType, e]));

      // Blocked: no IFC2X3 representation, and not an IfcRoot subtype — the
      // export would throw on these. The fixture's 4 IFCSTRUCTURALLOADCONFIGURATION
      // records (#326 the curve action's load, #2772/#2780/#2788 the three
      // curve reactions' computed results).
      expect(byType.get('IFCSTRUCTURALLOADCONFIGURATION')).toMatchObject({
        kind: 'blocked',
        count: 4,
        droppedAttributes: ['Name', 'Values', 'Locations'],
      });

      // Proxied: no IFC2X3 representation, but rooted — becomes IFCPROXY.
      // IFC2X3 never defined a curve/surface reaction entity at all.
      expect(byType.get('IFCSTRUCTURALCURVEREACTION')).toMatchObject({ kind: 'proxied', count: 3 });

      // Lossy (this PR's fix): renamed with a real IFC2X3 target, but not
      // every attribute survives.
      expect(byType.get('IFCSTRUCTURALLOADCASE')).toMatchObject({
        kind: 'lossy',
        targetType: 'IFCSTRUCTURALLOADGROUP',
        count: 1,
        droppedAttributes: ['SelfWeightCoefficients'],
      });
      expect(byType.get('IFCSTRUCTURALCURVEACTION')).toMatchObject({
        kind: 'lossy',
        targetType: 'IFCSTRUCTURALLINEARACTION',
        count: 1,
        droppedAttributes: ['PredefinedType'],
      });

      // The report is complete BEFORE any export is attempted -- it names all
      // four offending types in one pass, not just the first one a full
      // export would have aborted on.
      const describedTypes = report.describe().join('\n');
      expect(describedTypes).toContain('IFCSTRUCTURALLOADCONFIGURATION');
      expect(describedTypes).toContain('IFCSTRUCTURALCURVEREACTION');
      expect(describedTypes).toContain('IFCSTRUCTURALLOADCASE');
      expect(describedTypes).toContain('IFCSTRUCTURALCURVEACTION');
    });

    it('documents that exportToStep itself still throws on the blocking type (pre-existing resolveUnrepresentedEntity contract, not loosened by this fix)', async () => {
      const store = await parse(new Uint8Array(readFileSync(FIXTURE)));
      expect(() => exportToStep(store, { schema: 'IFC2X3' })).toThrow(/IFCSTRUCTURALLOADCONFIGURATION/);
    });
  },
);
