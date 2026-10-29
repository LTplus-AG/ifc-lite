// SPDX-License-Identifier: MPL-2.0
// #7955 release scope item 4: the BUILT CLI, run end to end as a child process
// with the real staged SMLib engine, on models exported by real authoring tools.
// The retained OBJ is compared with the exact OBJ of the same file, product by
// product, against the native retained_compare reference. The exact default
// output is asserted unchanged by the retained flag's presence.
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, access } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { tsv } from './metrics.mjs';
import { coverageRows } from './coverage.mjs';
import { parseObj, productMeasures, compareProduct, sourceIdentity } from './real-authoring-support.mjs';

const engine = process.env.IFCLITE_RETAINED_ENGINE;
const SKIP = !(engine && existsSync(engine)) && 'SKIP: no staged SMLib engine; this is NOT parity evidence';
const tolerances = JSON.parse(await readFile('tests/fixtures/cli-retained/tolerances.json', 'utf8'));

// `tool` is asserted against the file itself (IFCAPPLICATION / FILE_NAME), so a
// fixture that stopped being an authoring-tool export fails here, not silently.
const AUTHORING_MODELS = [
  { tool: 'Revit', model: 'rust/geometry/tests/fixtures/issue_098_wall_W.ifc', header: /Autodesk Revit 2022/ },
  { tool: 'ArchiCAD', model: 'apps/viewer/public/_fixtures/AC20-FZK-Haus.ifc', header: /ARCHICAD-64/ },
  { tool: 'Bonsai', model: 'apps/viewer/public/samples/hello-wall.ifc', header: /Bonsai/ },
];
// Every product is refused: the retained CLI must fail honestly, never writing an OBJ.
const ALL_REFUSED = [
  { tool: 'Tekla Structures', model: 'rust/geometry/tests/fixtures/issue_1155_halfspace_flyaway.ifc', header: /Tekla Structures 2023/ },
  { tool: 'SketchUp', model: 'apps/viewer/public/samples/building-architecture.ifc', header: /IFC manager for sketchup/i },
];

function cli(args, options = {}) {
  const run = spawnSync(process.execPath, ['packages/cli/dist/index.js', ...args], { encoding: 'utf8', timeout: 600000, maxBuffer: 64 * 1024 * 1024, ...options });
  if (run.error) throw run.error;
  return run;
}
const exportObj = (model, out, extra = []) => cli(['export', model, '--format', 'obj', ...extra, '--out', out]);

test('#7955 real authoring-tool models: CLI retained OBJ agrees with the CLI exact OBJ, product by product', {
  timeout: 1800000, skip: SKIP,
}, async t => {
  assert.ok(process.env.IFCLITE_NATIVE_PRODUCTS, 'native products.tsv is required');
  const native = tsv(await readFile(process.env.IFCLITE_NATIVE_PRODUCTS, 'utf8'));
  const blessed = await coverageRows();
  const scratch = await mkdtemp(join(tmpdir(), 'real-authoring-'));
  const volumeRelative = tolerances.exactLinear.volumeRelative, bboxMetres = tolerances.exactLinear.bboxMetres;
  const tools = new Set(), diagnostics = [];
  t.after(() => rm(scratch, { recursive: true, force: true }));
  for (const [index, fixture] of AUTHORING_MODELS.entries()) {
    const { tool, model } = fixture;
    const source = await readFile(model, 'latin1');
    // @source-text-assertion-ok fixture provenance guard (the file must stay an authoring-tool export), not a subject assertion
    assert.match(source.slice(0, 20000) + (source.match(/IFCAPPLICATION\([^;]*;/)?.[0] ?? ''), fixture.header, `${model} is a ${tool} export`);
    tools.add(tool);
    const dir = join(scratch, String(index));
    await rm(dir, { recursive: true, force: true });
    await mkdir(dir);
    const [exactOut, kernelOut, retainedOut, report] = ['exact.obj', 'exact-kernel.obj', 'retained.obj', 'report.json'].map(f => join(dir, f));

    // Exact default output: absent and explicit `--kernel exact` are byte-identical.
    const exact = exportObj(model, exactOut);
    assert.equal(exact.status, 0, exact.stderr);
    const explicit = exportObj(model, kernelOut, ['--kernel', 'exact']);
    assert.equal(explicit.status, 0, explicit.stderr);
    const exactText = await readFile(exactOut, 'utf8');
    assert.equal(exactText, await readFile(kernelOut, 'utf8'), `${tool}: --kernel exact must not change the default output`);
    assert.doesNotMatch(exactText, /PresentationObligationsUnmet/);

    const retained = exportObj(model, retainedOut, ['--kernel', 'retained', '--retained-engine', resolve(engine), '--retained-report', report]);
    assert.equal(retained.status, 0, retained.stderr);
    assert.equal(retained.stdout, '', 'file export must not leak logs onto stdout');
    const retainedText = await readFile(retainedOut, 'utf8');
    // @source-text-assertion-ok CLI output contract of the file just exported, not repository source
    assert.match(retainedText, /# PresentationObligationsUnmet/);
    const parsed = JSON.parse(await readFile(report, 'utf8'));

    // Identity: report ids, OBJ objects and the source's GlobalIds agree.
    const published = parsed.products.filter(p => p.status === 'published'), refused = parsed.products.filter(p => p.status === 'refused');
    assert.equal(parsed.summary.candidates, parsed.products.length);
    assert.equal(parsed.summary.published, published.length);
    assert.equal(published.length + refused.length, parsed.products.length);
    assert.ok(published.length > 0, `${tool}: at least one product is published`);
    const retainedObjects = parseObj(retainedText), exactObjects = parseObj(exactText);
    assert.deepEqual([...retainedObjects.keys()].sort(), published.map(p => `${p.ifcType}_${p.id}`).sort(),
      `${tool}: OBJ objects are exactly the published products`);
    const objectIds = new Set([...retainedObjects.keys()].map(name => Number(name.slice(name.lastIndexOf('_') + 1))));
    for (const row of refused) assert.ok(!objectIds.has(row.id), `${tool}: refused #${row.id} must have no geometry`);
    const identity = sourceIdentity(source);
    for (const product of parsed.products) {
      const entity = identity.get(product.id);
      assert.ok(entity, `${tool}: #${product.id} exists in the source`);
      assert.equal(product.ifcType.toUpperCase(), entity.type, `${tool}: #${product.id} type`);
      assert.equal(product.globalId, entity.globalId, `${tool}: #${product.id} GlobalId from the source`);
    }
    // The native reference classifies this model's products exactly like the report.
    const nativeRows = new Map(native.filter(r => r.model === model).map(r => [Number(r.id), r]));
    const pinned = blessed.filter(r => r.model === model);
    assert.ok(pinned.length > 0, `${tool}: ${model} must be in the blessed coverage manifests`);
    assert.deepEqual(parsed.products.map(p => [p.id, p.status === 'published' ? '' : p.code]).sort((a, b) => a[0] - b[0]),
      pinned.map(r => [Number(r.id), r.code ?? '']).sort((a, b) => a[0] - b[0]), `${tool}: CLI outcomes equal the blessed manifest`);

    // Exact vs retained, per product published by both. The bound is the deviation
    // the native comparison already measured plus the preregistered exactLinear
    // tolerance and the OBJ's six-decimal quantisation. Curved products are report only.
    let compared = 0, curved = 0, exactMissing = [];
    for (const product of published) {
      const name = `${product.ifcType}_${product.id}`, ours = productMeasures(retainedObjects.get(name)), theirs = exactObjects.get(name);
      if (!theirs) { exactMissing.push(product.id); continue; }
      const row = nativeRows.get(product.id);
      assert.ok(row, `${tool}: native reference row for #${product.id}`);
      const verdict = compareProduct(ours, productMeasures(theirs), row, { volumeRelative, bboxMetres });
      if (verdict.skipped) { curved++; continue; }
      compared++;
      assert.ok(verdict.ok, `${tool} #${product.id} ${name}: ${JSON.stringify(verdict)}`);
    }
    assert.ok(compared > 0, `${tool}: at least one linear product was compared with exact`);
    diagnostics.push({ tool, model, candidates: parsed.summary.candidates, published: published.length, byCode: parsed.summary.byCode, compared, curvedReportOnly: curved, notInExactObj: exactMissing.length });
  }
  assert.ok(tools.size >= 2, 'at least two authoring tools');
  t.diagnostic(JSON.stringify(diagnostics));
});

for (const { tool, model, header } of ALL_REFUSED) {
  test(`#7955 a ${tool} model whose every product is refused fails honestly and leaves exact working`, {
    timeout: 300000, skip: SKIP,
  }, async t => {
    // @source-text-assertion-ok fixture provenance guard (the file must stay an authoring-tool export), not a subject assertion
    assert.match(await readFile(model, 'latin1'), header, `${model} is a ${tool} export`);
    const pinned = (await coverageRows()).filter(r => r.model === model);
    assert.ok(pinned.length > 0 && pinned.every(r => r.status === 'refused'), `${model}: the manifest pins every product as refused`);
    const scratch = await mkdtemp(join(tmpdir(), 'real-authoring-refused-'));
    t.after(() => rm(scratch, { recursive: true, force: true }));
    const obj = join(scratch, 'retained.obj'), report = join(scratch, 'report.json');
    const run = exportObj(model, obj, ['--kernel', 'retained', '--retained-engine', resolve(engine), '--retained-report', report]);
    assert.equal(run.status, 1, run.stderr);
    assert.match(run.stderr, /published 0 products; nothing written/);
    await assert.rejects(access(obj), 'no partial OBJ');
    await assert.rejects(access(report), 'no success-looking report');
    const exactOut = join(scratch, 'exact.obj');
    const exact = exportObj(model, exactOut);
    assert.equal(exact.status, 0, 'the exact kernel still exports the same file');
    assert.doesNotMatch(await readFile(exactOut, 'utf8'), /kernel: retained|PresentationObligationsUnmet/);
  });
}
