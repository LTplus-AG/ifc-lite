// SPDX-License-Identifier: MPL-2.0
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { chromium } from '@playwright/test';
import { serveRoots } from '../smlib-browser-worker-probe.mjs';
import { isMainEntry } from '../lib/is-main-entry.mjs';
import { compare, tsv } from './metrics.mjs';
import { compareView } from './browser-metrics.mjs';
import { loadTolerances } from './tolerances.mjs';

const ROOT = resolve(import.meta.dirname, '../..');
const percentile = (values, q) => [...values].sort((a, b) => a - b)[Math.max(0, Math.ceil(values.length * q) - 1)] ?? null;

export async function runBrowserComparison({ engine, native, out, corpus = false }) {
  const { validateEngine } = await import('../../packages/cli/dist/retained/engine.js');
  const { retainedReport } = await import('../../packages/cli/dist/retained/report.js');
  const validated = await validateEngine(engine);
  const nativeBytes = await readFile(native), nativeRows = tsv(nativeBytes.toString());
  const blessed = corpus ? nativeRows.filter(p => p.status !== 'exact_only_type_product')
    : tsv(await readFile(join(ROOT, 'tests/manifests/cli-retained-coverage.tsv'), 'utf8'));
  const tolerances = loadTolerances(join(ROOT, 'tests/fixtures/cli-retained'));
  if (tolerances.nativeWasmVolumeRelative !== 1e-9 || tolerances.viewStorageHalfUlp !== true) throw new Error('Preregistered M2 tolerances changed');
  const temporary = await mkdtemp(join(tmpdir(), 'retained-browser-parity-'));
  let server, browser;
  const products = [], models = [], pageErrors = [];
  try {
    await writeFile(join(temporary, 'index.html'), '<!doctype html><title>Retained browser parity</title>');
    // The engine is ALREADY staged and validated. Reuse serveRoots, serving the
    // exact inventory used by the CLI lane; stageTemporary would rebuild it.
    server = serveRoots({ '/smlib/': join(validated.directory, 'smlib'), '/pkg/': join(validated.directory, 'pkg-retained'),
      '/harness/': import.meta.dirname, '/source/': ROOT, '/page/': temporary });
    server.prependListener('request', (_request, response) => {
      response.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
      response.setHeader('Cross-Origin-Embedder-Policy', 'require-corp');
    });
    await new Promise(done => server.listen(0, '127.0.0.1', done));
    browser = await chromium.launch({ channel: process.env.IFCLITE_BROWSER_CHANNEL || 'chromium' });
    const page = await browser.newPage();
    page.on('pageerror', error => pageErrors.push(String(error)));
    await page.goto(`http://127.0.0.1:${server.address().port}/page/index.html`);
    const bindings = await readFile(join(validated.directory, 'pkg-retained/ifc-lite.js'), 'utf8');
    const driver = bindings.match(/from ['"](\.\/snippets\/[^'"]+\/retained-driver\.mjs)['"]/);
    if (!driver) throw new Error('Built retained package has no driver import to observe');
    await page.evaluate(async driverUrl => {
      window.harness = await import('/harness/browser-page.mjs');
      await window.harness.initialize(driverUrl);
    }, `/pkg/${driver[1].slice(2)}`);
    for (const model of [...new Set(blessed.map(p => p.model))].sort()) {
      const result = await page.evaluate(model => window.harness.runModel(model), model);
      // Playwright serializes typed arrays as plain data; restore the API's
      // actual shape contract before calling the shared CLI volume reporter.
      const outcomes = result.shape.outcomes.map(p => p.status !== 'published' ? p : { ...p,
        parts: p.parts.map(part => ({ ...part, positions: Float64Array.from(part.positions),
          indices: Uint32Array.from(part.indices), worldFromObject: Float64Array.from(part.worldFromObject) })) });
      const report = retainedReport(validated, outcomes, () => null);
      products.push(...report.products.map(p => ({ ...p, model })));
      const view = compareView(result.shape, result.view, result.prepass);
      models.push({ model, ...report.summary, ...view, importMs: result.importMs,
        shape: { ...result.shape.summary, qualificationMs: result.shape.qualificationMs, productWallMs: result.shape.productWallMs, wasmHeapBytes: result.shape.wasmHeapBytes },
        view: { ...result.view.summary, qualificationMs: result.view.qualificationMs, wasmHeapBytes: result.view.wasmHeapBytes } });
      console.log(`${model}: ${report.summary.published}/${report.summary.candidates} published; view violations=${view.violations.length}`);
    }
    // This API includes nested Workers when available. It does not isolate the
    // SMLib linear heap; report that limitation rather than inventing a figure.
    const memory = await page.evaluate(async () => {
      if (!performance.measureUserAgentSpecificMemory) return { bytes: null, reason: 'measureUserAgentSpecificMemory unavailable' };
      try { return { bytes: (await performance.measureUserAgentSpecificMemory()).bytes }; }
      catch (error) { return { bytes: null, reason: String(error) }; }
    });
    await page.evaluate(() => window.harness.dispose());
    const parity = compare(nativeRows, products, blessed, tolerances.nativeWasmVolumeRelative);
    const byCode = {};
    for (const p of products) if (p.code) byCode[p.code] = (byCode[p.code] ?? 0) + 1;
    const timings = models.flatMap(m => m.shape.productWallMs);
    const violations = [...parity.violations, ...models.flatMap(m => m.violations.map(v => `${m.model}: ${v}`)), ...pageErrors];
    const summary = { source: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: ROOT, encoding: 'utf8' }).trim(),
      engineManifestSha256: validated.manifestSha256, nativeProductsSha256: createHash('sha256').update(nativeBytes).digest('hex'),
      corpus, evidence: violations.length === 0, candidates: products.length, published: products.filter(p => p.status === 'published').length,
      byCode, ...parity, violations, maxVertexMetres: Math.max(0, ...models.map(m => m.maxVertexMetres)),
      maxVertexUlps: Math.max(0, ...models.map(m => m.maxVertexUlps)),
      startupMs: (models[0]?.importMs ?? 0) + (models.find(m => m.shape.qualificationMs > 0)?.shape.qualificationMs ?? 0),
      productMs: models.reduce((sum, m) => sum + Math.max(0, m.shape.productMs - m.shape.qualificationMs), 0),
      msPerProduct: { p50: percentile(timings, 0.5), p95: percentile(timings, 0.95), basis: 'shape callback wall time minus observed real SDK qualification; warm session' },
      wasmHeapPeakBytes: Math.max(0, ...models.flatMap(m => [m.shape.wasmHeapBytes, m.view.wasmHeapBytes])),
      browserMemory: memory, smlibHeapBytes: null, smlibHeapReason: 'SDK linear heap is private to its module Worker; browserMemory includes Workers when supported', models };
    if (!(await readFile(native)).equals(nativeBytes)) throw new Error('Native products.tsv changed during parity');
    if (out) {
      await mkdir(out, { recursive: true });
      await writeFile(join(out, 'summary.json'), `${JSON.stringify(summary, null, 2)}\n`);
      await writeFile(join(out, 'products.tsv'), 'model\tid\tstatus\tcode\tvolume_m3\n' + products.map(p =>
        [p.model, p.id, p.status, p.code ?? '', p.volumeM3 ?? ''].join('\t')).join('\n') + '\n');
    }
    return summary;
  } finally {
    await browser?.close();
    if (server) await new Promise(done => server.close(done));
    await rm(temporary, { recursive: true, force: true });
  }
}

if (isMainEntry(import.meta.url)) {
  const options = {};
  for (let i = 2; i < process.argv.length; i++) {
    const arg = process.argv[i];
    if (arg === '--bless') throw new Error(process.env.CI ? '--bless is forbidden in CI' : 'Browser parity never rewrites the native reference or manifest');
    if (arg === '--corpus') options.corpus = true;
    else if (['--engine', '--native', '--out'].includes(arg) && process.argv[i + 1]) options[arg.slice(2)] = process.argv[++i];
    else throw new Error('Expected --engine DIR --native products.tsv --out DIR [--corpus]');
  }
  if (!options.engine || !options.native || !options.out) throw new Error('--engine, --native and --out are required');
  const summary = await runBrowserComparison(options);
  console.log(JSON.stringify(summary));
  if (summary.violations.length && !options.corpus) process.exitCode = 1;
}
