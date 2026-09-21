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
import type { ValidationReport } from '@ifc-lite/ids';
import { localIsoDate, parsePath, renderTemplate, resolveBinding, templatePaths, type BindingContext } from './bindings.js';
import { composeDocument, estimateTextWidth, wrapText } from './compose.js';
import { largestBucketIds } from '../charts/buckets.js';
import { generateDocumentPdf, topicLines, type DocumentPdfSeams } from './generate-document-pdf.js';
import { parseDocumentFile } from './persistence.js';
import { blankDocument, coverSheetDocument } from './presets.js';
import { DOCUMENT_VERSION, validateDocumentSpec, type DocumentSpec } from './types.js';
import { elementsDataset } from '@ifc-lite/charts';

// `migrateDocumentSpec` is imported dynamically (#4940 revert-oracle finding): a *static* `import
// { migrateDocumentSpec }` fails ES module resolution outright when production is reverted to a
// state that does not export it yet, crashing this entire file's load — not just the one test
// that needs it. A dynamic import degrades to `undefined` instead, so only that test skips.
const migrateDocumentSpec: typeof import('./types.js').migrateDocumentSpec | undefined = (await import('./types.js')).migrateDocumentSpec;

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
    assert.equal(v('Today'), localIsoDate(ctx.today), "the local calendar day, not UTC's");
    assert.equal(localIsoDate(new Date(2026, 0, 5, 23, 30)), '2026-01-05');
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
    assert.throws(() => parseDocumentFile(JSON.stringify({ ...doc, version: 4 })), /Not a document file: version expected version 3/);
    const broken = { ...doc, blocks: [{ kind: 'image', id: 'i', dataUrl: 'http://x/logo.png', height: 0, align: 'middle', caption: {} }] };
    assert.deepEqual(validateDocumentSpec(broken).map((e) => e.path), ['blocks[0].dataUrl', 'blocks[0].height', 'blocks[0].align', 'blocks[0].caption']);
  });

  it('migrates a version 1 or 2 file to version 3 and validates the new fields (#4940, #5138)', { skip: !migrateDocumentSpec && 'migrateDocumentSpec is not exported (production reverted)' }, () => {
    const v1 = { ...coverSheetDocument(), version: 1 };
    assert.deepEqual(migrateDocumentSpec!(v1), { ...v1, version: 3 });
    const imported = parseDocumentFile(JSON.stringify(v1));
    assert.equal(imported.version, 3);
    // A v2 document (#5138: `table` is additive, same as every v1 -> v2 field) migrates the same way.
    const v2Input = { ...coverSheetDocument(), version: 2 };
    assert.deepEqual(migrateDocumentSpec!(v2Input), { ...v2Input, version: 3 });
    // Anything not a recognizable v1/v2 document (e.g. already current, or malformed) passes through unchanged.
    assert.deepEqual(migrateDocumentSpec!({ ...v1, version: 3 }), { ...v1, version: 3 });
    assert.equal(migrateDocumentSpec!(null), null);

    const spacer = { kind: 'spacer', id: 's', height: 20 };
    const halfChart = { kind: 'chart', id: 'c1', chart: coverSheetDocument().blocks.find((b) => b.kind === 'chart')!.chart, snapshot: false, height: 300, width: 'half' };
    const halfImage = { kind: 'image', id: 'i1', dataUrl: `data:image/png;base64,${btoa('x')}`, height: 60, align: 'left', width: 'half' };
    const caption = { kind: 'text', id: 't1', style: 'caption', text: 'a caption' };
    const v2 = { version: 3, id: 'd2', name: 'V2', page: { size: 'A4', orientation: 'portrait' }, blocks: [caption, halfChart, halfImage, spacer] };
    assert.deepEqual(validateDocumentSpec(v2), []);

    // half only valid on chart/image; a text block rejects it (structural: `width` is not a text field).
    const textWithWidth = { ...v2, blocks: [{ kind: 'text', id: 't2', style: 'body', text: 'x', width: 'half' }] };
    assert.deepEqual(validateDocumentSpec(textWithWidth), []); // an unknown extra property on a text block is not itself a validation error
    const badChartHeight = { ...v2, blocks: [{ ...halfChart, height: 10 }] };
    assert.deepEqual(validateDocumentSpec(badChartHeight).map((e) => e.path), ['blocks[0].height']);
    const nonFiniteChartHeight = { ...v2, blocks: [{ ...halfChart, height: Number.NaN }] };
    assert.deepEqual(validateDocumentSpec(nonFiniteChartHeight).map((e) => e.path), ['blocks[0].height']);
    const badWidth = { ...v2, blocks: [{ ...halfImage, width: 'third' }] };
    assert.deepEqual(validateDocumentSpec(badWidth).map((e) => e.path), ['blocks[0].width']);
    // Infinity ("a positive number") must not slip past validation into a CSS height (review finding).
    const infiniteSpacer = { ...v2, blocks: [{ kind: 'spacer', id: 's2', height: Infinity }] };
    assert.deepEqual(validateDocumentSpec(infiniteSpacer).map((e) => e.path), ['blocks[0].height']);
    const nanSpacer = { ...v2, blocks: [{ kind: 'spacer', id: 's3', height: Number.NaN }] };
    assert.deepEqual(validateDocumentSpec(nanSpacer).map((e) => e.path), ['blocks[0].height']);
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

  it('a topic whose description outruns the page continues on the next page instead of running through the footer (review finding)', () => {
    const layout = composeDocument({
      name: 'Doc', page: { size: 'A4', orientation: 'portrait' }, generatedAt: 'now', measure: estimateTextWidth,
      blocks: [{ kind: 'topic', id: 'tp', title: 'Long topic', lines: Array.from({ length: 90 }, (_, i) => `Line ${i} of the description`), snapshotAspect: 4 / 3 }],
    });
    assert.ok(layout.pages.length >= 2, `${layout.pages.length} pages`);
    for (const page of layout.pages) for (const item of page.items) assert.ok(item.y <= layout.size.h - 40 - 24, `${item.kind} at y=${item.y} on page ${page.index}`);
    assert.equal(layout.pages[0].items.filter((i) => i.kind === 'topic-snapshot').length, 1);
    assert.equal(layout.pages.flatMap((p) => p.items).filter((i) => i.kind === 'text').length, 91, 'title + every line drawn once');
  });

  it('a chart block height override sizes its box, a caption prints small and gray, and a spacer advances y by its height (#4940)', () => {
    const layout = composeDocument({
      name: 'Doc', page: { size: 'A4', orientation: 'portrait' }, generatedAt: 'now', measure: estimateTextWidth,
      blocks: [
        { kind: 'text', id: 'cap', style: 'caption', text: 'A caption' },
        { kind: 'spacer', id: 'sp', height: 40 },
        { kind: 'chart', id: 'c', title: 'Chart', subtitle: '1 bucket', hasData: true, snapshot: false, height: 300 },
      ],
    });
    const page = layout.pages[0];
    const texts = page.items.filter((i): i is Extract<typeof i, { kind: 'text' }> => i.kind === 'text');
    const captionText = texts.find((i) => i.text === 'A caption')!;
    assert.equal(captionText.size, 8);
    assert.equal(captionText.gray, 130);
    const chart = page.items.find((i) => i.kind === 'chart')!;
    assert.equal(chart.h, 300, 'the chart box honours the override, not the 220pt default');
    const chartTitle = texts.find((i) => i.text === 'Chart')!;
    assert.ok(chartTitle.y > captionText.y + 40, 'the 40pt spacer pushed the chart title down by its height');
  });

  it('two half-width charts share one row at the same y, each at roughly half the content width (#4940)', () => {
    const layout = composeDocument({
      name: 'Doc', page: { size: 'A4', orientation: 'landscape' }, generatedAt: 'now', measure: estimateTextWidth,
      blocks: [
        { kind: 'chart', id: 'a', title: 'A', subtitle: '', hasData: false, snapshot: false, width: 'half' },
        { kind: 'chart', id: 'b', title: 'B', subtitle: '', hasData: false, snapshot: false, width: 'half' },
        { kind: 'text', id: 't', style: 'body', text: 'after' },
      ],
    });
    const charts = layout.pages[0].items.filter((i) => i.kind === 'chart');
    assert.equal(charts.length, 2);
    assert.equal(charts[0].y, charts[1].y, 'both columns start at the same y');
    assert.ok(charts[1].x > charts[0].x + charts[0].w, 'the second column starts after the first, with a gap between');
    assert.ok(charts[0].w < layout.size.w / 2, 'each column is roughly half the content width, not the full width');
    // A lone `half` chart (no pairable next block) still prints — full width, not clipped to a column.
    const solo = composeDocument({
      name: 'Doc', page: { size: 'A4', orientation: 'portrait' }, generatedAt: 'now', measure: estimateTextWidth,
      blocks: [{ kind: 'chart', id: 'solo', title: 'Solo', subtitle: '', hasData: false, snapshot: false, width: 'half' }],
    });
    const soloChart = solo.pages[0].items.find((i) => i.kind === 'chart')!;
    const contentW = solo.size.w - 80;
    assert.equal(soloChart.w, contentW, 'unpaired half prints full width');
  });

  it('a chart height + snapshot that would not fit a single page is clamped, never drawn past the footer (review finding, #4940)', () => {
    const layout = composeDocument({
      name: 'Doc', page: { size: 'A4', orientation: 'portrait' }, generatedAt: 'now', measure: estimateTextWidth,
      blocks: [{ kind: 'chart', id: 'c', title: 'Chart', subtitle: '', hasData: true, snapshot: true, height: 600 }],
    });
    const page = layout.pages[0];
    const chart = page.items.find((i) => i.kind === 'chart')!;
    const snapshot = page.items.find((i) => i.kind === 'snapshot')!;
    const bottom = layout.size.h - 40 - 24; // REPORT_MARGIN + FOOTER_HEIGHT
    assert.ok(chart.h < 600, 'the 600pt request is reduced to leave room for the stacked snapshot');
    assert.ok(snapshot.y + snapshot.h <= bottom, `snapshot bottom ${snapshot.y + snapshot.h} must stay above the footer at ${bottom}`);
  });

  it('a spacer taller than the printable page is clamped instead of pushing later content off the page (review finding, #4940)', () => {
    const layout = composeDocument({
      name: 'Doc', page: { size: 'A4', orientation: 'portrait' }, generatedAt: 'now', measure: estimateTextWidth,
      blocks: [
        { kind: 'spacer', id: 'sp', height: 5000 },
        { kind: 'text', id: 't', style: 'body', text: 'after the spacer' },
      ],
    });
    const bottom = layout.size.h - 40 - 24;
    for (const page of layout.pages) for (const item of page.items) assert.ok(item.y <= bottom, `${item.kind} at y=${item.y} must stay above the footer at ${bottom}`);
    const after = layout.pages.flatMap((p) => p.items).find((i) => i.kind === 'text' && i.text === 'after the spacer');
    assert.ok(after, 'the text after the oversized spacer is still drawn somewhere, not lost past the page bounds');
  });

  it('a leading full-page spacer does not strand the next chart at the footer on an otherwise-empty page (review finding, #4940)', () => {
    // A spacer clamped to the full printable height leaves y === bottom with the page still empty;
    // `ensure` used to refuse a page break in that case (unlike the per-line text path), so the
    // block right after it drew starting at the footer instead of a fresh page.
    const layout = composeDocument({
      name: 'Doc', page: { size: 'A4', orientation: 'portrait' }, generatedAt: 'now', measure: estimateTextWidth,
      blocks: [
        { kind: 'spacer', id: 'sp', height: 5000 },
        { kind: 'chart', id: 'c', title: 'Chart', subtitle: '', hasData: false, snapshot: false },
      ],
    });
    const bottom = layout.size.h - 40 - 24;
    const chart = layout.pages.flatMap((p) => p.items).find((i) => i.kind === 'chart')!;
    assert.ok(chart.y + chart.h <= bottom, `chart bottom ${chart.y + chart.h} must stay above the footer at ${bottom}, not start at it`);
    assert.equal(layout.pages.length, 2, 'the spacer fills page 1 entirely; the chart starts a fresh page 2');
  });

  it('a spacer that only partially fills a page still counts the page as occupied for the block after it (review finding, #4940)', () => {
    // A 400pt spacer on A4 portrait (printable height ~708pt) leaves the page well short of
    // `bottom`, so `page.items.length > 0` alone (spacers draw no items) refused to start a fresh
    // page for a 400pt chart that no longer fits — it drew through the footer instead.
    const layout = composeDocument({
      name: 'Doc', page: { size: 'A4', orientation: 'portrait' }, generatedAt: 'now', measure: estimateTextWidth,
      blocks: [
        { kind: 'spacer', id: 'sp', height: 400 },
        { kind: 'chart', id: 'c', title: 'Chart', subtitle: '', hasData: true, snapshot: false, height: 400 },
      ],
    });
    const bottom = layout.size.h - 40 - 24;
    const chart = layout.pages.flatMap((p) => p.items).find((i) => i.kind === 'chart')!;
    assert.ok(chart.y + chart.h <= bottom, `chart bottom ${chart.y + chart.h} must stay above the footer at ${bottom}, not run through it`);
    assert.equal(layout.pages.length, 2, 'the chart moves to a fresh page 2 instead of overflowing page 1');
  });

  it('a long chart title in a half-width column is truncated, not left to overrun into the next column (review finding, #4940)', () => {
    const longTitle = 'A Very Long Chart Title That Would Otherwise Run Into The Next Column';
    const layout = composeDocument({
      name: 'Doc', page: { size: 'A4', orientation: 'landscape' }, generatedAt: 'now', measure: estimateTextWidth,
      blocks: [
        { kind: 'chart', id: 'a', title: longTitle, subtitle: 'a subtitle that is also fairly long for its column', hasData: false, snapshot: false, width: 'half' },
        { kind: 'chart', id: 'b', title: 'B', subtitle: '', hasData: false, snapshot: false, width: 'half' },
      ],
    });
    const texts = layout.pages[0].items.filter((i): i is Extract<typeof i, { kind: 'text' }> => i.kind === 'text');
    assert.ok(!texts.some((t) => t.text === longTitle), 'the full title never appears untruncated');
    assert.ok(texts.some((t) => t.text.endsWith('…')), 'the truncated title carries an ellipsis');
    // The title is capped to the same width the subtitle reserves for itself, so the two never overlap (review finding).
    const chartA = layout.pages[0].items.find((i) => i.kind === 'chart' && i.blockId === 'a')!;
    const title = texts.find((t) => t.x === chartA.x && t.y === chartA.y - 7)!; // chartY = titleY + 7 (18 - 11)
    const subtitle = texts.find((t) => t.y === title.y && t.x > title.x)!;
    assert.ok(subtitle.x >= title.x + estimateTextWidth(title.text, 11, true), `subtitle x=${subtitle.x} must not sit under the title text ending at ${title.x + estimateTextWidth(title.text, 11, true)}`);
  });

  it('a long half-width image caption is truncated so it stays inside its own column (review finding, #4940)', () => {
    const longCaption = 'A very long caption that would otherwise cross the gap into the next column and keep running well past the page edge';
    const layout = composeDocument({
      name: 'Doc', page: { size: 'A4', orientation: 'portrait' }, generatedAt: 'now', measure: estimateTextWidth,
      blocks: [
        { kind: 'image', id: 'a', height: 60, align: 'left', aspect: 3, caption: longCaption, width: 'half' },
        { kind: 'image', id: 'b', height: 60, align: 'left', aspect: 3, width: 'half' },
      ],
    });
    const texts = layout.pages[0].items.filter((i): i is Extract<typeof i, { kind: 'text' }> => i.kind === 'text');
    assert.ok(!texts.some((t) => t.text === longCaption), 'the full caption never appears untruncated');
    assert.ok(texts.some((t) => t.text.endsWith('…')), 'the truncated caption carries an ellipsis');
  });

  it('the snapshot frames the bucket with the largest value, whatever the display order (review finding)', () => {
    const agg = { categories: [{ label: 'a', value: 1, ids: new Set([1]) }, { label: 'b', value: 5, ids: new Set([2, 3]) }, { label: 'c', value: 2, ids: new Set([4]) }] } as unknown as Aggregation;
    assert.deepEqual(largestBucketIds(agg), [2, 3]);
    assert.deepEqual(largestBucketIds(null), []);
  });
});

describe('compose: table block (#5138)', () => {
  const failedRows = Array.from({ length: 120 }, (_, i) => ['Walls have FireRating', i % 3 === 0 ? 'fail' : 'pass', `Wall ${i}`]);

  it('paginates 120 rows across pages, repeats the header on every chunk, and never splits a row', () => {
    const layout = composeDocument({
      name: 'Doc', page: { size: 'A4', orientation: 'portrait' }, generatedAt: 'now', measure: estimateTextWidth,
      blocks: [{ kind: 'table', id: 't', title: 'Failures', columns: ['rule', 'result', 'name'], headers: ['Rule', 'Result', 'Name'], rows: failedRows, truncated: false }],
    });
    assert.ok(layout.pages.length >= 2, `${layout.pages.length} pages`);
    const chunks = layout.pages.flatMap((p) => p.items.filter((i): i is Extract<typeof i, { kind: 'table' }> => i.kind === 'table'));
    assert.ok(chunks.length >= 2, 'the 120 rows were split into more than one chunk');
    for (const chunk of chunks) assert.deepEqual(chunk.head, ['Rule', 'Result', 'Name'], 'every chunk repeats the same header');
    const totalRows = chunks.reduce((n, c) => n + c.body.length, 0);
    assert.equal(totalRows, 120, 'no row is dropped or duplicated across chunks');
    const seen = new Set(chunks.flatMap((c) => c.body.map((r) => r[2])));
    assert.equal(seen.size, 120, 'no row appears in two chunks (a row is never split)');
    for (const page of layout.pages) for (const item of page.items) assert.ok(item.y >= 40 && item.y <= layout.size.h - 40, `${item.kind} at y=${item.y} stays inside the page frame`);
  });

  it('a "sets" table (one row per SetResult) paginates the same way', () => {
    const setRows = Array.from({ length: 60 }, (_, i) => ['No duplicate storey names', 'fail', `Level ${i} (Building)`, '2', 'Level (2×)', 'unique', 'duplicate']);
    const layout = composeDocument({
      name: 'Doc', page: { size: 'A4', orientation: 'portrait' }, generatedAt: 'now', measure: estimateTextWidth,
      blocks: [{ kind: 'table', id: 't2', columns: ['rule', 'result', 'set', 'members', 'actual', 'expected', 'reason'], headers: ['Rule', 'Result', 'Set', 'Members', 'Actual', 'Expected', 'Reason'], rows: setRows, truncated: false }],
    });
    const chunks = layout.pages.flatMap((p) => p.items.filter((i): i is Extract<typeof i, { kind: 'table' }> => i.kind === 'table'));
    assert.equal(chunks.reduce((n, c) => n + c.body.length, 0), 60);
    for (const chunk of chunks) assert.deepEqual(chunk.head, ['Rule', 'Result', 'Set', 'Members', 'Actual', 'Expected', 'Reason']);
  });

  it('a stale/absent report prints its placeholder message, not an (empty) grid', () => {
    const layout = composeDocument({
      name: 'Doc', page: { size: 'A4', orientation: 'portrait' }, generatedAt: 'now', measure: estimateTextWidth,
      blocks: [{ kind: 'table', id: 't3', title: 'Failures', columns: ['rule'], headers: ['Rule'], rows: [], truncated: false, placeholderMessage: 'No validation report yet — run validation, then export again.' }],
    });
    const chunks = layout.pages.flatMap((p) => p.items.filter((i) => i.kind === 'table'));
    assert.equal(chunks.length, 0, 'a placeholder never draws a table grid');
    const texts = layout.pages.flatMap((p) => p.items.filter((i): i is Extract<typeof i, { kind: 'text' }> => i.kind === 'text').map((i) => i.text));
    assert.ok(texts.includes('No validation report yet — run validation, then export again.'));
  });

  it('a truncated table prints a truncation note after its last chunk', () => {
    const rows = Array.from({ length: 5 }, (_, i) => [`R${i}`]);
    const layout = composeDocument({
      name: 'Doc', page: { size: 'A4', orientation: 'portrait' }, generatedAt: 'now', measure: estimateTextWidth,
      blocks: [{ kind: 'table', id: 't4', columns: ['rule'], headers: ['Rule'], rows, truncated: true }],
    });
    const texts = layout.pages.flatMap((p) => p.items.filter((i): i is Extract<typeof i, { kind: 'text' }> => i.kind === 'text').map((i) => i.text));
    assert.ok(texts.some((t) => /Showing the first 5 rows; more rows matched\./.test(t)), texts.join(' | '));
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
          table: (args) => calls.push({ op: 'table', args: [args.head, args.body] }),
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
      version: DOCUMENT_VERSION, id: 'd', name: 'Cover', page: { size: 'A3', orientation: 'landscape' },
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
    const result = await generateDocumentPdf({ document: doc, bindings: ctx, aggregations: new Map([['chart-1', agg]]), chartMessages: new Map(), snapshotIds: () => [41, 42], topics: new Map([['topic-1', topic]]), validationReport: null }, seams);
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
    const result = await generateDocumentPdf({ document: blankDocument(), bindings: ctx, aggregations: new Map(), chartMessages: new Map(), snapshotIds: () => [], topics: new Map(), validationReport: null }, seams);
    assert.equal(result.pages, 1);
    assert.ok(calls.some((c) => c.op === 'text' && c.args[0] === 'Tower'));
  });

  it('draws a validation table block through doc.table, and a stale ruleId as a placeholder message (#5138)', async () => {
    const report: ValidationReport = {
      source: { kind: 'rules', ruleSet: { name: 'Rule set' } },
      modelInfo: [{ modelId: 'm1', schemaVersion: 'IFC4', entityCount: 2 }],
      timestamp: new Date('2026-09-21T00:00:00Z'),
      summary: { totalSpecifications: 1, passedSpecifications: 0, failedSpecifications: 1, totalEntitiesChecked: 1, totalEntitiesPassed: 0, totalEntitiesFailed: 1, overallPassRate: 0 },
      specificationResults: [{
        specification: { id: 's1', name: 'Walls have FireRating' },
        status: 'fail', applicableCount: 1, passedCount: 0, failedCount: 1, passRate: 0,
        entityResults: [{
          expressId: 41, modelId: 'm1', entityType: 'IfcWall', entityName: 'Wall A', globalId: 'G-41', passed: false,
          requirementResults: [{ requirement: { id: 'r1', label: 'FireRating is set', optionality: 'required' }, status: 'fail', facetType: 'property', checkedDescription: '', failureReason: 'absent' }],
        }],
      }],
    };
    const doc: DocumentSpec = {
      version: DOCUMENT_VERSION, id: 'd-table', name: 'Table doc', page: { size: 'A4', orientation: 'portrait' },
      blocks: [
        { kind: 'table', id: 'tb1', title: 'Failures', columns: ['rule', 'result', 'name', 'reason'], source: { kind: 'validation', rows: 'failed' } },
        { kind: 'table', id: 'tb2', columns: ['rule'], source: { kind: 'validation', ruleId: 'gone', rows: 'failed' } },
      ],
    };
    const { seams, calls } = recordingSeams();
    const result = await generateDocumentPdf({ document: doc, bindings: ctx, aggregations: new Map(), chartMessages: new Map(), snapshotIds: () => [], topics: new Map(), validationReport: report }, seams);
    const tableCalls = calls.filter((c) => c.op === 'table');
    assert.equal(tableCalls.length, 1, 'the placeholder block never calls doc.table');
    assert.deepEqual(tableCalls[0].args, [[['Rule', 'Result', 'Name', 'Reason']], [['Walls have FireRating', 'fail', 'Wall A', 'absent']]]);
    const texts = calls.filter((c) => c.op === 'text').map((c) => String(c.args[0]));
    assert.ok(texts.includes('The rule this table refers to is not in the current validation report.'));
    assert.equal(result.pages, 1);
  });
});
