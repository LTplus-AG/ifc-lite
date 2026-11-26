#!/usr/bin/env node
/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Cinematic recorder for the huge-geometry campaign (scripts/perf/huge-geometry.md):
 * one clip per tier of the SHOWCASE city (huge-geometry-showcase.mjs), loaded in
 * the real viewer on a real GPU, with the canvas filling the frame, a compact
 * HUD, and a scripted camera path (huge-geometry-cinema-path.mjs): fly-in,
 * orbit, dive, street level, then feature beats (isolate a storey, a section
 * sweep, a colour override, a pick) and a pull-back. The path is a pure
 * function of the showcase manifest and runs by time, so a before clip and an
 * after clip on any branch follow the identical path in lock-step;
 * huge-geometry-compose.mjs puts two such clips side by side.
 *
 *   node scripts/perf/huge-geometry-cinema.mjs --label NAME --models-dir DIR --out DIR
 *        [--tiers 250k,1M] [--seed 1] [--viewer-url URL | --dist DIR [--query 'a=1&b=2']]
 *        [--fps 30] [--load-speed 4] [--timeout-min 12]
 *
 * Per tier writes OUT/clips/LABEL-NAME.webm (+ .mp4 with gstreamer), the clip
 * timeline and numbers OUT/clips/LABEL-NAME.json, stills OUT/stills/LABEL-NAME-SHOT.png,
 * and merges an index OUT/LABEL.json (so tiers recorded in separate GPU slices
 * accumulate). The scene is the showcase look, footage only: the HUD and cards
 * say so, and every timing shown is diagnostic (a screencast is attached).
 */

import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { isMainEntry } from '../lib/is-main-entry.mjs';
import { generateScenario } from './huge-geometry-gen.mjs';
import { ROOT, bounded, launchGpu, loadModel, nonNegativeInteger, positiveFinite, startSampler } from './huge-geometry-browser.mjs';
import { withTimeout } from './oom-load-probe-lib.mjs';
import { SCENE_STATS } from './huge-geometry-page.mjs';
import { frameSummary } from './huge-geometry-report.mjs';
import { parseTier } from './huge-geometry-run.mjs';
import { HIDE_PRIVACY_NOTICE, attachScreencast, cardHtml, startEncoder, toMp4 } from './huge-geometry-video.mjs';
import { buildShots, poseAt, ranFullPath, solveAxisMap, totalMs } from './huge-geometry-cinema-path.mjs';
import { BEAT, BOUNDS_OF, CAMERA_CALL, CAMERA_HOLD, CANVAS_BOX, CINE_HUD, FULLFRAME, PROJECT, RUN_SHOT, SELECTION, TWEEN_DONE } from './huge-geometry-cinema-page.mjs';
import { startViewerServer } from './viewer-load-probe.mjs';

const gb = (mib) => (Number.isFinite(mib) && mib > 0 ? (mib >= 1024 ? `${(mib / 1024).toFixed(2)} GB` : `${Math.round(mib)} MB`) : '–');
const fmt = (n) => (Number.isFinite(n) ? Math.round(n).toLocaleString('en-US') : '–');
const mtris = (n) => (Number.isFinite(n) && n > 0 ? `${(n / 1e6).toFixed(1)} M` : '–');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const HIGHLIGHT = [1.0, 0.82, 0.1, 1];
const SAMPLES_PER_SECOND = 60;

/** Print `file` as marked base64 lines (`HGFILE <rel> <part>/<parts> <base64>`) for huge-geometry-unpack.mjs. */
export function emitFile(file, rel, chunk = 1 << 16) {
  const b64 = readFileSync(file).toString('base64');
  const parts = Math.max(1, Math.ceil(b64.length / chunk));
  for (let i = 0; i < parts; i++) process.stdout.write(`HGFILE ${rel} ${i + 1}/${parts} ${b64.slice(i * chunk, (i + 1) * chunk)}\n`);
}

/** The viewer URL for a run: `--viewer-url` as given (perfTrace forced on), or the served dist plus `--query`. */
export function viewerUrl({ viewerUrl: given, baseUrl, query }) {
  const u = new URL(given ?? `${baseUrl}/`);
  if (!given && query) for (const [k, v] of new URLSearchParams(query.replace(/^\?/, ''))) u.searchParams.set(k, v);
  u.searchParams.set('perfTrace', '1');
  return u.toString();
}

/** Flat viewer-space pose samples (eye xyz, target xyz) for one shot. */
export function shotSamples(shot, map) {
  const n = Math.max(2, Math.ceil((shot.durationMs / 1000) * SAMPLES_PER_SECOND));
  const out = [];
  for (let i = 0; i <= n; i++) {
    const { eye, target } = poseAt(shot, i / n);
    out.push(...map.apply(eye), ...map.apply(target));
  }
  return out;
}

/** Map IFC world coordinates onto the viewer's world from the anchors' renderer bounds; a Z-up -> Y-up guess if they fail. */
async function calibrate(page, showcase) {
  const anchors = showcase.hero.anchors;
  const got = await bounded(page.evaluate(BOUNDS_OF, anchors.map((a) => a.id)), 30000).catch(() => []);
  const pairs = got.filter((g) => g.centre).map((g) => ({ ifc: anchors.find((a) => a.id === g.id).centre, viewer: g.centre }));
  const map = solveAxisMap(pairs);
  if (map && map.rms < 1.0) return { map, how: `anchors (${pairs.length}, rms ${map.rms.toFixed(3)} m)` };
  const guess = { perm: [0, 2, 1], sign: [1, 1, -1], offset: [0, 0, 0], rms: null, apply: (p) => [p[0], p[2], -p[1]] };
  return { map: guess, how: `fallback Z-up -> Y-up guess (anchors: ${pairs.length}, rms ${map?.rms ?? '–'})` };
}

export async function tryClick(page, centre, timeoutMs = 5000) {
  const at = await withTimeout(page.evaluate(PROJECT, centre).catch(() => null), timeoutMs, () => null);
  if (!at || at.x < 0 || at.y < 0 || at.x > 1600 || at.y > 900) return { at, sel: null };
  try {
    await bounded(page.mouse.move(at.x, at.y), timeoutMs, 'pick mouse move');
    await bounded(page.mouse.down(), timeoutMs, 'pick mouse down');
    await sleep(50);
    await bounded(page.mouse.up(), timeoutMs, 'pick mouse up');
  } catch { return { at, sel: null }; }
  let sel = null;
  for (let i = 0; i < 10 && !sel; i++) { await sleep(80); sel = await withTimeout(page.evaluate(SELECTION).catch(() => null), timeoutMs, () => null); }
  return { at, sel };
}

async function recordTier({ label, manifest, url, out, fps, loadSpeed, timeoutMs, urlNote }) {
  const s = manifest.scenario, sc = manifest.showcase, name = s.name;
  const clips = join(out, 'clips'), stills = join(out, 'stills');
  const webm = join(clips, `${label}-${name}.webm`);
  const encoder = startEncoder(webm, { fps, gop: 15 });
  const shots = buildShots(sc);
  const clip = { label, name, look: 'showcase', sceneLabel: manifest.label, url, elements: manifest.totals.elements, buildings: sc.buildings,
    styles: sc.styles, repeated: manifest.totals.repeated, fileMiB: manifest.totals.bytes / 2 ** 20, fps, loadSpeed, status: 'failed',
    timeline: { title: null, load: null, path: null, verdict: null, summary: null }, shots: [], evidence: 'diagnostic (screencast attached, shared GPU)' };
  const mark = () => encoder.seconds;
  const session = await launchGpu({ extraInit: [HIDE_PRIVACY_NOTICE] });
  const stop = await attachScreencast(session.context, session.page, encoder);
  const page = session.page;
  const cdp = await session.context.newCDPSession(page);
  await cdp.send('Performance.enable');
  const sampler = startSampler(session.profileDir, cdp);
  const memLine = () => {
    const m = sampler.peek() ?? {};
    // Windows Chrome over CDP (PC): process memory is not visible from WSL, only the JS heap through CDP.
    if (session.windowsPaths) return `memory: JS heap ${gb(m.jsHeapMiB)} (Windows Chrome: process memory not sampled)`;
    return `memory: tab ${gb(m.rendererPssMiB)} · GPU proc ${gb(m.gpuPssMiB)} · VRAM ${gb(m.vramMiB)} · JS heap ${gb(m.jsHeapMiB)}`;
  };
  const tierText = name.replace(/^showcase-/, '');
  const hud = { head: `${label} · showcase ${tierText}`, tag: 'SHOWCASE scene · footage only, not a measurement family',
    lines: [`${fmt(clip.elements)} elements · ${fmt(sc.buildings)} buildings · ${sc.styles} styles · ≥ ${mtris(manifest.totals.trianglesKnown)} tris (generator)`],
    idle: 'loading…', mem: '', caption: '', foot: 'diagnostic timings, not evidence' };
  // Bounded: a tab frozen by a huge scene must not stall the recorder.
  const push = () => bounded(page.evaluate((st) => { globalThis.__hgCine = st; }, hud), 5000).catch(() => null);
  let ticker = null, loadStart = null;
  try {
    // Title card.
    const t0 = mark();
    await page.setContent(cardHtml({ title: `${label} · showcase city · ${tierText}`, lines: [
      `${fmt(clip.elements)} elements · ${fmt(sc.buildings)} buildings on ${fmt(sc.blocks)} blocks · ${sc.styles} colour styles · ${(clip.repeated / clip.elements * 100).toFixed(0)}% instanced`,
      `file ${gb(clip.fileMiB)} · ${manifest.label}`, `viewer: ${urlNote}`, 'all timings shown are diagnostic, not evidence'] }));
    encoder.realtime();
    await encoder.waitFrame();
    await sleep(300);
    await encoder.hold(3);
    clip.timeline.title = [t0, mark()];
    // Load, time-lapsed; the canvas is lifted to fill the frame as soon as the viewer exists.
    loadStart = mark();
    const started = Date.now();
    encoder.timelapse(1000 / fps * loadSpeed);
    let loaded = false;
    ticker = setInterval(() => {
      hud.mem = memLine();
      if (!loaded) hud.idle = `loading… ${((Date.now() - started) / 1000).toFixed(0)} s (video plays the load at ${loadSpeed}× speed)`;
      if (page.url().startsWith('http')) void page.evaluate(FULLFRAME).then(() => page.evaluate(CINE_HUD)).then(push).catch(() => null);
    }, 500);
    // A hard deadline over the whole load: on the PC a 2M load once hung past the harness's own timeout for 25 min.
    const deadlineMs = timeoutMs + 90000;
    console.log(`[cinema ${name}] loading (deadline ${Math.round(deadlineMs / 60000)} min)`);
    const load = await withTimeout(loadModel(session, null, manifest.files, { timeoutMs, url }), deadlineMs,
      () => ({ ok: false, wallMs: Date.now() - started, adapter: null,
        failure: { kind: 'timeout', detail: `not interactive after ${Math.round(deadlineMs / 60000)} min (recorder deadline; no crash, no viewer error)` } }));
    clip.load = { ok: load.ok, timings: load.ok ? { firstFrameMs: load.timings.firstFrameMs, interactiveMs: load.timings.interactiveMs } : null,
      failure: load.failure ?? null, wallMs: load.wallMs, adapter: load.adapter };
    console.log(`[cinema ${name}] load ${load.ok ? 'ok' : `failed: ${load.failure?.kind}`} after ${((load.wallMs ?? 0) / 1000).toFixed(0)} s`);
    if (!load.ok) {
      clearInterval(ticker); ticker = null;
      // The viewer's own error panel names what broke (e.g. "3D Rendering Failed: Failed to get GPU adapter" after a lost GPU process).
      const shown = await bounded(page.evaluate(() => {
        const t = document.body?.innerText ?? '';
        const m = /(3D Rendering Failed[^\n]*\n+[^\n]+)/.exec(t) ?? /((?:out of memory|device (?:was )?lost|failed to load)[^\n]*)/i.exec(t);
        return m ? m[1].replace(/\s*\n+\s*/g, ': ') : null;
      }), 5000).catch(() => null);
      if (shown) { load.failure = { ...load.failure, viewerShows: shown, detail: `${shown} (harness: ${load.failure.detail})` }; clip.load.failure = load.failure; }
      hud.idle = `FAILED after ${(load.wallMs / 1000).toFixed(0)} s: ${load.failure.kind}`;
      hud.tone = 'bad';
      hud.caption = `load failed: ${load.failure.viewerShows ?? load.failure.kind}`; hud.captionTone = 'bad';
      hud.mem = memLine();
      // Bounded: a tab whose main thread is blocked never answers an evaluate.
      const alive = await bounded(page.evaluate(FULLFRAME).then(() => page.evaluate(CINE_HUD)).then(push), 10000).then(() => true, () => false);
      if (!alive) { load.failure = { ...load.failure, detail: `${load.failure.detail}; tab unresponsive (main thread blocked)` }; clip.load.failure = load.failure; }
      encoder.realtime();
      await sleep(2500);
      await page.screenshot({ path: join(stills, `${label}-${name}-failed.png`), timeout: 15000 }).catch(() => null);
      clip.timeline.load = [loadStart, mark()];
      clip.failure = load.failure;
      clip.peak = (await sampler.stop().catch(() => null))?.peak ?? null;
      return { clip, encoder, stop, session };
    }
    loaded = true;
    encoder.realtime();
    clearInterval(ticker); ticker = null;
    clip.timeline.load = [loadStart, mark()];
    await bounded(page.evaluate(FULLFRAME), 30000).catch(() => null);
    await bounded(page.evaluate(CINE_HUD), 30000).catch(() => null);
    await sleep(700);
    clip.canvas = await bounded(page.evaluate(CANVAS_BOX), 30000).catch(() => null);
    const scene = await bounded(page.evaluate(SCENE_STATS), 30000).catch(() => null);
    clip.scene = scene ? { triangles: scene.triangles, meshes: scene.meshes } : null;
    const tm = load.timings;
    // The viewer's scene total counts an instanced template once, so the generator's lower bound is the honest scene size.
    const tris = `≥ ${mtris(manifest.totals.trianglesKnown)} tris`;
    hud.lines = [`${fmt(clip.elements)} elements · ${tris} · ${fmt(sc.buildings)} buildings · ${sc.styles} styles`,
      `load ${(tm.interactiveMs / 1000).toFixed(1)} s · first frame ${tm.firstFrameMs === null ? '–' : `${(tm.firstFrameMs / 1000).toFixed(1)} s`}`];
    hud.idle = '';
    const cal = await calibrate(page, sc);
    clip.calibration = { how: cal.how, perm: cal.map.perm, sign: cal.map.sign, offset: cal.map.offset };
    await push();
    ticker = setInterval(() => { hud.mem = memLine(); void push(); }, 500);
    // The path.
    const pathStart = mark();
    let stalled = 0;
    for (const shot of shots) {
      if (stalled >= 2) {
        // Two shots in a row never returned a frame record: the tab is frozen. Stop the path, say so on screen.
        clip.unresponsive = true;
        hud.caption = `tab unresponsive: camera path stopped after ${clip.shots.length} shots`; hud.captionTone = 'bad';
        await push();
        await sleep(4000);
        await page.screenshot({ path: join(stills, `${label}-${name}-unresponsive.png`), timeout: 20000 }).catch(() => null);
        break;
      }
      const entry = { name: shot.name, caption: shot.caption, start: mark(), durationMs: shot.durationMs, beat: shot.beat ?? null };
      hud.caption = shot.caption; hud.captionTone = '';
      await push();
      const beatErr = (err) => { entry.beatError = String(err?.message ?? err).slice(0, 300); hud.caption = `${shot.caption} · FAILED: ${entry.beatError.slice(0, 80)}`; hud.captionTone = 'bad'; };
      if (shot.beat === 'isolate') await bounded(page.evaluate(BEAT, { action: 'isolate', ids: sc.hero.storey?.ids ?? [] }), 60000).catch(beatErr);
      if (shot.beat === 'section') await bounded(page.evaluate(BEAT, { action: 'section-on' }), 60000).catch(beatErr);
      if (shot.beat === 'colour') await bounded(page.evaluate(BEAT, { action: 'colour-on', ids: sc.hero.ids, colour: HIGHLIGHT }), 60000).catch(beatErr);
      await push();
      const samples = shotSamples(shot, cal.map);
      const section = shot.beat === 'section' ? { start: 0.08, end: 0.8, from: 100, to: 24 } : null;
      const running = page.evaluate(RUN_SHOT, { samples, durationMs: shot.durationMs, section });
      const still = sleep(shot.durationMs * (shot.beat === 'pick' ? 0.8 : 0.55)).then(() => page.screenshot({ path: join(stills, `${label}-${name}-${shot.name}.png`), timeout: 20000 }).catch(() => null));
      if (shot.beat === 'pick' && sc.hero.pick) {
        // The shot holds the camera still from 25% to 60%. On main a GPU pick right after programmatic camera
        // poses can miss, so strategies are tried in order and the clip records which one selected something:
        // a plain click; a real wheel nudge first; the viewer's own home() tween then a click at the target;
        // the viewer's own frameEntities() tween onto the target then a click. The camera path resumes after.
        await sleep(shot.durationMs * 0.28);
        const strategies = [
          ['click', async () => {}],
          ['wheel-nudge', async () => { await bounded(page.mouse.wheel(0, -1), 5000, 'pick wheel nudge'); await sleep(250); }],
          ['home-tween', async () => { await bounded(page.evaluate(CAMERA_CALL, { call: 'home' }), 5000); await bounded(page.evaluate(TWEEN_DONE), 30000); }],
          ['frame-tween', async () => { await bounded(page.evaluate(CAMERA_CALL, { call: 'frame', ids: [sc.hero.pick.id] }), 5000); await bounded(page.evaluate(TWEEN_DONE), 30000); }],
        ];
        let got = { at: null, sel: null }, used = null;
        await withTimeout(page.evaluate(CAMERA_HOLD, true).catch(() => null), 5000, () => null);
        await sleep(150);
        try {
          for (const [k, prep] of strategies) {
            if (!await prep().then(() => true, () => false)) continue;
            got = await tryClick(page, cal.map.apply(sc.hero.pick.centre));
            if (got.sel) { used = k; break; }
          }
        } finally { await withTimeout(page.evaluate(CAMERA_HOLD, false).catch(() => null), 5000, () => null); }
        entry.pick = { at: got.at, selected: got.sel, expected: sc.hero.pick.id, strategy: used };
        if (got.sel) {
          const match = got.sel.id === sc.hero.pick.id;
          hud.caption = `pick → #${got.sel.id} ${got.sel.type ?? ''} "${got.sel.name ?? ''}"${match ? '' : ` (expected #${sc.hero.pick.id})`}${used === 'click' ? '' : ` · after ${used}`}`;
          hud.captionTone = match ? 'good' : '';
          if (!match) beatErr(new Error(`pick selected #${got.sel.id}, expected #${sc.hero.pick.id}`));
        } else { hud.caption = 'pick → nothing selected (GPU pick missed after programmatic camera moves)'; hud.captionTone = 'bad'; }
        await push();
        if (!got.at) beatErr(new Error('pick target off screen'));
        else if (!got.sel) beatErr(new Error('pick selected nothing'));
      }
      const records = await bounded(running, shot.durationMs + 60000).catch((err) => { entry.error = String(err?.message ?? err).slice(0, 300); return []; });
      stalled = records.length > 1 ? 0 : stalled + 1;
      await still;
      entry.end = mark();
      entry.frames = records.length ? frameSummary(records) : null;
      if (shot.beat === 'isolate') await bounded(page.evaluate(BEAT, { action: 'show-all' }), 60000).catch(beatErr);
      if (shot.beat === 'section') await bounded(page.evaluate(BEAT, { action: 'section-off' }), 60000).catch(beatErr);
      if (shot.beat === 'colour') await bounded(page.evaluate(BEAT, { action: 'colour-off' }), 60000).catch(beatErr);
      if (shot.beat === 'pick') await page.evaluate(BEAT, { action: 'clear-selection' }).catch(() => null);
      clip.shots.push(entry);
      console.log(`[cinema ${name}] ${shot.name}: ${entry.frames ? `median ${entry.frames.frameMs.median} ms, p95 ${entry.frames.frameMs.p95} ms, ${entry.frames.drawsPerFrame.median} draws` : entry.error}${entry.beatError ? ` (beat: ${entry.beatError})` : ''}`);
    }
    clip.timeline.path = [pathStart, mark()];
    hud.caption = '';
    clearInterval(ticker); ticker = null;
    clip.peak = (await sampler.stop().catch(() => null))?.peak ?? null;
    const errors = clip.shots.filter((x) => x.error || x.beatError);
    clip.status = clip.unresponsive ? 'unresponsive' : errors.length ? 'interaction-error' : 'ok';
    if (clip.unresponsive) clip.failure = { kind: 'unresponsive', detail: `loaded in ${(tm.interactiveMs / 1000).toFixed(0)} s, then the tab stopped answering: no frame record from two consecutive camera shots` };
    return { clip, encoder, stop, session };
  } catch (err) {
    clip.status = 'error';
    clip.failure = { kind: session.events.crashed ? 'renderer-crash' : 'harness-error', detail: String(err?.message ?? err).slice(0, 600) };
    return { clip, encoder, stop, session };
  } finally {
    // One cleanup for every exit (a no-op where the path already did it).
    if (ticker) clearInterval(ticker);
    // Keep the load footage recorded up to an error, as the failed-load path does.
    if (loadStart !== null) clip.timeline.load ??= [loadStart, mark()];
    clip.peak ??= (await sampler.stop().catch(() => null))?.peak ?? null;
  }
}

/** Summary (ok) or verdict (failed) card in a fresh browser, so a dead tab cannot block it. */
async function endCard(encoder, out, clip) {
  const session = await launchGpu({ extraInit: [HIDE_PRIVACY_NOTICE] });
  try {
    const stop = await attachScreencast(session.context, session.page, encoder);
    const path = clip.shots.filter((x) => x.frames);
    const med = (k) => { const v = path.map((x) => x.frames.frameMs[k]).filter(Number.isFinite).sort((a, b) => a - b); return v.length ? v[Math.floor(v.length / 2)] : null; };
    const t = clip.load?.timings;
    const ok = ranFullPath(clip);
    const beatErrors = clip.shots.filter((x) => x.beatError).map((x) => `${x.name}: ${x.beatError}`);
    const lines = ok ? [
      ...(beatErrors.length ? [`beat failed · ${beatErrors.join(' · ').slice(0, 200)}`] : []),
      `load ${(t.interactiveMs / 1000).toFixed(1)} s · first frame ${t.firstFrameMs === null ? '–' : (t.firstFrameMs / 1000).toFixed(1)} s · ${fmt(clip.elements)} elements · ${mtris(clip.scene?.triangles)} scene triangles`,
      `camera path: frame median ${med('median') ?? '–'} ms · p95 ${med('p95') ?? '–'} ms (median over shots)`,
      ...path.map((x) => `  ${x.name.padEnd(10)} median ${x.frames.frameMs.median} ms · p95 ${x.frames.frameMs.p95} · ${x.frames.drawsPerFrame.median} draws${x.pick ? ` · picked #${x.pick.selected?.id ?? '–'}` : ''}`),
      `peak: tab ${gb(clip.peak?.rendererPssMiB)} · GPU proc ${gb(clip.peak?.gpuPssMiB)} · VRAM ${gb(clip.peak?.vramMiB)}`,
      'showcase scene (footage only) · timings diagnostic, not evidence'] : [
      String(clip.failure?.detail ?? '').slice(0, 220),
      t ? `loaded first: ${(t.interactiveMs / 1000).toFixed(1)} s` : `load did not complete (${((clip.load?.wallMs ?? 0) / 1000).toFixed(0)} s)`,
      `peak: tab ${gb(clip.peak?.rendererPssMiB)} · JS heap ${gb(clip.peak?.jsHeapMiB)} · VRAM ${gb(clip.peak?.vramMiB)}`,
      `${fmt(clip.elements)} elements · file ${gb(clip.fileMiB)} · showcase scene (footage only) · diagnostic`];
    await session.page.setViewportSize({ width: 1600, height: 900 });
    await session.page.setContent(cardHtml({ tone: ok ? 'good' : 'bad', title: `${clip.label} · showcase ${clip.name.replace(/^showcase-/, '')}: ${ok ? 'done' : `FAILED (${clip.failure?.kind ?? clip.status})`}`, lines }));
    encoder.realtime();
    await sleep(400);
    const t0 = encoder.seconds;
    await encoder.hold(ok ? 4 : 5);
    clip.timeline[ok ? 'summary' : 'verdict'] = [t0, encoder.seconds];
    await session.page.screenshot({ path: join(out, 'stills', `${clip.label}-${clip.name}-${ok ? 'summary' : 'verdict'}.png`), timeout: 15000 }).catch(() => null);
    encoder.pause();
    await stop();
  } finally { await session.close(); }
}

async function main() {
  const { values } = parseArgs({ options: {
    label: { type: 'string' }, 'models-dir': { type: 'string' }, out: { type: 'string' }, tiers: { type: 'string', default: '250k,1M' },
    seed: { type: 'string', default: '1' }, 'viewer-url': { type: 'string' }, dist: { type: 'string', default: join(ROOT, 'apps/viewer/dist') },
    query: { type: 'string', default: '' }, fps: { type: 'string', default: '30' }, 'load-speed': { type: 'string', default: '4' },
    'timeout-min': { type: 'string', default: '12' }, 'emit-stdout': { type: 'boolean', default: false },
    'emit-max-mb': { type: 'string', default: '170' },
  } });
  const usage = 'usage: huge-geometry-cinema.mjs --label NAME --models-dir DIR --out DIR [--tiers 250k,1M] [--seed 1] '
      + "[--viewer-url URL | --dist DIR [--query 'a=1&b=2']] [--fps 30] [--load-speed 4] [--timeout-min 12] [--emit-stdout] [--emit-max-mb 170]";
  if (!values.label || !values['models-dir'] || !values.out || !/^[\w.-]+$/.test(values.label)) {
    console.error(usage);
    process.exit(2);
  }
  const seed = nonNegativeInteger('seed', values.seed, usage);
  const fps = positiveFinite('fps', values.fps, usage);
  const loadSpeed = positiveFinite('load-speed', values['load-speed'], usage);
  const timeoutMs = positiveFinite('timeout-min', values['timeout-min'], usage) * 60000;
  const emitMaxMb = positiveFinite('emit-max-mb', values['emit-max-mb'], usage);
  const out = resolve(values.out);
  mkdirSync(join(out, 'clips'), { recursive: true });
  mkdirSync(join(out, 'stills'), { recursive: true });
  let server = null, baseUrl = null;
  if (!values['viewer-url']) {
    const dist = resolve(values.dist);
    if (!existsSync(join(dist, 'index.html'))) throw new Error(`no viewer build at ${dist} (build it, or pass --dist / --viewer-url)`);
    ({ server, baseUrl } = await startViewerServer(() => dist));
  }
  const url = viewerUrl({ viewerUrl: values['viewer-url'], baseUrl, query: values.query });
  const urlNote = values['viewer-url'] ? url : `${values.dist === join(ROOT, 'apps/viewer/dist') ? 'apps/viewer/dist' : resolve(values.dist)}${values.query ? ` ?${values.query}` : ''}`;
  const indexPath = join(out, `${values.label}.json`);
  const index = existsSync(indexPath) ? JSON.parse(readFileSync(indexPath, 'utf8')) : { label: values.label, clips: {} };
  try {
    for (const tier of values.tiers.split(',').map(parseTier)) {
      const manifest = generateScenario(resolve(values['models-dir']), { look: 'showcase', elements: tier, seed });
      const r = await recordTier({ label: values.label, manifest, url, out, fps, loadSpeed,
        timeoutMs, urlNote });
      r.encoder.pause();
      await r.stop();
      await r.session.close();
      await endCard(r.encoder, out, r.clip);
      const enc = await r.encoder.close();
      if (enc.code !== 0) throw new Error(`ffmpeg exited ${enc.code} for ${r.clip.name}: ${enc.stderr.slice(0, 600)}`);
      const clip = r.clip;
      clip.video = { webm: join(out, 'clips', `${values.label}-${clip.name}.webm`), seconds: r.encoder.seconds, droppedFrames: r.encoder.dropped, pathMs: totalMs(buildShots(manifest.showcase)) };
      const mp4 = toMp4(clip.video.webm, clip.video.webm.replace(/\.webm$/, '.mp4'));
      clip.video.mp4 = mp4.mp4;
      clip.video.mp4Reason = mp4.reason;
      clip.video.bytes = statSync(clip.video.webm).size;
      writeFileSync(join(out, 'clips', `${values.label}-${clip.name}.json`), `${JSON.stringify(clip, null, 1)}\n`);
      index.clips[clip.name] = { status: clip.status, json: join(out, 'clips', `${values.label}-${clip.name}.json`), webm: clip.video.webm, mp4: clip.video.mp4 };
      writeFileSync(indexPath, `${JSON.stringify(index, null, 1)}\n`);
      console.log(`[cinema ${clip.name}] ${clip.status}${clip.failure ? `: ${clip.failure.kind}: ${clip.failure.detail}` : ''} -> ${clip.video.webm} (${clip.video.seconds.toFixed(0)} s)`);
      // A remote host (the PC GPU job) hands its outputs back as marked stdout; huge-geometry-unpack.mjs rebuilds them.
      if (values['emit-stdout']) {
        const files = [clip.video.webm, join(out, 'clips', `${values.label}-${clip.name}.json`),
          ...readdirSync(join(out, 'stills')).filter((f) => f.startsWith(`${values.label}-${clip.name}-`)).map((f) => join(out, 'stills', f))];
        for (const f of files) {
          const mb = statSync(f).size / 2 ** 20;
          if (mb > emitMaxMb) { console.log(`[cinema] not emitting ${f}: ${mb.toFixed(0)} MB > --emit-max-mb`); continue; }
          emitFile(f, f.slice(out.length + 1));
        }
      }
    }
  } finally { server?.close(); }
}

if (isMainEntry(import.meta.url)) {
  main().catch((err) => { console.error(`huge-geometry-cinema: ${err.stack ?? err}`); process.exit(1); });
}
