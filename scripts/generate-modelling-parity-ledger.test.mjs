#!/usr/bin/env node
/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Regression harness for the modelling-parity scorecard (#9296):
 * `tests/modelling-parity/score.mjs` (scoring rules and the ratchet) and
 * `scripts/generate-modelling-parity-ledger.mjs` (the committed ledger is
 * current; a changed summary changes it; vacuous or mismatched inputs fail).
 *
 * Run: node --test scripts/generate-modelling-parity-ledger.test.mjs
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const SCRIPTS = dirname(fileURLToPath(import.meta.url));
const ROOT = join(SCRIPTS, '..');
const GENERATOR = join(SCRIPTS, 'generate-modelling-parity-ledger.mjs');
const SCORE = join(ROOT, 'tests/modelling-parity/score.mjs');
const { score, ratchet, readResults } = await import(pathToFileURL(SCORE).href);

const result = (capability, probe, status, extra = {}) => ({
  schema: 'ifclite-parity-result/1', capability, probe, id: `${probe}.${capability}.${status}`, status,
  ...(status === 'pass' ? {} : { reason: `${probe} ${status}` }), metrics: {}, evidence: [],
  source: { commit: 'abc123', dirty: false }, runner: 'test', ...extra,
});
const all = { sdk: { applicable: true }, ui: { applicable: true }, output: { applicable: true } };
const CATALOGUE = {
  capabilities: [
    { id: 'a', title: 'A', group: 'G', tableStakes: true, probes: all },
    { id: 'b', title: 'B', group: 'G', tableStakes: true, probes: { sdk: { applicable: false }, ui: { applicable: true }, output: { applicable: false } } },
    { id: 'd', title: 'D', group: 'G', tableStakes: true, probes: all },
    { id: 'e', title: 'E', group: 'G', tableStakes: true, probes: all },
    { id: 'x', title: 'X', group: 'Extra', tableStakes: false, probes: all },
  ],
};
const RESULTS = [
  result('a', 'sdk', 'fail'), result('a', 'sdk', 'pass'), result('a', 'ui', 'pass'), result('a', 'output', 'pass'),
  result('b', 'sdk', 'skip'), result('b', 'ui', 'pass'),
  result('d', 'sdk', 'skip'), result('d', 'ui', 'skip'), result('d', 'output', 'skip'),
  result('e', 'sdk', 'partial'), result('e', 'output', 'fail'), result('e', 'exercise', 'pass'),
  result('x', 'sdk', 'pass'),
];

test('score: best status per level, met/partial/missing, skip never passes, extras not scored', () => {
  const s = score(CATALOGUE, RESULTS, { generatedAt: 't' });
  const row = (id) => s.rows.find((r) => r.capability === id);
  assert.equal(row('a').levels.sdk.status, 'pass', 'best of fail and pass is pass');
  assert.equal(row('a').status, 'met');
  assert.equal(row('b').status, 'met', 'only applicable levels must pass');
  assert.equal(row('d').status, 'missing', 'skip on every level is missing, not met');
  assert.equal(row('e').status, 'partial');
  assert.equal(row('e').levels.ui.status, 'none');
  assert.equal(row('e').levels.exercise.status, 'pass', 'exercise is reported');
  assert.equal(row('x').status, 'partial');
  assert.deepEqual(s.counts, { met: 2, partial: 1, missing: 1 });
  assert.equal(s.score, 2.5);
  assert.equal(s.maxScore, 4, 'only table-stakes rows count');
});

test('score: a met row needs a pass on every applicable level, not just one', () => {
  const s = score(CATALOGUE, [result('a', 'sdk', 'pass'), result('a', 'output', 'pass')]);
  assert.equal(s.rows.find((r) => r.capability === 'a').status, 'partial', 'ui never ran');
});

test('score: results for unknown capabilities are flagged', () => {
  const s = score(CATALOGUE, [...RESULTS, result('nope', 'sdk', 'pass')]);
  assert.deepEqual(s.unknownCapabilities, ['nope']);
});

test('ratchet: equal or better passes; a row or score drop fails', () => {
  const base = score(CATALOGUE, RESULTS);
  assert.deepEqual(ratchet(base, base), []);
  assert.deepEqual(ratchet(base, score(CATALOGUE, [...RESULTS, result('e', 'ui', 'pass')])), []);
  const worse = score(CATALOGUE, RESULTS.filter((r) => !(r.capability === 'e' && r.probe === 'sdk')));
  const problems = ratchet(base, worse);
  assert.ok(problems.some((p) => p.includes('score dropped from 2.5 to 2')), problems.join('; ')); // @source-text-assertion-ok asserts on the real scorer's or generator's own output, not on unexecuted source text
  assert.ok(problems.some((p) => p === 'e: partial -> missing'), problems.join('; '));
});

test('score.mjs CLI: reads arrays and JSON lines, --check exits 1 on a drop', () => {
  const dir = mkdtempSync(join(tmpdir(), 'parity-score-'));
  try {
    const cat = join(dir, 'catalogue.json');
    writeFileSync(cat, JSON.stringify(CATALOGUE));
    mkdirSync(join(dir, 'res', 'nested'), { recursive: true });
    writeFileSync(join(dir, 'res', 'array.json'), JSON.stringify(RESULTS.slice(0, 6)));
    writeFileSync(join(dir, 'res', 'nested', 'lines.jsonl'), RESULTS.slice(6).map((r) => JSON.stringify(r)).join('\n'));
    writeFileSync(join(dir, 'res', 'noise.json'), JSON.stringify({ schema: 'something-else/1', capability: 'a', probe: 'ui', status: 'fail' }));
    assert.equal(readResults([join(dir, 'res')]).length, RESULTS.length);
    const run = (...args) => spawnSync(process.execPath, [SCORE, join(dir, 'res'), '--catalogue', cat, '--quiet', ...args], { encoding: 'utf8' });
    const first = run('--out', join(dir, 'base.json'));
    assert.equal(first.status, 0, first.stderr);
    assert.equal(JSON.parse(readFileSync(join(dir, 'base.json'), 'utf8')).score, 2.5);
    assert.equal(run('--out', join(dir, 'same.json'), '--check', join(dir, 'base.json')).status, 0);
    rmSync(join(dir, 'res', 'nested'), { recursive: true });
    const dropped = run('--out', join(dir, 'worse.json'), '--check', join(dir, 'base.json'));
    assert.equal(dropped.status, 1, 'losing results must fail the ratchet');
    assert.match(dropped.stderr, /Ratchet FAILED/); // @source-text-assertion-ok asserts on the real scorer's or generator's own output, not on unexecuted source text
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

/** A temp tree with the real catalogue and the given summaries under baseline/. */
function tree(summaries) {
  const dir = mkdtempSync(join(tmpdir(), 'parity-ledger-'));
  mkdirSync(join(dir, 'tests/modelling-parity/baseline'), { recursive: true });
  writeFileSync(join(dir, 'tests/modelling-parity/catalogue.json'), readFileSync(join(ROOT, 'tests/modelling-parity/catalogue.json')));
  for (const [name, body] of Object.entries(summaries)) writeFileSync(join(dir, 'tests/modelling-parity/baseline', name), JSON.stringify(body));
  return dir;
}
const generate = (root, ...args) => spawnSync(process.execPath, [GENERATOR, '--root', root, ...args], { encoding: 'utf8' });
const realCatalogue = JSON.parse(readFileSync(join(ROOT, 'tests/modelling-parity/catalogue.json'), 'utf8'));
const summaryOf = (results, generatedAt) => score(realCatalogue, results, { generatedAt });

test('the committed ledger matches the newest committed baseline summary', () => {
  const r = spawnSync(process.execPath, [GENERATOR, '--check'], { encoding: 'utf8' });
  assert.equal(r.status, 0, `${r.stdout}${r.stderr}`);
});

test('ledger: renders the newest summary, and a different summary changes the ledger', () => {
  const older = summaryOf([result('storeys', 'sdk', 'pass')], '2026-01-01T00:00:00.000Z');
  const newer = summaryOf([result('storeys', 'sdk', 'pass'), result('storeys', 'ui', 'pass'), result('storeys', 'output', 'pass'), result('grids', 'sdk', 'partial')], '2026-02-01T00:00:00.000Z');
  const dir = tree({ 'a-new.json': newer, 'z-old.json': older });
  try {
    assert.equal(generate(dir).status, 0);
    const ledger = readFileSync(join(dir, 'docs/architecture/modelling-parity-ledger.md'), 'utf8');
    assert.match(ledger, /\*\*Table-stakes score: 1\.5 \/ 25\*\*/, 'newest generatedAt wins, not the last file name'); // @source-text-assertion-ok asserts on the real scorer's or generator's own output, not on unexecuted source text
    assert.match(ledger, /\| Storeys and levels \(`storeys`\) \| Levels and grids \| ✅ \| ✅ \| ✅ \| – \| ✅ met \|/); // @source-text-assertion-ok asserts on the real scorer's or generator's own output, not on unexecuted source text
    assert.match(ledger, /`grids`.*◐ partial.*\*\*sdk\*\* partial: sdk partial/); // @source-text-assertion-ok asserts on the real scorer's or generator's own output, not on unexecuted source text
    writeFileSync(join(dir, 'tests/modelling-parity/baseline/a-new.json'), JSON.stringify({ ...newer, score: 2 }));
    const stale = generate(dir, '--check');
    assert.equal(stale.status, 1, 'a changed summary must make --check fail');
    assert.match(stale.stderr, /is stale/); // @source-text-assertion-ok asserts on the real scorer's or generator's own output, not on unexecuted source text
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('ledger: refuses vacuous or mismatched summaries', () => {
  const good = summaryOf([result('storeys', 'sdk', 'pass')], '2026-01-01T00:00:00.000Z');
  for (const [label, body, message] of [
    ['no rows', { ...good, rows: [] }, /no rows/],
    ['unknown row', { ...good, rows: [...good.rows, { ...good.rows[0], capability: 'not-a-capability' }] }, /does not know: not-a-capability/],
    ['missing table-stakes row', { ...good, rows: good.rows.filter((r) => r.capability !== 'grids') }, /lacks table-stakes rows: grids/],
  ]) {
    const dir = tree({ 'r.json': body });
    try {
      const r = generate(dir);
      assert.equal(r.status, 1, `${label} must fail`);
      assert.match(r.stderr, message, label); // @source-text-assertion-ok asserts on the real scorer's or generator's own output, not on unexecuted source text
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }
  const empty = tree({});
  try {
    assert.equal(generate(empty).status, 1, 'no summary at all must fail');
  } finally {
    rmSync(empty, { recursive: true, force: true });
  }
});

test('score.mjs CLI: --out naming the --check baseline is refused before anything is written', () => {
  const dir = mkdtempSync(join(tmpdir(), 'parity-score-same-'));
  try {
    const cat = join(dir, 'catalogue.json');
    writeFileSync(cat, JSON.stringify(CATALOGUE));
    mkdirSync(join(dir, 'res'));
    writeFileSync(join(dir, 'res', 'r.json'), JSON.stringify(RESULTS));
    const base = join(dir, 'base.json');
    const baseline = JSON.stringify({ ...score(CATALOGUE, RESULTS), score: 99 });
    writeFileSync(base, baseline);
    const r = spawnSync(process.execPath, [SCORE, join(dir, 'res'), '--catalogue', cat, '--quiet', '--out', base, '--check', base], { encoding: 'utf8' });
    assert.equal(r.status, 2, `${r.stdout}${r.stderr}`);
    assert.equal(readFileSync(base, 'utf8'), baseline, 'the baseline must be untouched');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

const { settleResult } = await import(pathToFileURL(join(ROOT, 'tests/modelling-parity/probes/sdk/run.mjs')).href);

test('SDK runner: any nonzero exit or timeout after a written result is an error', () => {
  const body = (status) => ({ capability: 'storeys', status, reason: 'r' });
  assert.equal(settleResult(body('pass'), { capability: 'storeys', code: 0 }).status, 'pass');
  assert.equal(settleResult(body('partial'), { capability: 'storeys', code: 0 }).status, 'partial');
  for (const status of ['pass', 'partial', 'fail', 'skip']) {
    const s = settleResult(body(status), { capability: 'storeys', code: 1, tail: 'boom' });
    assert.equal(s.status, 'error', `${status} then exit 1`);
    assert.match(s.reason, new RegExp(`after reporting ${status}`)); // @source-text-assertion-ok asserts on the runner's own returned reason, not on unexecuted source text
  }
  assert.equal(settleResult(body('partial'), { capability: 'storeys', code: 0, timedOut: true }).status, 'error');
  assert.equal(settleResult(null, { capability: 'storeys', code: 0 }).status, 'error');
  assert.equal(settleResult(body('pass'), { capability: 'grids', code: 0 }).status, 'error', "another capability's result");
});

const ART = await import(pathToFileURL(join(ROOT, 'tests/modelling-parity/output/artifacts.mjs')).href);
const SVG = '<?xml version="1.0"?><svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><!-- plan --><g class="cut"><line x1="0" y1="0" x2="1" y2="1"/><path d="M0 0 L1 1"/></g></svg>';
const PDF = '%PDF-1.4\n1 0 obj << /Type /Catalog /Pages 2 0 R >> endobj\n2 0 obj << /Type /Pages /Kids [3 0 R] /Count 1 >> endobj\n3 0 obj << /Type /Page /Parent 2 0 R /MediaBox [0 0 2384 1684] >> endobj\nxref\n0 4\n0000000000 65535 f \ntrailer << /Size 4 /Root 1 0 R >>\nstartxref\n180\n%%EOF\n';
const DXF = ['0', 'SECTION', '2', 'ENTITIES', '0', 'LINE', '8', 'A-WALL', '10', '0', '20', '0', '11', '1', '21', '1', '0', 'ENDSEC', '0', 'EOF'].join('\n') + '\n';

test('drawing sanity checks accept real content and refuse empty or broken files', () => {
  assert.equal(ART.checkSvg(Buffer.from(SVG)).status, 'pass');
  assert.equal(ART.checkPdf(Buffer.from(PDF)).status, 'pass');
  assert.match(ART.checkPdf(Buffer.from(PDF)).detail, /1 page\(s\), first MediaBox 2384 x 1684 pt/);
  assert.equal(ART.checkDxf(Buffer.from(DXF)).status, 'pass');
  for (const [label, check, text] of [
    ['empty svg', ART.checkSvg, ''],
    ['svg with no linework', ART.checkSvg, '<svg xmlns="http://www.w3.org/2000/svg"><g></g></svg>'],
    ['unclosed svg', ART.checkSvg, '<svg><g><line/></svg>'],
    ['not svg', ART.checkSvg, '<html><line/></html>'],
    ['empty pdf', ART.checkPdf, ''],
    ['truncated pdf', ART.checkPdf, PDF.replace('%%EOF', '')],
    ['pdf without pages', ART.checkPdf, PDF.replace(/\/Type \/Page \//, '/Type /Annot /').replace('/Count 1', '/Count 0')],
    ['pdf with only tokens', ART.checkPdf, '%PDF-1.4\n/Type /Page\n%%EOF'],
    ['pdf without cross-reference data', ART.checkPdf, PDF.replace('xref\n0 4\n', '').replace('startxref\n180\n', '')],
    ['pdf without objects', ART.checkPdf, PDF.replace(/ obj /g, ' ').replace(/endobj/g, '')],
    ['empty dxf', ART.checkDxf, ''],
    ['dxf without EOF', ART.checkDxf, DXF.replace('0\nEOF\n', '')],
    ['dxf without linework', ART.checkDxf, DXF.replace('LINE', 'POINT')],
    ['dxf with a broken group code', ART.checkDxf, DXF.replace('\n8\n', '\nX\n')],
  ]) assert.equal(check(Buffer.from(text)).status, 'fail', label);
});

test('artifact sets: UI handoffs count, failing results and SDK intermediates do not', () => {
  const sets = ART.artifactSets([
    result('sheets-pdf-dwg', 'ui', 'pass', { file: 'x/ui/sheets.json', artifacts: { pdf: 'artifacts/sheets-pdf-dwg/a1.pdf' }, evidence: ['artifacts/sheets-pdf-dwg/a1.dxf', 'frames/shot.png'] }),
    result('sheets-pdf-dwg', 'ui', 'fail', { artifacts: { pdf: 'bad.pdf' } }),
    result('storeys', 'sdk', 'partial', { artifacts: { ifc: 'a/storeys.IFC4.ifc', census: { IfcWall: 2 } }, evidence: ['a/storeys-f2f.IFC4.ifc'] }),
    result('storeys', 'ui', 'pass', { artifacts: { ifc: 'C:\\Users\\me\\out\\storeys.ifc' } }),
  ], 'sheets-pdf-dwg', { root: '/repo' });
  assert.equal(sets.length, 1, 'the failing UI result hands over nothing');
  assert.deepEqual(Object.keys(sets[0].files).sort(), ['dxf', 'pdf']);
  const storeys = ART.artifactSets([
    result('storeys', 'sdk', 'partial', { artifacts: { ifc: 'a/storeys.IFC4.ifc', census: { IfcWall: 2 } }, evidence: ['a/storeys-f2f.IFC4.ifc'] }),
    result('storeys', 'ui', 'pass', { artifacts: { ifc: 'C:\\Users\\me\\out\\storeys.ifc' } }),
  ], 'storeys', { root: '/repo' });
  assert.deepEqual(storeys.map((s) => s.files.ifc), [['/repo/a/storeys.IFC4.ifc'], ['/mnt/c/Users/me/out/storeys.ifc']], 'SDK intermediates ignored; Windows paths mapped');
  assert.deepEqual(storeys[0].census, { IfcWall: 2 });
});

test('output runner: documentation rows are judged on UI-handed drawings and can pass', () => {
  const dir = mkdtempSync(join(tmpdir(), 'parity-output-ui-'));
  try {
    const art = join(dir, 'ui', 'artifacts', 'sheets-pdf-dwg');
    mkdirSync(art, { recursive: true });
    writeFileSync(join(art, 'a1.pdf'), PDF);
    writeFileSync(join(art, 'a1.dxf'), DXF);
    writeFileSync(join(dir, 'ui', 'artifacts', 'plan.svg'), SVG);
    mkdirSync(join(dir, 'ui', 'ui'));
    writeFileSync(join(dir, 'ui', 'ui', 'results.json'), JSON.stringify([
      // Relative to the lane's $PARITY_OUT (an ancestor of the result file), as the Handoffs section writes them.
      result('sheets-pdf-dwg', 'ui', 'pass', { artifacts: { pdf: 'artifacts/sheets-pdf-dwg/a1.pdf' }, evidence: ['artifacts/sheets-pdf-dwg/a1.dxf'] }),
      result('plans-sections-elevations', 'ui', 'partial', { artifacts: { svg: join(dir, 'ui', 'artifacts', 'plan.svg') } }),
      result('dimensions-tags', 'ui', 'pass', { artifacts: { pdf: join(dir, 'missing.pdf') } }),
    ]));
    const out = join(dir, 'out');
    const r = spawnSync(process.execPath, [join(ROOT, 'tests/modelling-parity/output/run.mjs'), '--out', out, '--ui', join(dir, 'ui'), '--only', 'sheets-pdf-dwg,plans-sections-elevations,dimensions-tags,roof-by-footprint'], { encoding: 'utf8' });
    assert.equal(r.status, 0, `${r.stdout}${r.stderr}`);
    const read = (id) => JSON.parse(readFileSync(join(out, 'output', `${id}.json`), 'utf8'));
    assert.equal(read('sheets-pdf-dwg').status, 'pass', JSON.stringify(read('sheets-pdf-dwg')));
    assert.equal(read('plans-sections-elevations').status, 'pass');
    assert.equal(read('dimensions-tags').status, 'fail', 'a listed file that is not there fails');
    assert.equal(read('roof-by-footprint').status, 'skip', 'no SDK result and no UI handoff');
    const s = score(realCatalogue, readResults([out, join(dir, 'ui')]));
    assert.equal(s.rows.find((x) => x.capability === 'sheets-pdf-dwg').status, 'met', 'UI pass + output pass, SDK not applicable');
    rmSync(join(art, 'a1.dxf'));
    spawnSync(process.execPath, [join(ROOT, 'tests/modelling-parity/output/run.mjs'), '--out', out, '--ui', join(dir, 'ui'), '--only', 'sheets-pdf-dwg'], { encoding: 'utf8' });
    assert.equal(read('sheets-pdf-dwg').status, 'partial', 'the DXF a sheet row requires is missing');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('score: an inapplicable level never earns partial', () => {
  const s = score(CATALOGUE, [result('b', 'sdk', 'pass'), result('b', 'output', 'partial')]);
  assert.equal(s.rows.find((r) => r.capability === 'b').status, 'missing', 'b is UI-only: sdk/output results do not count');
  assert.equal(s.score, 0);
});

test('artifact paths resolve in both lane layouts, nearest result-relative location first', () => {
  const dir = mkdtempSync(join(tmpdir(), 'parity-layout-'));
  try {
    const put = (p) => { mkdirSync(dirname(join(dir, p)), { recursive: true }); writeFileSync(join(dir, p), PDF); return join(dir, p); };
    // L4's baseline layout: ui-r0/probes.json beside ui-r0/artifacts/<capability>/...
    const l4 = put('ui-r0/artifacts/sheets-pdf-dwg/Drawing Sheet-front-50.pdf');
    assert.equal(ART.resolveArtifact('artifacts/sheets-pdf-dwg/Drawing Sheet-front-50.pdf', { root: ROOT, resultFile: join(dir, 'ui-r0/probes.json') }), l4);
    // $PARITY_OUT/ui/<result>.json with the files under $PARITY_OUT/artifacts/<capability>/...
    const lane = put('L4/artifacts/sheets-pdf-dwg/a1.pdf');
    assert.equal(ART.resolveArtifact('artifacts/sheets-pdf-dwg/a1.pdf', { root: ROOT, resultFile: join(dir, 'L4/ui/sheets.json') }), lane);
    // A copy next to the result file wins over the ancestor one.
    const near = put('L4/ui/artifacts/sheets-pdf-dwg/a1.pdf');
    assert.equal(ART.resolveArtifact('artifacts/sheets-pdf-dwg/a1.pdf', { root: ROOT, resultFile: join(dir, 'L4/ui/sheets.json') }), near);
    const sets = ART.artifactSets([result('sheets-pdf-dwg', 'ui', 'pass', { file: join(dir, 'ui-r0/probes.json'), artifacts: { pdf: 'artifacts/sheets-pdf-dwg/Drawing Sheet-front-50.pdf' } })], 'sheets-pdf-dwg', { root: ROOT });
    assert.deepEqual(sets[0].files.pdf, [l4]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a UI export is judged on the classes it contains', () => {
  const ifc = "ISO-10303-21;\nDATA;\n#1=IFCPROJECT('0YvctVUKr0kugbFTf53O9L',$,'P',$,$,$,$,$,$);\n#2=IFCBUILDINGSTOREY('1YvctVUKr0kugbFTf53O9L',$,'L1',$,$,$,$,$,.ELEMENT.,0.);\n#3=IFCWALLSTANDARDCASE('2YvctVUKr0kugbFTf53O9L',$,'W',$,$,$,$,$,$);\nENDSEC;\nEND-ISO-10303-21;\n";
  assert.deepEqual(ART.fileClasses(ifc), ['IfcBuildingStorey', 'IfcWall'], 'IFCWALLSTANDARDCASE counts as IfcWall, as byType does after a reopen');
  const sub = ART.censusClassesByStepType();
  assert.deepEqual(sub.get('IFCSLABSTANDARDCASE'), ['IfcSlab']);
  assert.deepEqual(sub.get('IFCDOORSTANDARDCASE'), ['IfcDoor']);
  assert.equal(sub.get('IFCPROJECT'), undefined, 'non-census classes add nothing');
});

test('round 3: annotations count, bad --jobs exits 2, SVG ends after its root, --summary follows --root', () => {
  const ifc = "ISO-10303-21;\nDATA;\n#1=IFCBUILDINGSTOREY('1YvctVUKr0kugbFTf53O9L',$,'L1',$,$,$,$,$,.ELEMENT.,0.);\n#2=IFCANNOTATION('3YvctVUKr0kugbFTf53O9L',$,'Dim',$,'IfcLite:Measure',$,$);\nENDSEC;\n";
  assert.deepEqual(ART.fileClasses(ifc), ['IfcAnnotation', 'IfcBuildingStorey'], 'a UI dimensions-tags IFC keys its annotations');

  const RUN = join(ROOT, 'tests/modelling-parity/probes/sdk/run.mjs');
  for (const bad of ['nope', '0', '1.5', '-2', '999']) {
    const r = spawnSync(process.execPath, [RUN, '--jobs', bad, '--out', join(tmpdir(), 'parity-never-used')], { encoding: 'utf8' });
    assert.equal(r.status, 2, `--jobs ${bad}: ${r.stderr}`);
    assert.match(r.stderr, /--jobs must be an integer from 1 to 32/); // @source-text-assertion-ok asserts on the runner's own stderr, not on unexecuted source text
  }

  for (const [label, text] of [['trailing <', '<svg><line/></svg><'], ['element after root', '<svg><line/></svg><g/>'], ['text after root', '<svg><line/></svg>junk'], ['text before root', 'x<svg><line/></svg>'], ['truncated tag', '<svg><line/><path d="M0 0"</svg>']]) {
    assert.equal(ART.checkSvg(Buffer.from(text)).status, 'fail', label);
  }
  assert.equal(ART.checkSvg(Buffer.from('<svg><line/></svg>\n<!-- end -->\n  ')).status, 'pass', 'trailing whitespace and comments are fine');

  const good = summaryOf([result('storeys', 'sdk', 'pass')], '2026-01-01T00:00:00.000Z');
  const dir = tree({});
  try {
    mkdirSync(join(dir, 'elsewhere'));
    writeFileSync(join(dir, 'elsewhere', 'only-here.json'), JSON.stringify(good));
    const r = spawnSync(process.execPath, [GENERATOR, '--root', dir, '--summary', 'elsewhere/only-here.json'], { encoding: 'utf8', cwd: tmpdir() });
    assert.equal(r.status, 0, `${r.stdout}${r.stderr}`);
    assert.match(readFileSync(join(dir, 'docs/architecture/modelling-parity-ledger.md'), 'utf8'), /Summary: `elsewhere\/only-here\.json`/); // @source-text-assertion-ok asserts on the generator's emitted ledger, not on unexecuted source text
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('ratchet: demoting, removing or renaming a table-stakes row fails', () => {
  const base = score(CATALOGUE, RESULTS);
  assert.deepEqual(base.tableStakesIds, ['a', 'b', 'd', 'e']);
  const variants = {
    demoted: { capabilities: CATALOGUE.capabilities.map((c) => (c.id === 'd' ? { ...c, tableStakes: false } : c)) },
    removed: { capabilities: CATALOGUE.capabilities.filter((c) => c.id !== 'd') },
    renamed: { capabilities: CATALOGUE.capabilities.map((c) => (c.id === 'd' ? { ...c, id: 'd2' } : c)) },
  };
  for (const [label, cat] of Object.entries(variants)) {
    const problems = ratchet(base, score(cat, RESULTS));
    assert.ok(problems.some((p) => p.startsWith('table-stakes set changed')), `${label}: ${problems.join('; ')}`); // @source-text-assertion-ok asserts on ratchet()'s own returned problems, not on unexecuted source text
  }
  const legacy = { ...base };
  delete legacy.tableStakesIds; // summaries written before the field fall back to their rows
  assert.deepEqual(ratchet(legacy, base), []);
  assert.ok(ratchet(legacy, score(variants.demoted, RESULTS)).length > 0);
});
