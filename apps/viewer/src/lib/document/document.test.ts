/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Documents (#4594) over a parsed model: bindings resolve real values and
 * say why when they cannot, a template re-opened on another model reads
 * that model, the page composes with breaks, and the PDF is drawn from the
 * resolved blocks through recording seams.
 */
import { describe, it, before } from 'node:test';
import assert from 'node:assert/strict';
import { IfcParser, type IfcDataStore } from '@ifc-lite/parser';
import { aggregate, type Aggregation } from '@ifc-lite/charts';
import type { BCFTopic } from '@ifc-lite/bcf';
import { parsePath, renderTemplate, resolveBinding, templatePaths, type BindingContext } from './bindings.js';
import { composeDocument, estimateTextWidth, wrapText } from './compose.js';
import { generateDocumentPdf, topicLines, type DocumentPdfSeams } from './generate-document-pdf.js';
import { parseDocumentFile } from './persistence.js';
import { blankDocument, coverSheetDocument } from './presets.js';
import { validateDocumentSpec, type DocumentSpec } from './types.js';
import { elementsDataset } from '@ifc-lite/charts';

const ifc = (project: string, wallName: string, fireRating: string): string => `ISO-10303-21;
HEADER;
FILE_DESCRIPTION((''),'2;1');
FILE_NAME('t','',(''),(''),'','','');
FILE_SCHEMA(('IFC4'));
ENDSEC;
DATA;
#1=IFCPROJECT('0Project0000000000000a',$,'${project}','Desc',$,'Long ${project}',$,$,$);
#2=IFCSITE('0Site000000000000000002',$,'Site',$,$,$,$,$,.ELEMENT.,$,$,$,$,$);
#3=IFCBUILDING('0Building00000000000003',$,'Building',$,$,$,$,$,.ELEMENT.,$,$,$);
#5=IFCBUILDINGSTOREY('0Storey00000000000005',$,'Level 1',$,$,$,$,$,.ELEMENT.,0.);
#6=IFCBUILDINGSTOREY('0Storey00000000000006',$,'Level 2',$,$,$,$,$,.ELEMENT.,3.);
#11=IFCRELAGGREGATES('0Agg000000000000000011',$,$,$,#1,(#2));
#12=IFCRELAGGREGATES('0Agg000000000000000012',$,$,$,#2,(#3));
#13=IFCRELAGGREGATES('0Agg000000000000000013',$,$,$,#3,(#5,#6));
#20=IFCCARTESIANPOINT((0.,0.,0.));
#21=IFCDIRECTION((0.,0.,1.));
#22=IFCDIRECTION((1.,0.,0.));
#23=IFCAXIS2PLACEMENT3D(#20,#21,#22);
#24=IFCLOCALPLACEMENT($,#23);
#25=IFCRECTANGLEPROFILEDEF(.AREA.,$,#23,1.,1.);
#26=IFCEXTRUDEDAREASOLID(#25,#23,#21,1.);
#27=IFCSHAPEREPRESENTATION($,'Body','SweptSolid',(#26));
#28=IFCPRODUCTDEFINITIONSHAPE($,$,(#27));
#41=IFCWALL('0Wall00000000000000041',$,'${wallName}',$,$,#24,#28,'W-41',$);
#42=IFCWALL('0Wall00000000000000042',$,'Wall B',$,$,#24,#28,$,$);
#44=IFCDOOR('0Door00000000000000044',$,'Door A',$,$,#24,#28,$,$,$,$,$);
#50=IFCPROPERTYSINGLEVALUE('FireRating',$,IFCLABEL('${fireRating}'),$);
#51=IFCPROPERTYSET('0Pset000000000000000051',$,'Pset_WallCommon',$,(#50));
#52=IFCRELDEFINESBYPROPERTIES('0Rel000000000000000052',$,$,$,(#41),#51);
#90=IFCRELCONTAINEDINSPATIALSTRUCTURE('0Rel000000000000000090',$,$,$,(#41,#42),#5);
#91=IFCRELCONTAINEDINSPATIALSTRUCTURE('0Rel000000000000000091',$,$,$,(#44),#6);
ENDSEC;
END-ISO-10303-21;
`;

async function parse(text: string): Promise<IfcDataStore> {
  const bytes = new TextEncoder().encode(text);
  return new IfcParser().parseColumnar(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength));
}

const WALL = '0Wall00000000000000041';
let ctx: BindingContext;
let revised: BindingContext;

before(async () => {
  const today = new Date('2026-09-12T10:00:00Z');
  ctx = { models: [{ id: 'm1', name: 'tower.ifc', store: await parse(ifc('Tower', 'Wall A', 'REI60')) }], activeModelId: 'm1', today };
  revised = { models: [{ id: 'm2', name: 'tower-rev2.ifc', store: await parse(ifc('Tower rev 2', 'Wall A (moved)', 'REI90')) }], activeModelId: 'm2', today };
});

describe('bindings', () => {
  it('parses paths with quoted and bare selectors and rejects malformed ones', () => {
    assert.deepEqual(parsePath('IfcBuildingStorey["Level 1"].Name'), [{ name: 'IfcBuildingStorey', selector: 'Level 1' }, { name: 'Name' }]);
    assert.deepEqual(parsePath(`Element[${WALL}].Pset_WallCommon.FireRating`), [{ name: 'Element', selector: WALL }, { name: 'Pset_WallCommon' }, { name: 'FireRating' }]);
    assert.equal(parsePath('IfcProject.[x'), null);
    assert.equal(parsePath('IfcProject..Name'), null);
    assert.deepEqual(templatePaths('A {IfcProject.Name} and { Today }'), ['IfcProject.Name', 'Today']);
  });

  it('resolves project, spatial, storey, element, property, count and model values from the parsed file', () => {
    const v = (path: string): string => {
      const r = resolveBinding(path, ctx);
      assert.ok(r.ok, `${path}: ${r.reason}`);
      return r.value;
    };
    assert.equal(v('IfcProject.Name'), 'Tower');
    assert.equal(v('IfcProject.LongName'), 'Long Tower');
    assert.equal(v('IfcProject.Description'), 'Desc');
    assert.equal(v('IfcSite.Name'), 'Site');
    assert.equal(v('IfcBuilding.Name'), 'Building');
    assert.equal(v('IfcBuildingStorey["Level 2"].Elevation'), '3.00 m');
    assert.equal(v('IfcBuildingStorey[1].Name'), 'Level 1');
    assert.equal(v('IfcBuildingStorey["Level 1"].Elements'), '2');
    assert.equal(v(`Element[${WALL}].Name`), 'Wall A');
    assert.equal(v(`Element[${WALL}].Type`), 'IfcWall');
    assert.equal(v(`Element[${WALL}].Tag`), 'W-41');
    assert.equal(v(`Element[${WALL}].Storey`), 'Level 1');
    assert.equal(v(`Element[${WALL}].Pset_WallCommon.FireRating`), 'REI60');
    assert.equal(v('Count[IfcWall]'), '2');
    assert.equal(v('Count[IfcBuildingStorey]'), '2');
    assert.equal(v('Model.Name'), 'tower.ifc');
    assert.equal(v('Model.Schema'), 'IFC4');
    assert.equal(v('Model.Elements'), '3');
    assert.equal(v('Today'), '2026-09-12');
  });

  it('says why a binding does not resolve, and a template prints the reason instead of nothing', () => {
    const cases: Array<[string, RegExp]> = [
      ['IfcBuildingStorey["Roof"].Name', /no IfcBuildingStorey "Roof"/],
      ['Element[0Nope0000000000000000].Name', /no element with GlobalId/],
      [`Element[${WALL}].Pset_WallCommon.LoadBearing`, /no Pset_WallCommon.LoadBearing/],
      ['Count[IfcSpaceship]', /unknown IFC class/],
      ['Whatever.Name', /unknown root/],
      ['IfcProject.Owner', /unknown attribute/],
    ];
    for (const [path, reason] of cases) {
      const r = resolveBinding(path, ctx);
      assert.equal(r.ok, false, path);
      assert.match(r.reason ?? '', reason, path);
    }
    const rendered = renderTemplate('Project {IfcProject.Name}, roof {IfcBuildingStorey["Roof"].Name}.', ctx);
    assert.equal(rendered.text, 'Project Tower, roof [IfcBuildingStorey["Roof"].Name: no IfcBuildingStorey "Roof"].');
    assert.deepEqual(rendered.bindings.map((b) => b.ok), [true, false]);
    assert.equal(renderTemplate('{IfcProject.Name}', { models: [], activeModelId: null, today: ctx.today }).text, '[IfcProject.Name: no model loaded]');
  });

  it('the same template re-opened on the next revision reads that revision — by GlobalId, not by cached value', () => {
    const template = `{IfcProject.Name}: {Element[${WALL}].Name} is {Element[${WALL}].Pset_WallCommon.FireRating}`;
    assert.equal(renderTemplate(template, ctx).text, 'Tower: Wall A is REI60');
    assert.equal(renderTemplate(template, revised).text, 'Tower rev 2: Wall A (moved) is REI90');
  });
});

describe('document file', () => {
  it('validates the shape, re-identifies an imported template and keeps its bindings', () => {
    const doc = coverSheetDocument();
    assert.deepEqual(validateDocumentSpec(doc), []);
    const imported = parseDocumentFile(JSON.stringify(doc));
    assert.notEqual(imported.id, doc.id);
    assert.equal(imported.blocks.length, doc.blocks.length);
    imported.blocks.forEach((b, i) => assert.notEqual(b.id, doc.blocks[i].id));
    assert.equal((imported.blocks[0] as { text: string }).text, '{IfcProject.LongName}');
    assert.throws(() => parseDocumentFile(JSON.stringify({ ...doc, version: 2 })), /Not a document file: version expected version 1/);
    const broken = { ...doc, blocks: [{ kind: 'image', id: 'i', dataUrl: 'http://x/logo.png', height: 0, align: 'middle' }] };
    assert.deepEqual(validateDocumentSpec(broken).map((e) => e.path), ['blocks[0].dataUrl', 'blocks[0].height', 'blocks[0].align']);
  });
});

describe('compose', () => {
  it('wraps by the measure, breaks pages, and keeps a heading with its next line', () => {
    assert.deepEqual(wrapText('one two three four', 40, 10, false, estimateTextWidth), ['one two', 'three', 'four']);
    assert.deepEqual(wrapText('a\n\nb', 100, 10, false, estimateTextWidth), ['a', '', 'b']);
    const long = 'x'.repeat(40);
    const layout = composeDocument({
      name: 'Doc', page: { size: 'A4', orientation: 'portrait' }, generatedAt: 'now', measure: estimateTextWidth,
      blocks: [
        { kind: 'text', id: 't', style: 'title', text: 'Title' },
        ...Array.from({ length: 60 }, (_, i) => ({ kind: 'text' as const, id: `b${i}`, style: 'body' as const, text: `${i} ${long}` })),
        { kind: 'text', id: 'h', style: 'heading', text: 'Heading at the end' },
        { kind: 'chart', id: 'c', title: 'Chart', subtitle: '2 buckets', hasData: true, snapshot: true },
        { kind: 'image', id: 'i', height: 100, align: 'right', aspect: 2, caption: 'Logo' },
      ],
    });
    assert.equal(layout.size.w, 595.28);
    assert.ok(layout.pages.length >= 2, `${layout.pages.length} pages`);
    const texts = layout.pages.flatMap((p) => p.items.filter((i) => i.kind === 'text').map((i) => i.text));
    assert.equal(texts[0], 'Title');
    assert.ok(texts.includes('Heading at the end'));
    const last = layout.pages.at(-1)!;
    const chart = last.items.find((i) => i.kind === 'chart');
    const snapshot = last.items.find((i) => i.kind === 'snapshot');
    assert.ok(chart && snapshot, 'chart and its snapshot are on the same page');
    // Portrait A4 is too narrow for side-by-side: the snapshot sits under the chart.
    assert.ok(snapshot.y > chart.y + chart.h, 'snapshot stacked under the chart');
    const image = last.items.find((i) => i.kind === 'image')!;
    assert.equal(image.w, 200);
    assert.equal(image.x + image.w, 595.28 - 40, 'right-aligned to the margin');
    // Every item stays inside the page frame.
    for (const page of layout.pages) for (const item of page.items) assert.ok(item.y >= 40 && item.y <= layout.size.h - 40, `${item.kind} at y=${item.y}`);
  });
});

describe('generateDocumentPdf', () => {
  function recordingSeams(): { seams: DocumentPdfSeams; calls: Array<{ op: string; args: unknown[] }> } {
    const calls: Array<{ op: string; args: unknown[] }> = [];
    let pages = 1;
    const seams: DocumentPdfSeams = {
      createDoc: async (format, orientation) => {
        calls.push({ op: 'create', args: [format, orientation] });
        return {
          addPage: () => { pages += 1; },
          setFont: () => {}, setFontSize: () => {}, setTextColor: () => {},
          text: (t, x, y) => calls.push({ op: 'text', args: [t, x, y] }),
          addImage: (bytes, format, x, y, w, h) => calls.push({ op: 'image', args: [bytes.length, format, x, y, w, h] }),
          svg: async (svg) => { calls.push({ op: 'svg', args: [svg] }); },
          table: () => {},
          pageCount: () => pages,
          output: () => new Blob(['pdf']),
        };
      },
      renderSvg: (agg, w, h) => `<svg data-buckets="${agg.categories.length}" width="${w}" height="${h}"></svg>`,
      capture: async (ids) => new Uint8Array(ids.length),
      theme: { text: '#000', mutedText: '#666', axis: '#999', grid: '#eee', background: 'transparent', fontFamily: 'Helvetica' },
      now: () => new Date('2026-09-12T10:00:00Z'),
      imageSize: async () => ({ w: 300, h: 100 }),
    };
    return { seams, calls };
  }

  it('prints resolved text, the chart SVG with its snapshot, the logo, a topic, and reports what did not resolve', async () => {
    const store = ctx.models[0].store;
    const dataset = elementsDataset([{ store, toGlobalId: (id) => id, name: 'tower.ifc' }]);
    const chart = { ...coverSheetDocument().blocks.find((b) => b.kind === 'chart')!, id: 'chart-1' } as Extract<DocumentSpec['blocks'][number], { kind: 'chart' }>;
    const agg: Aggregation = aggregate(chart.chart, dataset);
    const topic: BCFTopic = { guid: 'topic-1', title: 'Clash at grid B', topicStatus: 'Open', priority: 'High', creationDate: '2026-09-01T00:00:00Z', creationAuthor: 'Ada', comments: [], viewpoints: [{ guid: 'vp', snapshot: `data:image/png;base64,${btoa('png')}` }] };
    const doc: DocumentSpec = {
      version: 1, id: 'd', name: 'Cover', page: { size: 'A3', orientation: 'landscape' },
      blocks: [
        { kind: 'text', id: 't1', style: 'title', text: '{IfcProject.Name} — {Today}' },
        { kind: 'text', id: 't2', style: 'body', text: 'Roof: {IfcBuildingStorey["Roof"].Name}' },
        { kind: 'image', id: 'img', dataUrl: `data:image/jpeg;base64,${btoa('jpg')}`, height: 50, align: 'center', caption: 'Logo' },
        { kind: 'chart', id: 'chart-1', chart: chart.chart, snapshot: true },
        { kind: 'topic', id: 'tp', guid: 'topic-1', snapshot: true },
        { kind: 'topic', id: 'tp2', guid: 'gone', snapshot: false },
      ],
    };
    const { seams, calls } = recordingSeams();
    const result = await generateDocumentPdf({ document: doc, bindings: ctx, aggregations: new Map([['chart-1', agg]]), snapshotIds: () => [41, 42], topics: new Map([['topic-1', topic]]) }, seams);
    assert.deepEqual(calls[0], { op: 'create', args: ['a3', 'landscape'] });
    const texts = calls.filter((c) => c.op === 'text').map((c) => String(c.args[0]));
    assert.ok(texts.includes('Tower — 2026-09-12'), texts.join(' | '));
    assert.ok(texts.includes('Roof: [IfcBuildingStorey["Roof"].Name: no IfcBuildingStorey "Roof"]'));
    assert.ok(texts.includes('Clash at grid B') && texts.includes('Status: Open') && texts.includes('Created: 2026-09-01 by Ada'));
    assert.ok(texts.some((t) => t.startsWith('[BCF topic gone')));
    assert.deepEqual(result.unresolved, ['IfcBuildingStorey["Roof"].Name']);
    assert.deepEqual(result.missingTopics, ['gone']);
    const svgs = calls.filter((c) => c.op === 'svg');
    assert.equal(svgs.length, 1);
    assert.match(String(svgs[0].args[0]), /data-buckets="2"/);
    const images = calls.filter((c) => c.op === 'image').map((c) => [c.args[1], c.args[0]]);
    // The logo (JPEG), the chart's 3D snapshot (2 ids → 2 bytes), the topic viewpoint (PNG).
    assert.deepEqual(images, [['JPEG', 3], ['PNG', 2], ['PNG', 3]]);
    assert.equal(result.pages, 1);
    assert.deepEqual(topicLines({ guid: 'x', title: 'x', comments: [], viewpoints: [] }), []);
  });

  it('a blank document prints one page with its title binding resolved', async () => {
    const { seams, calls } = recordingSeams();
    const result = await generateDocumentPdf({ document: blankDocument(), bindings: ctx, aggregations: new Map(), snapshotIds: () => [], topics: new Map() }, seams);
    assert.equal(result.pages, 1);
    assert.ok(calls.some((c) => c.op === 'text' && c.args[0] === 'Tower'));
  });
});
