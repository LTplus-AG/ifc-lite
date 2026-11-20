/* SPDX-License-Identifier: MPL-2.0 */
/**
 * Registry check (#10902): every type a source schema declares and the target
 * does not is routed, never written verbatim unseen. For each schema pair it
 * partitions the source-only types by `convertRecord`'s own decisions and pins
 * the partition to `rust/export/tests/fixtures/schema_unrepresented_vectors.json`
 * (`routes`), which the Rust twin checks name by name (`schema_unrepresented.rs`). A new source-only type, or a listed gap
 * that gets fixed, fails here until the fixture says so.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { attrNameTable, convertEntityType, shouldSkipEntity, type IfcSchemaVersion } from './schema-converter.js';
import { isRootedEntityType, missingTypeRoute, VERBATIM_UPGRADE } from './schema-untranslatable.js';
import { IfcParser } from '@ifc-lite/parser';
import { StepExporter } from './step-exporter.js';
import { analyzeConversionLoss } from './schema-conversion-loss-report.js';

type Routes = { verbatim?: string[]; proxied?: string[]; structural?: string[] };
const fixture: { routes: Record<string, Routes> } = JSON.parse(readFileSync(
  fileURLToPath(new URL('../../../rust/export/tests/fixtures/schema_unrepresented_vectors.json', import.meta.url)), 'utf8'));

const SCHEMAS: IfcSchemaVersion[] = ['IFC2X3', 'IFC4', 'IFC4X3'];

/** The source-only types of `from -> to` by route; renamed onto a declared type, or an alignment product proxy, needs no entry. */
function partition(from: IfcSchemaVersion, to: IfcSchemaVersion): { verbatim: string[]; proxied: string[]; refused: string[]; structural: string[] } {
  const src = attrNameTable(from)!, tgt = attrNameTable(to)!;
  const out = { verbatim: [] as string[], proxied: [] as string[], refused: [] as string[], structural: [] as string[] };
  for (const type of src.keys()) {
    const newType = convertEntityType(type, from, to);
    if (shouldSkipEntity(newType, to)) continue;
    const route = missingTypeRoute(type, from, to, true, tgt.has(newType));
    if (route === 'verbatim' || route === 'structural') out[route].push(type);
    else if (route === 'unrepresented') (isRootedEntityType(type) ? out.proxied : out.refused).push(type);
  }
  for (const list of Object.values(out)) list.sort();
  return out;
}

describe('every source-only type has a route (#10902)', () => {
  for (const from of SCHEMAS) {
    for (const to of SCHEMAS) {
      if (from === to) continue;
      const pair = `${from}>${to}`;
      it(`${pair}: written verbatim only where the fixture names the gap`, () => {
        const got = partition(from, to);
        expect(got.verbatim).toEqual([...(fixture.routes[pair]?.verbatim ?? [])].sort());
        expect(got.structural).toEqual([...(fixture.routes[pair]?.structural ?? [])].sort());
        // The upgrade's proxies are pinned so Rust can check each one; elsewhere only the verbatim gaps are.
        if (pair === 'IFC2X3>IFC4') expect(got.proxied).toEqual([...(fixture.routes[pair].proxied ?? [])].sort());
      });
    }
  }

  it('IFC2X3 -> IFC4 writes verbatim exactly the listed types, and proxies the other rooted ones', () => {
    const { verbatim, proxied, refused } = partition('IFC2X3', 'IFC4');
    expect(verbatim).toEqual([...VERBATIM_UPGRADE].sort());
    expect(refused).toEqual([]);
    expect(proxied).toContain('IFCRELOCCUPIESSPACES');
    // Renamed to IfcTask, so neither needs a route.
    expect([...verbatim, ...proxied]).not.toContain('IFCMOVE');
    expect([...verbatim, ...proxied]).not.toContain('IFCORDERACTION');
  });
});

describe('an IFC2X3 -> IFC4 upgrade writes each route, and the loss report names it (#10902)', () => {
  const text = `ISO-10303-21;\nHEADER;\nFILE_DESCRIPTION((''),'2;1');\nFILE_NAME('t.ifc','',(''),(''),'','','');\nFILE_SCHEMA(('IFC2X3'));\nENDSEC;\nDATA;
#1=IFCPROJECT('0YvctVUKr0kugbFTf53O9L',$,'P',$,$,$,$,$,$);
#2=IFCSPACE('0AvctVUKr0kugbFTf53O9L',$,'Room',$,$,$,$,$,.ELEMENT.,.INTERNAL.,$);
#3=IFCACTOR('0BvctVUKr0kugbFTf53O9L',$,'Tenant',$,$,$);
#4=IFCRELOCCUPIESSPACES('0CvctVUKr0kugbFTf53O9L',$,$,$,(#2),$,#3,$);
#5=IFCMOVE('0DvctVUKr0kugbFTf53O9L',$,'Move',$,$,'T-1','planned',$,.F.,1,$,$,('pack'));
#6=IFCCALENDARDATE(1,2,2020);
ENDSEC;\nEND-ISO-10303-21;\n`;
  it('maps, proxies or keeps each record, and reports all three', async () => {
    const store = await new IfcParser().parseColumnar(new TextEncoder().encode(text).buffer as ArrayBuffer);
    const out = new TextDecoder().decode(new StepExporter(store).export({ schema: 'IFC4' }).content).split('\n');
    const line = (id: number) => out.find((l) => l.startsWith(`#${id}=`));
    expect(line(4)).toMatch(/^#4=IFCPROXY\('[^']+',\$,'IFCRELOCCUPIESSPACES',\$,\$,\$,\$,\.NOTDEFINED\.,\$\);$/);
    expect(line(5)).toBe("#5=IFCTASK('0DvctVUKr0kugbFTf53O9L',$,'Move',$,$,'T-1',$,'planned',$,.F.,1,$,$);");
    expect(line(6)).toBe('#6=IFCCALENDARDATE(1,2,2020);');
    const entries = analyzeConversionLoss(store, 'IFC2X3', 'IFC4').entries;
    const entry = (type: string) => entries.find((e) => e.sourceType === type);
    expect(entry('IFCRELOCCUPIESSPACES')).toMatchObject({ kind: 'proxied', targetType: 'IFCPROXY', expressIds: [4] });
    expect(entry('IFCMOVE')).toMatchObject({ kind: 'lossy', targetType: 'IFCTASK', droppedAttributes: ['MoveFrom', 'MoveTo', 'PunchList'], expressIds: [5] });
    expect(entry('IFCCALENDARDATE')).toMatchObject({ kind: 'lossy', targetType: 'IFCCALENDARDATE', expressIds: [6] });
  });
});
