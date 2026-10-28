// SPDX-License-Identifier: MPL-2.0
// #7955 M2-D: real built viewer, real host Worker and real staged SDK.
import { test, expect, type Page } from '@playwright/test';
import { existsSync, readFileSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { spawn } from 'node:child_process';
import type { ViewerState } from '../../apps/viewer/src/store';
import type { LoadTraceSnapshot } from '../../packages/load-trace/src';

const WALL = 'rust/geometry/tests/fixtures/issue_098_wall_W.ifc';
const MAPPED = 'rust/geometry/tests/fixtures/mapped_instances_synthetic.ifc';
const engine = process.env.IFCLITE_RETAINED_ENGINE;
// Trace DOM snapshots add work to the Cancel latency sample; keep real UI/Worker
// assertions and failure screenshots, without tracing this timing-sensitive file.
test.use({ trace: 'off' });
const SKIP = 'SKIP: no staged SMLib engine; this is NOT parity evidence';
interface ViewerGlobals {
  __ifc_lite_viewer_store__: { getState(): ViewerState; subscribe(listener: (state: ViewerState) => void): () => void };
  __retainedCancel?: { clickMs: number; before: { meshIds: number[]; published: number }; error?: string };
  __IFC_LITE_LOAD_TRACE__: { latest(): LoadTraceSnapshot | null };
  __retainedLongTasks: number[];
}
const expected = (model: string) => readFileSync('tests/manifests/cli-retained-coverage.tsv', 'utf8')
  .split(/\r?\n/).map(line => line.split('\t')).filter(row => row[0] === model)
  .map(([, id, status, code]) => ({ id: Number(id), status, code })).sort((a, b) => a.id - b.id);

async function setup(page: Page, kernel?: 'retained' | 'exact') {
  await page.addInitScript(() => {
    const globals = globalThis as typeof globalThis & ViewerGlobals;
    globals.__retainedLongTasks = [];
    new PerformanceObserver(list => {
      globals.__retainedLongTasks.push(...list.getEntries().map(e => e.duration));
    }).observe({ type: 'longtask', buffered: true });
  });
  await page.goto(`/?perfTrace=1${kernel ? `&kernel=${kernel}` : ''}`);
  await page.waitForFunction(() => Boolean((globalThis as typeof globalThis & ViewerGlobals).__ifc_lite_viewer_store__));
  await expect(page.locator('#file-input-open')).toBeAttached();
}

async function snapshot(page: Page) {
  return page.evaluate(() => {
    const globals = globalThis as typeof globalThis & ViewerGlobals;
    const state = globals.__ifc_lite_viewer_store__.getState();
    const model = [...state.models.values()][0];
    return { loading: state.loading, error: state.error, models: state.models.size, summary: model?.retainedGeometry,
      loadState: model?.loadState,
      meshIds: [...new Set((model?.geometryResult?.meshes ?? []).map(m => state.resolveGlobalIdFromModels(m.expressId)?.expressId))].sort((a, b) => (a ?? 0) - (b ?? 0)),
      selected: state.selectedEntityId === null ? null : state.resolveGlobalIdFromModels(state.selectedEntityId)?.expressId,
      spans: globals.__IFC_LITE_LOAD_TRACE__?.latest()?.spans.map(s => s.name),
      longTaskMs: globals.__retainedLongTasks.reduce((a, b) => a + b, 0),
    };
  });
}
async function complete(page: Page, retained: boolean) {
  await page.waitForFunction(retained => {
    const state = (globalThis as typeof globalThis & ViewerGlobals).__ifc_lite_viewer_store__.getState();
    const model = [...state.models.values()][0];
    return !state.loading && model?.loadState === 'complete' && (!retained || model.retainedGeometry?.completeness !== 'running');
  }, retained);
}
async function record(name: string, result: unknown) {
  console.log(`M2-D ${name}: ${JSON.stringify(result)}`);
  if (process.env.IFCLITE_VIEWER_OUT) {
    await mkdir(process.env.IFCLITE_VIEWER_OUT, { recursive: true });
    await writeFile(join(process.env.IFCLITE_VIEWER_OUT, `${name}.json`), JSON.stringify(result, null, 2) + '\n');
  }
}

test.describe('retained viewer acceptance', () => {
  test.skip(!(engine && existsSync(join(engine, 'engine-manifest.json'))), SKIP);

  test('positive: current corpus outcomes are absent/listed, with no exact cache lookup', async ({ page }) => {
    const requests: string[] = [];
    page.context().on('request', req => requests.push(req.url()));
    await setup(page, 'retained');
    await page.locator('#file-input-open').setInputFiles(resolve(WALL));
    await complete(page, true);
    const result = await snapshot(page), rows = expected(WALL);
    expect(result.error).toBeNull();
    expect(result.summary?.published).toBe(rows.filter(p => p.status === 'published').length);
    expect(result.summary?.candidates).toBe(rows.length);
    expect(result.summary?.refused.map(p => ({ id: p.expressId, code: p.code })).sort((a, b) => a.id - b.id))
      .toEqual(rows.filter(p => p.status === 'refused').map(({ id, code }) => ({ id, code })));
    expect(result.meshIds).toEqual(rows.filter(p => p.status === 'published').map(p => p.id));
    expect(result.spans?.length).toBeGreaterThan(0);
    expect(result.spans).not.toContain('cache.lookup');
    expect(requests.some(url => url.includes('/smlib/'))).toBe(true);
    expect(requests.some(url => url.includes('/retained-engine/pkg-retained/'))).toBe(true);
    const chip = page.locator('[data-retained-chip="incomplete"]');
    await expect(chip).toContainText(`${result.summary?.published}/${rows.length}`);
    await chip.click();
    await expect(page.locator('[data-retained-state="incomplete"]')).toBeVisible();
    await expect(page.locator('[data-retained-row]')).toHaveCount(result.summary!.refused.length);
    for (const row of result.summary!.refused) {
      await expect(page.locator(`[data-retained-row="${row.expressId}"]`)).toHaveAttribute('data-code', row.code);
    }
    const refused = result.summary!.refused[0].expressId;
    await page.getByRole('button', { name: `Select #${refused}`, exact: true }).click();
    expect((await snapshot(page)).selected).toBe(refused);
    await record('positive', result);
    if (process.env.IFCLITE_VIEWER_OUT) {
      await page.screenshot({ path: join(process.env.IFCLITE_VIEWER_OUT, 'positive.png') });
    }
  });

  test('a retained federated add is refused before any SDK request', async ({ page }) => {
    const requests: string[] = [];
    page.context().on('request', req => requests.push(req.url()));
    await setup(page, 'exact');
    await page.locator('#file-input-open').setInputFiles(resolve(MAPPED));
    await complete(page, false);
    await page.evaluate(() => {
      sessionStorage.setItem('ifc-lite:geometry-kernel', 'retained');
      history.replaceState(null, '', '/?kernel=retained&perfTrace=1');
    });
    await page.locator('#file-input-add').setInputFiles(resolve(WALL));
    await expect.poll(async () => (await snapshot(page)).error).toMatch(/Retained geometry loads one model at a time/);
    expect((await snapshot(page)).models).toBe(1);
    expect(requests.filter(url => /\/smlib\/|pkg-retained|\/retained-engine\//.test(url))).toEqual([]);
  });

  test('Cancel terminates the real host within 1 s and keeps published meshes', async ({ page }) => {
    await setup(page, 'retained');
    // #7955: a Node-side snapshot between first batch and click can take
    // seconds under GPU load and let this small model finish. Observe the first
    // append in-page and click the real DOM button in the same microtask turn.
    const closed = new Promise<void>(done => page.on('worker', host => {
      if (/retained\.worker/.test(host.url())) host.once('close', () => done());
    }));
    await page.evaluate(() => {
      const globals = globalThis as typeof globalThis & ViewerGlobals;
      const store = globals.__ifc_lite_viewer_store__;
      const unsubscribe = store.subscribe(state => {
        const model = [...state.models.values()][0];
        if (!model?.geometryResult?.meshes.length || model.retainedGeometry?.completeness !== 'running') return;
        unsubscribe();
        queueMicrotask(() => {
          const current = [...store.getState().models.values()][0];
          // This is a primary load, before finalization/ID registration. The
          // single-model stream carries the fixture's express IDs directly.
          const meshIds = [...new Set(current.geometryResult!.meshes.map(mesh => mesh.expressId))];
          const button = [...document.querySelectorAll('button')].filter(button => button.textContent?.trim() === 'Cancel').at(-1);
          globals.__retainedCancel = { clickMs: performance.now(), before: { meshIds, published: current.retainedGeometry!.published } };
          if (!button || button.disabled || current.retainedGeometry?.completeness !== 'running') {
            globals.__retainedCancel.error = 'No enabled Cancel button during the first published batch';
            return;
          }
          button.click();
        });
      });
    });
    await page.locator('#file-input-open').setInputFiles(resolve(MAPPED));
    await page.waitForFunction(() => Boolean((globalThis as typeof globalThis & ViewerGlobals).__retainedCancel));
    const click = await page.evaluate(() => (globalThis as typeof globalThis & ViewerGlobals).__retainedCancel!);
    expect(click.error).toBeUndefined();
    expect(click.before.meshIds.length).toBeGreaterThan(0);
    await closed;
    // Both endpoints use the browser clock. Reading the clock after Playwright
    // observed close is an upper bound, including transport/main-thread delay.
    const closedAt = await page.evaluate(() => performance.now());
    const rowsReady = await page.waitForFunction(() => {
      const model = [...(globalThis as typeof globalThis & ViewerGlobals).__ifc_lite_viewer_store__.getState().models.values()][0];
      return (model?.retainedGeometry?.cancelled ?? 0) > 0 && model?.retainedGeometry?.completeness === 'incomplete' && performance.now();
    });
    const cancelledAt = await rowsReady.jsonValue() as number;
    const before = click.before;
    await complete(page, true);
    const after = await snapshot(page);
    const cancelMs = Math.max(closedAt, cancelledAt) - click.clickMs;
    expect(cancelMs).toBeLessThanOrEqual(1000);
    expect(after.summary!.cancelled).toBeGreaterThan(0);
    expect(after.summary!.refused.every(p => p.code === 'cancelled')).toBe(true);
    expect(after.summary!.published + after.summary!.cancelled).toBe(expected(MAPPED).length);
    for (const id of before.meshIds) expect(after.meshIds).toContain(id);
    for (const row of after.summary!.refused) expect(after.meshIds).not.toContain(row.expressId);
    expect(after.meshIds).toHaveLength(after.summary!.published);
    await record('cancel', { cancelMs, workerCloseMs: closedAt - click.clickMs, measurement: 'browser-clock upper bound through observed Worker close and cancelled rows', before, after });
  });

  test('flagged preview with an empty engine fails before listening', async () => {
    const result = await new Promise<{ code: number | null; output: string }>((done, reject) => {
      const child = spawn('pnpm', ['--filter', '@ifc-lite/viewer', 'exec', 'vite', 'preview', '--port', '0'], {
        env: { ...process.env, VITE_RETAINED_GEOMETRY: 'on', IFCLITE_RETAINED_ENGINE: '', NO_COLOR: '1' },
        stdio: ['ignore', 'pipe', 'pipe'], detached: process.platform !== 'win32',
      });
      let output = '';
      const timeout = setTimeout(() => {
        // pnpm owns a Vite child: terminate our process group on failure too.
        if (process.platform === 'win32') child.kill();
        else if (child.pid) {
          try { process.kill(-child.pid, 'SIGTERM'); }
          catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ESRCH') console.error(error); }
        }
        reject(new Error(`Invalid engine preview failed to exit: ${output}`));
      }, 30_000);
      child.stdout.on('data', data => { output += data; }); child.stderr.on('data', data => { output += data; });
      child.once('error', error => { clearTimeout(timeout); reject(error); });
      child.once('exit', code => { clearTimeout(timeout); done({ code, output }); });
    });
    expect(result.code).not.toBe(0);
    expect(result.output).toContain('Retained export requires --retained-engine DIR or IFCLITE_RETAINED_ENGINE');
    expect(result.output).not.toMatch(/Local:\s+http/);
    await record('missing-engine', result);
  });
});

test('build without a kernel choice loads exact without retained assets', async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== 'viewer-retained-default' && !(engine && existsSync(join(engine, 'engine-manifest.json'))), SKIP);
  const requests: string[] = [], workers: string[] = [];
  page.context().on('request', req => requests.push(req.url()));
  page.on('worker', worker => workers.push(worker.url()));
  await setup(page);
  await page.locator('#file-input-open').setInputFiles(resolve(MAPPED));
  await complete(page, false);
  const result = await snapshot(page);
  expect(result.meshIds.length).toBeGreaterThan(0);
  expect(result.summary).toBeUndefined();
  expect(requests.filter(url => /\/smlib\/|pkg-retained|\/retained-engine\//.test(url))).toEqual([]);
  expect(workers.filter(url => /retained|smlib/.test(url))).toEqual([]);
  await expect(page.locator('[data-retained-chip]')).toHaveCount(0);
  await record('default', result);
});
