/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// #8564 demo smoke for validate-native-adapter.mjs --demo: the real-scene page
// loads, labels itself, draws both captures on the viewer device and stays
// error-free. Stills along the 30 s journey help the recording; they are not
// load or performance evidence.
import { resolve } from 'node:path';
import { seemFixture, startDemoServer } from './native-adapter-demo-server.mjs';

const BANNER = 'Internal unqualified Gaussian adapter preview — not production';
const NOT_ALIGNED = 'artificially placed, not aligned, no metric scale';
const STILLS = [0, 15, 22];
/** Expected credits and pinned row counts per capture set (prepare.mjs and tests/models/manifest.json). */
async function expectations(capture) {
  if (capture === 'seem') {
    const fixture = await seemFixture();
    return { assets: 1, rows: fixture.gaussian.count, credit: ['Seem Kirke', 'Peter Rødsgaard Rasmussen', 'CC BY 4.0', NOT_ALIGNED] };
  }
  return { assets: 2, rows: 113648 + 384589, credit: ['Captures: Marcel Padilla, CC-BY-4.0 (artificially placed)', NOT_ALIGNED] };
}

/** Wait until the adapter has encoded `frames` more splat passes (or IFC frames when it is absent). */
const settleFrames = (page, frames) => page.evaluate(async count => {
  const demo = window.nativeAdapterDemo;
  const drawn = () => demo.stats().gaussian?.drawnFrames ?? demo.stats().diagnostics.calls;
  const target = drawn() + count;
  const started = performance.now();
  while (drawn() < target) {
    if (performance.now() - started > 120000) throw new Error(`demo drew fewer than ${count} frames in 120 s`);
    await new Promise(resolve => setTimeout(resolve, 50));
  }
}, frames);

/** Capture the renderer's own colour frame in-page; return lit and changed pixel statistics only. */
const frameStats = page => page.evaluate(async () => {
  const frame = await window.nativeAdapterDemo.capture();
  if (!frame) return null;
  window.__demoFrames = [...(window.__demoFrames ?? []), frame.rgba];
  let lit = 0;
  for (let i = 0; i < frame.rgba.length; i += 4) if (Math.abs(frame.rgba[i] - 18) + Math.abs(frame.rgba[i + 1] - 23) + Math.abs(frame.rgba[i + 2] - 26) > 12) lit++;
  return { width: frame.width, height: frame.height, litFraction: lit / (frame.width * frame.height), index: window.__demoFrames.length - 1 };
});
const changedPixels = (page, a, b) => page.evaluate(([i, j]) => {
  const [x, y] = [window.__demoFrames[i], window.__demoFrames[j]];
  let changed = 0;
  for (let p = 0; p < x.length; p += 4) if (x[p] !== y[p] || x[p + 1] !== y[p + 1] || x[p + 2] !== y[p + 2]) changed++;
  return changed;
}, [a, b]);

export async function runDemo({ browser, openPage, output, backend, stamp, allowPendingAdapter, capture }) {
  const expected = await expectations(capture);
  const server = await startDemoServer({ port: 0 });
  const url = `${server.resolvedUrls.local[0]}contract/native-adapter-demo.html${capture ? `?capture=${capture}` : ''}`;
  const label = `${capture ?? 'default'}-${backend}-${stamp}`;
  const { context, page, log } = await openPage(browser);
  const checks = [];
  const check = (name, pass, detail) => checks.push({ name, pass: Boolean(pass), ...(pass ? {} : { detail }) });
  try {
    const started = Date.now();
    await page.goto(url);
    await page.waitForFunction(() => window.nativeAdapterDemo?.ready || window.nativeAdapterDemo?.error, undefined, { timeout: 600000 });
    const loadSeconds = (Date.now() - started) / 1000;
    const state = await page.evaluate(() => {
      const { ready, error, phase, captureSet, counts, framing, placements, meshCount, modelBounds } = window.nativeAdapterDemo;
      return { ready, error, phase, captureSet, counts, framing, placements, meshCount, modelBounds,
        stats: ready ? JSON.parse(JSON.stringify(window.nativeAdapterDemo.stats())) : null };
    });
    check('demo loaded', state.ready && !state.error, state.error);
    const banner = await page.locator('#banner').innerText(), attribution = await page.locator('#attribution').innerText();
    check('banner labels the preview as internal, unqualified, not production', banner.includes(BANNER), banner);
    check('banner discloses approximate composition over IFC glass and centre clipping',
      banner.includes('Approximate composition over IFC glass') && banner.includes('Centre clipping'), banner);
    check('attribution credits the capture and discloses the artificial placement', expected.credit.every(text => attribution.includes(text)), attribution);
    const diagnosticsText = await page.locator('#diagnostics').innerText();
    check('diagnostics labelled as diagnostic timing, not a benchmark', diagnosticsText.includes('diagnostic timing, not a benchmark'), diagnosticsText);
    const screenshots = [], frames = {}, timings = { loadSeconds };
    const lap = (name, since) => { timings[name] = (Date.now() - since) / 1000; };
    if (state.ready) {
      const gaussian = state.stats.gaussian;
      check('IFC meshes uploaded', state.meshCount > 0, state.meshCount);
      check('readiness stays blocked', state.stats.readiness.state === 'blocked', state.stats.readiness);
      if (gaussian || !allowPendingAdapter) {
        check('captures resident on the viewer device', gaussian?.assets === expected.assets && gaussian?.splats === expected.rows
          && Object.values(state.stats.states).every(s => s.state === 'resident'), { gaussian, states: state.stats.states });
      }
      for (const seconds of STILLS) {
        const since = Date.now();
        await page.evaluate(t => window.nativeAdapterDemo.setJourneyTime(t), seconds);
        await settleFrames(page, 2);
        const path = resolve(output, `native-adapter-demo-${label}-t${String(seconds).padStart(2, '0')}.png`);
        await page.screenshot({ path });
        screenshots.push(path);
        frames[`t${seconds}`] = await frameStats(page);
        lap(`still-t${seconds}`, since);
      }
      check('journey stills render the scene', Object.values(frames).every(f => f && f.litFraction > 0.05), frames);
      if (gaussian) {
        // Opening (front) pose: the captures face the camera there; later poses may orbit behind the model.
        await page.evaluate(() => window.nativeAdapterDemo.setJourneyTime(0));
        await settleFrames(page, 2);
        frames.shown = await frameStats(page);
        await page.evaluate(() => window.nativeAdapterDemo.setSplatsVisible(false));
        await page.waitForTimeout(500);
        frames.hidden = await frameStats(page);
        await page.evaluate(() => window.nativeAdapterDemo.setSplatsVisible(true));
        const changed = await changedPixels(page, frames.hidden.index, frames.shown.index);
        frames.splatChangedPixels = changed;
        check('captures visibly contribute at the opening journey pose', changed > 500, changed);
      }
      const after = await page.evaluate(() => JSON.parse(JSON.stringify(window.nativeAdapterDemo.stats())));
      state.statsAfter = after;
      check('no uncaptured WebGPU errors', after.errors.length === 0 && after.diagnostics.gpuErrors === 0, { errors: after.errors, diagnostics: after.diagnostics });
    }
    check('no page errors', log.pageErrors.length === 0, log.pageErrors);
    check('no browser console errors', log.consoleErrors.length === 0, log.consoleErrors);
    check('no failed requests', log.failedRequests.length === 0, log.failedRequests);
    const failed = checks.filter(c => !c.pass);
    const pending = state.ready && !state.stats.gaussian;
    return {
      status: failed.length ? 'fail' : pending ? 'baseline-only (adapter API missing)' : 'pass',
      verdict: { pass: failed.length === 0, total: checks.length, failed },
      checks: checks.map(c => `${c.pass ? 'PASS' : 'FAIL'} ${c.name}`),
      url: url.replace(/127\.0\.0\.1:\d+/, '127.0.0.1:<port>'), capture: capture ?? 'default',
      demo: { loadSeconds, timings, ...state, frames }, screenshots, browserLog: log,
      note: 'Functional smoke only. Placements are artificial, not aligned and non-metric; stills are recording aids; lastEncodeMs and loadSeconds are diagnostic timing, not a benchmark.',
    };
  } finally {
    await context.close();
    await server.close();
  }
}
