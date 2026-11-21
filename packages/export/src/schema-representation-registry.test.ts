/* SPDX-License-Identifier: MPL-2.0 */
/**
 * Registry check (#10902): every type a source schema declares and the target
 * does not is routed, never written verbatim unseen. For each schema pair it
 * partitions the source-only types by the conversion loss classifier's decisions and pins
 * the partition to `rust/export/tests/fixtures/schema_unrepresented_vectors.json`
 * (`routes`), which the Rust twin checks name by name (`schema_unrepresented.rs`). A new source-only type, or a listed gap
 * that gets fixed, fails here until the fixture says so.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { attrNameTable, convertEntityType, shouldSkipEntity, type IfcSchemaVersion } from './schema-converter.js';
import { IfcParser } from '@ifc-lite/parser';
import { StepExporter } from './step-exporter.js';
import { analyzeConversionLoss, classifyEntityTypeConversion } from './schema-conversion-loss-report.js';

type Routes = { verbatim?: string[]; proxied?: string[]; handled?: string[] };
const fixture: { routes: Record<string, Routes> } = JSON.parse(readFileSync(
  fileURLToPath(new URL('../../../rust/export/tests/fixtures/schema_unrepresented_vectors.json', import.meta.url)), 'utf8'));

const SCHEMAS: IfcSchemaVersion[] = ['IFC2X3', 'IFC4', 'IFC4X3'];

/** `data` (DATA section records) as a parsed `schema` file. */
const parse = (schema: IfcSchemaVersion, data: string) => new IfcParser().parseColumnar(new TextEncoder().encode(
  `ISO-10303-21;\nHEADER;\nFILE_DESCRIPTION((''),'2;1');\nFILE_NAME('t.ifc','',(''),(''),'','','');\nFILE_SCHEMA(('${schema}'));\nENDSEC;\nDATA;${data}ENDSEC;\nEND-ISO-10303-21;\n`).buffer as ArrayBuffer);

/** The source-only types of `from -> to` by route; renamed onto a declared type, or an alignment product proxy, needs no entry. */
function partition(from: IfcSchemaVersion, to: IfcSchemaVersion): { verbatim: string[]; proxied: string[]; refused: string[]; handled: string[] } {
  const src = attrNameTable(from)!, tgt = attrNameTable(to)!;
  const out = { verbatim: [] as string[], proxied: [] as string[], refused: [] as string[], handled: [] as string[] };
  for (const type of src.keys()) {
    const newType = convertEntityType(type, from, to);
    if (tgt.has(newType) || shouldSkipEntity(newType, to)) continue;
    const { kind } = classifyEntityTypeConversion(type, from, to);
    if (kind === 'lossy') out.verbatim.push(type);
    else if (kind === 'proxied') out.proxied.push(type);
    else if (kind === 'blocked') out.refused.push(type);
    else out.handled.push(type);
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
        expect(got.handled).toEqual([...(fixture.routes[pair]?.handled ?? [])].sort());
        // The upgrade's proxies are pinned so Rust can check each one; elsewhere only the verbatim gaps are.
        if (pair === 'IFC2X3>IFC4') expect(got.proxied).toEqual([...(fixture.routes[pair].proxied ?? [])].sort());
      });
    }
  }

  it('IFC2X3 -> IFC4 writes verbatim exactly the listed types, and proxies the other rooted ones', () => {
    const { verbatim, proxied, refused } = partition('IFC2X3', 'IFC4');
    expect(refused).toEqual([]);
    expect(proxied).toContain('IFCSERVICELIFE');
    // Written as their IFC4 supertype, so none needs a route.
    for (const type of ['IFCMOVE', 'IFCORDERACTION', 'IFCRELOCCUPIESSPACES', 'IFCRELASSIGNSTASKS',
      'IFCRELASSIGNSTOPROJECTORDER', 'IFCRELSCHEDULESCOSTITEMS']) {
      expect([...verbatim, ...proxied], type).not.toContain(type);
    }
    // Its overrides would be lost silently as IfcRelDefinesByProperties, so it stays a proxy.
    expect(proxied).toContain('IFCRELOVERRIDESPROPERTIES');
  });
});

describe('an IFC2X3 -> IFC4 upgrade writes each route, and the loss report names it (#10902)', () => {
  const text = `
#1=IFCPROJECT('0YvctVUKr0kugbFTf53O9L',$,'P',$,$,$,$,$,$);
#2=IFCSPACE('0AvctVUKr0kugbFTf53O9L',$,'Room',$,$,$,$,$,.ELEMENT.,.INTERNAL.,$);
#3=IFCACTOR('0BvctVUKr0kugbFTf53O9L',$,'Tenant',$,$,$);
#4=IFCRELOCCUPIESSPACES('0CvctVUKr0kugbFTf53O9L',$,$,$,(#2),$,#3,$);
#5=IFCMOVE('0DvctVUKr0kugbFTf53O9L',$,'Move',$,$,'T-1','planned',$,.F.,1,$,$,('pack'));
#6=IFCCALENDARDATE(1,2,2020);
#7=IFCSERVICELIFE('0EvctVUKr0kugbFTf53O9L',$,'Life',$,$,.ACTUALSERVICELIFE.,10.);
#8=IFCRELASSIGNSTASKS('0FvctVUKr0kugbFTf53O9L',$,$,$,(#5),$,#9,$);
#9=IFCWORKPLAN('0GvctVUKr0kugbFTf53O9L',$,'Plan',$,$,'WP1',#6,$,$,$,$,#6,$,$,$);
`;
  it('maps, renames, proxies or keeps each record, and reports them', async () => {
    const store = await parse('IFC2X3', text);
    const out = new TextDecoder().decode(new StepExporter(store).export({ schema: 'IFC4' }).content).split('\n');
    const line = (id: number) => out.find((l) => l.startsWith(`#${id}=`));
    expect(line(4)).toBe("#4=IFCRELASSIGNSTOACTOR('0CvctVUKr0kugbFTf53O9L',$,$,$,(#2),$,#3,$);");
    expect(line(7)).toMatch(/^#7=IFCPROXY\('[^']+',\$,'IFCSERVICELIFE',\$,\$,\$,\$,\.NOTDEFINED\.,\$\);$/);
    expect(line(5)).toBe("#5=IFCTASK('0DvctVUKr0kugbFTf53O9L',$,'Move',$,$,'T-1',$,'planned',$,.F.,1,$,$);");
    expect(line(6)).toBe('#6=IFCCALENDARDATE(1,2,2020);');
    const entries = analyzeConversionLoss(store, 'IFC2X3', 'IFC4').entries;
    const entry = (type: string) => entries.find((e) => e.sourceType === type);
    // Its supertype holds every attribute, so nothing is lost to report.
    expect(entry('IFCRELOCCUPIESSPACES')).toBeUndefined();
    expect(entry('IFCSERVICELIFE')).toMatchObject({ kind: 'proxied', targetType: 'IFCPROXY', expressIds: [7] });
    expect(line(8)).toBe("#8=IFCRELASSIGNSTOCONTROL('0FvctVUKr0kugbFTf53O9L',$,$,$,(#5),$,#9);");
    expect(entry('IFCRELASSIGNSTASKS')).toMatchObject({ kind: 'lossy', targetType: 'IFCRELASSIGNSTOCONTROL', droppedAttributes: ['TimeForTask'], expressIds: [8] });
    expect(entry('IFCMOVE')).toMatchObject({ kind: 'lossy', targetType: 'IFCTASK', droppedAttributes: ['MoveFrom', 'MoveTo', 'PunchList'], expressIds: [5] });
    expect(entry('IFCCALENDARDATE')).toMatchObject({ kind: 'lossy', targetType: 'IFCCALENDARDATE', expressIds: [6] });
  });
});

it.each(['IFC4', 'IFC4X3'] as const)('keeps the project order as the relating control after upgrading to %s (#10902)', async (schema) => {
  const source = readFileSync(new URL('../../../rust/export/tests/fixtures/ifc2x3-project-order.ifc', import.meta.url));
  const store = await new IfcParser().parseColumnar(Uint8Array.from(source).buffer);
  const out = new TextDecoder().decode(new StepExporter(store).export({ schema }).content);
  expect(out).toMatch(/^#7=IFCPROJECTORDER\(.*,'PO-7',\.PURCHASEORDER\.,'Issued',\$\);$/m);
  expect(out).toMatch(/^#8=IFCRELASSIGNSTOCONTROL\(.*,\(#6\),\$,#7\);$/m);
});

it('names no IfcPresentationStyleAssignment lost when style flattening carries it into IFC4X3 (D57, #10902)', async () => {
  const text = `
#1=IFCPROJECT('0YvctVUKr0kugbFTf53O9L',$,'P',$,$,$,$,$,$);
#2=IFCCOLOURRGB($,1.,0.,0.);
#3=IFCSURFACESTYLESHADING(#2,$);
#4=IFCSURFACESTYLE($,.BOTH.,(#3));
#5=IFCPRESENTATIONSTYLEASSIGNMENT((#4));
#6=IFCSTYLEDITEM($,(#5),$);
`;
  const store = await parse('IFC4', text);
  expect(analyzeConversionLoss(store, 'IFC4', 'IFC4X3').entries.find((e) => e.sourceType === 'IFCPRESENTATIONSTYLEASSIGNMENT')).toBeUndefined();
  const out = new TextDecoder().decode(new StepExporter(store).export({ schema: 'IFC4X3' }).content);
  // Carried: the styled item names the style itself.
  expect(out).toContain('#6=IFCSTYLEDITEM($,(#4),$);');
  expect(classifyEntityTypeConversion('IFCPRESENTATIONSTYLEASSIGNMENT', 'IFC2X3', 'IFC4X3').kind).toBe('identity');
});
