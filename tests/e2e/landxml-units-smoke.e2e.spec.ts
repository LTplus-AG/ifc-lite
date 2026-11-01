/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * #5175: production/browser smoke for the LandXML units contract.
 *
 * Two halves, deliberately paired:
 *
 *  1. A units-QUALIFIED synthetic TIN must load, publish a mesh, and expose
 *     its terrain/source records — with no renderer or load diagnostic.
 *  2. The SAME bytes with `<Units>` removed must refuse, with the actionable
 *     LXML009 message, through the real wasm boundary.
 *
 * (2) is what makes (1) meaningful: it proves the units gate is live on the
 * path the browser actually takes, not merely present in a Rust unit test.
 * Before #5175 the rule existed only in the streaming session, so the
 * non-streaming path rendered unitless terrain silently.
 *
 * Runs in the headed WebGPU project (`viewer-e2e`) alongside rte-gpu-witness
 * and federation-control-triplet. State is read through the store singleton
 * the app registers at `globalThis.__ifc_lite_viewer_store__`.
 *
 * Both halves load IMMEDIATELY after setup, with no wait for renderer
 * readiness. That is deliberate and load-bearing: the LandXML provisional path
 * publishes to the GPU during parse, and before #5175 it called `addMeshes` on
 * a renderer whose `init()` had not resolved, throwing "Renderer not
 * initialized" and failing the whole load. Adding a readiness wait here would
 * make these tests pass while silently dropping that regression — the repo
 * rejects `mock.module`, and there is no seam to inject a renderer, so this
 * timing IS the coverage. Do not "stabilize" it by waiting.
 */

import { test, expect, Page } from '@playwright/test';
import { mkdtempSync, readFileSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { ViewerBenchmarkPage } from '../benchmark/viewer-benchmark-page';

/**
 * Committed synthetic fixture, not a vendor export — see the provenance
 * comment inside the file itself.
 */
const QUALIFIED = 'apps/viewer/public/samples/terrain-tin-metric.xml';

const STORE_KEY = '__ifc_lite_viewer_store__';

/** Read a snapshot of viewer state through the app's store singleton. */
async function storeState<T>(page: Page, pick: string): Promise<T> {
  return page.evaluate(
    ({ key, pickExpr }) => {
      const store = (globalThis as Record<string, any>)[key];
      if (!store) throw new Error(`viewer store singleton ${key} not found`);
      // eslint-disable-next-line no-new-func
      return new Function('state', `return (${pickExpr});`)(store.getState());
    },
    { key: STORE_KEY, pickExpr: pick },
  ) as Promise<T>;
}

/** Poll until `pick` returns something truthy, or fail with what it last saw. */
async function waitForState<T>(page: Page, pick: string, timeoutMs: number, what: string): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  let last: unknown;
  while (Date.now() < deadline) {
    last = await storeState<T>(page, pick);
    if (last) return last as T;
    await page.waitForTimeout(250);
  }
  // A bare timeout says nothing about WHY. The load may have refused, errored,
  // or never started; report the store's own account of it.
  const store = await storeState<unknown>(
    page,
    '({ error: state.error ?? null, models: Array.from(state.models.values())'
      + '.map(m => ({ name: m.name, loadState: m.loadState, loadError: m.loadError ?? null,'
      + ' meshes: (m.geometryResult && m.geometryResult.meshes) ? m.geometryResult.meshes.length : 0 })) })',
  ).catch((err) => `unreadable: ${String(err)}`);
  throw new Error(
    `${what} did not appear within ${timeoutMs}ms (last: ${JSON.stringify(last)}; store: ${JSON.stringify(store)})`,
  );
}

const LANDXML_DOC = 'Array.from(state.models.values()).map(m => m.landXmlDocument).find(Boolean) || null';

test.describe('LandXML units contract (#5175)', () => {
  test('a units-qualified TIN loads, publishes a mesh, and keeps its source records', async ({ page, baseURL }) => {
    const pageErrors: string[] = [];
    page.on('pageerror', (err) => pageErrors.push(String(err)));

    // Pin the origin to the project's baseURL: the page object otherwise
    // defaults to a port another checkout may be serving (#5175).
    const viewer = new ViewerBenchmarkPage(page, baseURL);
    await viewer.setup();
    await viewer.loadFile(join(process.cwd(), QUALIFIED));

    const doc = await waitForState<any>(page, LANDXML_DOC, 60000, 'the LandXML document');

    // ── units were read, not guessed ────────────────────────────────
    expect(doc.units, 'declared units reach the viewer').not.toBeNull();
    expect(doc.units.linearUnit).toBe('meter');
    expect(doc.units.linearScaleToMeters).toBe(1);
    expect(doc.capabilities.renderableTin).toBe(true);
    // #5175: this fixture DECLARES its units, so the assumed-unit provenance
    // flag must be false. Without this, the caller-supplied override could
    // regress into stamping declared units as assumed and nothing would catch
    // it — the scale would still be right, so no other assertion here fails.
    expect(
      doc.units.assumed,
      `declared units are never reported as assumed (units: ${JSON.stringify(doc.units)})`,
    ).toBe(false);

    // ── the terrain/source records survived ─────────────────────────
    expect(doc.surfaces).toHaveLength(1);
    const surface = doc.surfaces[0];
    expect(surface.name).toBe('Synthetic_Terrain');
    expect(surface.renderState).toBe('rendered');
    expect(surface.topologyOrigin).toBe('authored_faces');
    expect(surface.points).toHaveLength(9);
    expect(surface.faces).toHaveLength(8);

    // ── coordinate order is northing-first, per LandXML 1.2 ─────────
    // Point 2 is authored `0.000 10.000 100.500`. Reading it as easting-first
    // renders a transposed surface that still passes every count assertion
    // above, so pin the axes explicitly.
    const p2 = surface.points.find((p: any) => p.id === '2');
    expect(p2, 'point id 2 is retained by source id').toBeTruthy();
    expect(p2.northing).toBeCloseTo(0, 6);
    expect(p2.easting).toBeCloseTo(10, 6);
    expect(p2.elevation).toBeCloseTo(100.5, 6);

    // ── a mesh actually reached the renderer ────────────────────────
    const meshCount = await waitForState<number>(
      page,
      'Array.from(state.models.values()).reduce((n, m) => n + ((m.geometryResult && m.geometryResult.meshes) ? m.geometryResult.meshes.length : 0), 0)',
      60000,
      'a published LandXML mesh',
    );
    expect(meshCount).toBeGreaterThan(0);

    const canvas = page.locator('canvas').first();
    await expect(canvas, 'render canvas mounted').toBeVisible();

    // ── and it was clean ────────────────────────────────────────────
    expect(doc.warnings, `parser warnings: ${JSON.stringify(doc.warnings)}`).toHaveLength(0);
    const diagnostics = viewer.getConsoleLogs().filter((line) => /LXML\d{3}/.test(line));
    expect(diagnostics, `unexpected LandXML diagnostics: ${diagnostics.join(' | ')}`).toHaveLength(0);
    expect(pageErrors, `uncaught errors: ${pageErrors.join(' | ')}`).toHaveLength(0);
  });

  test('the same TIN without <Units> is refused with the actionable LXML009 message', async ({ page, baseURL }) => {
    // Strip the Units block from the qualified fixture so the two halves
    // differ in exactly one thing.
    const qualified = readFileSync(join(process.cwd(), QUALIFIED), 'utf8');
    // Anchor on the `<Metric>` child: the fixture's provenance comment mentions
    // `<Units>` in prose, and a looser pattern deletes from inside that comment
    // through the real closing tag, leaving an unterminated comment. The parser
    // then reports LXML006 (malformed XML) — a correct answer to a broken
    // input, and not the refusal this test exists to prove.
    const unitless = qualified.replace(/\s*<Units>\s*<Metric[\s\S]*?<\/Units>/, '');
    expect(unitless, 'the Units element was actually removed').not.toContain('<Metric');
    expect(unitless, 'the mutation left the rest of the document intact')
      .toContain('</LandXML>');
    const dir = mkdtempSync(join(tmpdir(), 'ifc-lite-landxml-'));
    const unitlessPath = join(dir, 'terrain-tin-unitless.xml');
    writeFileSync(unitlessPath, unitless, 'utf8');

    // Pin the origin to the project's baseURL: the page object otherwise
    // defaults to a port another checkout may be serving (#5175).
    const viewer = new ViewerBenchmarkPage(page, baseURL);
    await viewer.setup();
    await viewer.loadFile(unitlessPath);

    // The refusal must surface, and no terrain may be published from it.
    const deadline = Date.now() + 60000;
    let refusal = '';
    while (Date.now() < deadline && !refusal) {
      const surfaced = [...viewer.getConsoleLogs()];
      const uiText = await page.evaluate(() => document.body.innerText);
      refusal = [...surfaced, uiText].find((line) => /linearUnit/.test(line)) ?? '';
      if (!refusal) await page.waitForTimeout(250);
    }
    const observed = await storeState<unknown>(
      page,
      '({ error: state.error ?? null, models: Array.from(state.models.values()).map(m => ({ loadState: m.loadState, loadError: m.loadError ?? null })) })',
    );
    expect(
      refusal,
      `the unitless TIN must be refused with a message naming LandXML/Units and linearUnit `
        + `(store: ${JSON.stringify(observed)})`,
    ).toMatch(/LandXML\/Units/);

    const doc = await storeState<any>(page, LANDXML_DOC);
    expect(doc, 'a refused document must not become a loaded model').toBeNull();
  });
});
