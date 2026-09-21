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
 * analysis entity IFC4 does (no curve/surface reaction type at all), and
 * `IfcStructuralLoadConfiguration` is not even an IfcRoot subtype, so it
 * cannot fall back to an IFCPROXY either — `analyzeConversionLoss` still
 * classifies all of these as loss (their records are genuinely never
 * written), but the export itself no longer THROWS on
 * `IfcStructuralLoadConfiguration` specifically: `convertStepLine` now omits
 * its record and redirects every referencing action/reaction to the same
 * proxy fallback an unmapped rooted type gets, instead of shipping (or
 * crashing on) a dangling `#N` (`WITHHOLDABLE_UNROOTED_TYPES`, #4206).
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

    it('no longer throws on IfcStructuralLoadConfiguration — the export now gets past it to a SEPARATE, pre-existing, out-of-scope gap', async () => {
      const store = await parse(new Uint8Array(readFileSync(FIXTURE)));
      // The fixture's curve members carry an `IfcMaterialProfileSet` cross-
      // section (Material resource domain, not structural analysis — out of
      // #4206's scope) that IFC2X3 also has no representation for and is
      // ALSO not an IfcRoot subtype. Before the withholding fix, this never
      // reached: `IfcStructuralLoadConfiguration` threw first, at a lower
      // express id. Asserting the failure has moved past every
      // `IFCSTRUCTURAL*` id is the regression guard: if the withholding fix
      // ever regresses, this reports LOADCONFIGURATION again, not silence.
      let caught: unknown;
      try {
        exportToStep(store, { schema: 'IFC2X3' });
      } catch (e) {
        caught = e;
      }
      expect(caught).toBeInstanceOf(Error);
      const message = (caught as Error).message;
      expect(message).not.toContain('IFCSTRUCTURALLOADCONFIGURATION');
      expect(message).toContain('IFCMATERIALPROFILESET');
    });
  },
);

/**
 * The real fixture's `IfcMaterialProfileSet` gap (above) means it cannot
 * prove a COMPLETE, successful IFC2X3 export end-to-end. This isolates the
 * structural-only chain — analysis model, load case, curve action and curve
 * reaction, each through an `IfcStructuralLoadConfiguration` — with no
 * material/profile cross-section, so the fix's actual claim (no crash, no
 * dangling reference, a valid file) is checked against real bytes.
 */
describe('IfcStructuralLoadConfiguration withholding, isolated from unrelated gaps (#4206)', () => {
  const MODEL = `ISO-10303-21;
HEADER;
FILE_DESCRIPTION((''),'2;1');
FILE_NAME('m','2024',(''),(''),'','','');
FILE_SCHEMA(('IFC4'));
ENDSEC;
DATA;
#1= IFCPROJECT('PROJ00000000000000000X',#45,'Proj',$,$,$,$,(#20),#30);
#20= IFCGEOMETRICREPRESENTATIONCONTEXT($,'Model',3,1.E-5,#21,$);
#21= IFCAXIS2PLACEMENT3D(#22,$,$);
#22= IFCCARTESIANPOINT((0.,0.,0.));
#30= IFCUNITASSIGNMENT((#31));
#31= IFCSIUNIT(*,.LENGTHUNIT.,$,.METRE.);
#40= IFCPERSON($,$,'Tester',$,$,$,$,$);
#41= IFCORGANIZATION($,'Org',$,$,$);
#42= IFCPERSONANDORGANIZATION(#40,#41,$);
#43= IFCORGANIZATION($,'AppDev',$,$,$);
#44= IFCAPPLICATION(#43,'1.0','App','app-id');
#45= IFCOWNERHISTORY(#42,#44,$,.ADDED.,$,$,$,0);
#209= IFCSTRUCTURALANALYSISMODEL('2iM64ZbGL9mQI5Uz2Gv6nD',#45,'Analysis Model #1',$,$,.LOADING_3D.,.GLOBAL_COORDS.,$,$,$);
#312= IFCSTRUCTURALLOADCASE('2fv4DZfY55exwX8QDy8dmw',#45,'Structural Load Case #1',$,$,.LOAD_CASE.,.NOTDEFINED.,.NOTDEFINED.,1.,$,(0.,0.,0.));
#317= IFCSTRUCTURALCURVEACTION('2WSwGyLsrFNA9TLOq_ifyd',#45,'Structural Curve Action #1',$,$,$,$,#326,.GLOBAL_COORDS.,.F.,$,.LINEAR.);
#326= IFCSTRUCTURALLOADCONFIGURATION($,(#327,#329),((96.)));
#327= IFCSTRUCTURALLOADSINGLEFORCE('F1',10.,0.,0.,0.,0.,0.);
#329= IFCSTRUCTURALLOADSINGLEFORCE('F2',20.,0.,0.,0.,0.,0.);
#2773= IFCSTRUCTURALCURVEREACTION('0SH7YcIWrB8Q4VcWjfXpnn',#45,$,$,$,$,$,#2772,.GLOBAL_COORDS.,.DISCRETE.);
#2772= IFCSTRUCTURALLOADCONFIGURATION('Member End Reactions',(#2770,#2771),((0.),(120.)));
#2770= IFCSTRUCTURALLOADSINGLEFORCE('R1',5.,0.,0.,0.,0.,0.);
#2771= IFCSTRUCTURALLOADSINGLEFORCE('R2',6.,0.,0.,0.,0.,0.);
ENDSEC;
END-ISO-10303-21;
`;

  it('exports to valid IFC2X3 with no dangling references, no crash', async () => {
    const store = await parse(new TextEncoder().encode(MODEL));
    const content = exportToStep(store, { schema: 'IFC2X3' });

    expect(content).toContain("FILE_SCHEMA(('IFC2X3'))");
    // Both LoadConfiguration records are omitted entirely.
    expect(content).not.toContain('IFCSTRUCTURALLOADCONFIGURATION');
    expect(content).not.toMatch(/#326\s*=/);
    expect(content).not.toMatch(/#2772\s*=/);
    // Their sole referrers (AppliedLoad) cannot carry that reference forward,
    // so they become proxies -- not renamed to LINEARACTION, which would
    // otherwise still name `#326`.
    expect(content).toContain('IFCPROXY');
    expect(content).not.toContain('IFCSTRUCTURALLINEARACTION');

    // The LOAD_CASE rename (unaffected by withholding -- its own record
    // references no withheld id) still applies normally.
    expect(content).toContain('IFCSTRUCTURALLOADGROUP');

    // No line in the FINAL output references an id that has no `#id=` line
    // of its own -- the definition of "no dangling reference".
    const ids = new Set<number>();
    for (const m of content.matchAll(/^#(\d+)\s*=/gm)) ids.add(Number(m[1]));
    const referenced = new Set<number>();
    for (const m of content.matchAll(/#(\d+)/g)) referenced.add(Number(m[1]));
    for (const id of referenced) {
      expect(ids.has(id)).toBe(true);
    }

    // The standalone load-value records (LoadSingleForce) have their own
    // valid IFC2X3 representation (same type, same attributes in both
    // schemas) and are still written -- now simply unreferenced by anything,
    // which is harmless: a full export writes every source record, and an
    // orphaned value is not a dangling REFERENCE (nothing names an id with
    // no `#id=` line).
    expect(content).toMatch(/#327\s*=IFCSTRUCTURALLOADSINGLEFORCE/);
  });
});
