#!/usr/bin/env node
/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Record one progress video that walks up the huge-geometry ladder
 * (scripts/perf/huge-geometry.md): per tier, a title card, the load in the
 * real viewer (time-lapsed, the HUD shows real seconds), then the scripted
 * orbit / zoom / fly-through at real time, with a HUD of scenario, element
 * and triangle counts, load time, frame time and memory. A failing tier ends
 * its scenario with a verdict card naming the symptom.
 *
 *   node scripts/perf/huge-geometry-record.mjs --label baseline --models-dir DIR --out DIR
 *        [--scenarios mixed] [--tiers 10k,100k,250k] [--frames 180] [--fps 20] [--timeout-min 20]
 *
 * Writes OUT/LABEL.webm, OUT/LABEL.mp4 (when gstreamer has openh264enc),
 * OUT/stills/LABEL-*.png and OUT/LABEL.json (per-tier numbers seen while
 * recording). Numbers measured with a screencast attached are diagnostic.
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { isMainEntry } from '../lib/is-main-entry.mjs';
import { generateScenario } from './huge-geometry-gen.mjs';
import { FAMILIES, tierLabel } from './huge-geometry-ladder.mjs';
import { ROOT, launchGpu, loadModel, startSampler } from './huge-geometry-browser.mjs';
import { cameraPaths, settledMemory } from './huge-geometry-measure.mjs';
import { parseTier } from './huge-geometry-run.mjs';
import { HUD_INSTALL, HUD_UPDATE, attachScreencast, cardHtml, startEncoder, toMp4 } from './huge-geometry-video.mjs';
import { startViewerServer } from './viewer-load-probe.mjs';

const gb = (mib) => (Number.isFinite(mib) && mib > 0 ? (mib >= 1024 ? `${(mib / 1024).toFixed(2)} GB` : `${Math.round(mib)} MB`) : '–');
const fmt = (n) => (Number.isFinite(n) ? n.toLocaleString('en-US') : '–');
const mtris = (n) => (Number.isFinite(n) && n > 0 ? `${(n / 1e6).toFixed(2)} M` : '–');

/** HUD lines for the current tier state. */
function hud(t) {
  const m = t.mem ?? {};
  return [
    `${t.scenario} · tier ${t.tier} · ${fmt(t.elements)} elements · ${t.models} model${t.models > 1 ? 's' : ''} · ${t.layout}`,
    `triangles: ${t.triangles ? mtris(t.triangles) : `≥ ${mtris(t.knownTriangles)} (generator)`} · file ${gb(t.fileMiB)}`,
    t.loadLine,
    `memory: JS heap ${gb(m.jsHeapMiB)} · renderer ${gb(m.rendererPssMiB)} · GPU proc ${gb(m.gpuPssMiB)} · VRAM ${gb(m.vramMiB)}`,
    ...(t.extra ?? []),
    `ladder: ${t.ladder}`,
  ];
}

async function recordTier({ encoder, baseUrl, manifest, frames, timeoutMs, label, stills, ladder }) {
  const s = manifest.scenario;
  const t = { scenario: s.scenario, tier: tierLabel(s.nominal), elements: manifest.totals.elements, models: s.models, layout: s.layout,
    knownTriangles: manifest.totals.trianglesKnown, triangles: manifest.totals.triangles, fileMiB: manifest.totals.bytes / 2 ** 20, ladder,
    loadLine: 'loading…', mem: null, extra: [] };
  const out = { name: s.name, status: 'failed' };
  encoder.pause();
  const session = await launchGpu();
  const stop = await attachScreencast(session.context, session.page, encoder);
  const cdp = await session.context.newCDPSession(session.page);
  await cdp.send('Performance.enable');
  const sampler = startSampler(session.profileDir, cdp);
  let state = { head: `${label} · ${s.name}`, lines: hud(t), tone: 'neutral', path: '' };
  const paint = () => session.page.evaluate(HUD_UPDATE, state).catch(() => null);
  let ticker = null;
  try {
    await session.page.setContent(cardHtml({ title: `${s.scenario} · ${t.tier}`, lines: [FAMILIES[s.scenario].about,
      `${fmt(t.elements)} elements in ${s.models} model(s), ${s.layout} layout, file ${gb(t.fileMiB)}`, `label: ${label}`] }));
    encoder.realtime();
    await session.page.waitForTimeout(400);
    await encoder.hold(2.5);
    const started = Date.now();
    encoder.timelapse(200); // 20 fps output: load plays at 4x
    ticker = setInterval(() => {
      t.mem = sampler.peek();
      if (!out.loaded) t.loadLine = `loading… ${((Date.now() - started) / 1000).toFixed(1)} s (video plays the load at 4× speed)`;
      state = { ...state, lines: hud(t) };
      void session.page.evaluate(HUD_INSTALL).then(paint).catch(() => null);
    }, 500);
    const load = await loadModel(session, baseUrl, manifest.files, { timeoutMs });
    out.load = { ok: load.ok, timings: load.ok ? { firstFrameMs: load.timings.firstFrameMs, interactiveMs: load.timings.interactiveMs } : null, failure: load.failure ?? null };
    if (!load.ok) {
      clearInterval(ticker); ticker = null;
      t.loadLine = `FAILED after ${(load.wallMs / 1000).toFixed(1)} s: ${load.failure.kind}`;
      t.extra = [load.failure.detail.slice(0, 160)];
      state = { head: `${label} · ${s.name} · FAILED (${load.failure.kind})`, lines: hud(t), tone: 'bad', path: '' };
      await session.page.evaluate(HUD_INSTALL).then(paint).catch(() => null);
      encoder.realtime();
      await session.page.waitForTimeout(1500);
      await session.page.screenshot({ path: join(stills, `${label}-${s.name}-failed.png`), timeout: 15000 }).catch(() => null);
      out.failure = load.failure;
      return out;
    }
    out.loaded = true;
    const tm = load.timings;
    t.loadLine = `load: complete ${(tm.interactiveMs / 1000).toFixed(1)} s · first frame ${tm.firstFrameMs === null ? '–' : `${(tm.firstFrameMs / 1000).toFixed(1)} s`}`;
    encoder.realtime();
    const mem = await settledMemory(session.page, cdp, sampler, [], { skipGc: true });
    t.triangles = mem.scene?.triangles ?? t.triangles;
    out.memory = { scene: mem.scene, settled: mem.settled };
    state = { ...state, lines: hud(t), tone: 'good' };
    await session.page.evaluate(HUD_INSTALL).then(paint);
    await session.page.screenshot({ path: join(stills, `${label}-${s.name}-loaded.png`), timeout: 15000 }).catch(() => null);
    const camErrors = [];
    out.camera = await cameraPaths(session.page, frames, camErrors, { onPath: (k) => { state = { ...state, path: k, head: `${label} · ${s.name} · ${k}` }; } });
    t.extra = Object.entries(out.camera).filter(([, v]) => v).map(([k, v]) => `${k}: frame median ${v.frameMs.median} ms · p95 ${v.frameMs.p95} · p99 ${v.frameMs.p99} · worst ${v.frameMs.worst} · ${v.drawsPerFrame.median} draws`);
    if (camErrors.length) t.extra.push(...camErrors.map((e) => `${e.step}: ${e.error.slice(0, 120)}`));
    state = { head: `${label} · ${s.name} · done`, lines: hud(t), tone: camErrors.length ? 'bad' : 'good', path: '' };
    await paint();
    await session.page.waitForTimeout(2500);
    await session.page.screenshot({ path: join(stills, `${label}-${s.name}-summary.png`), timeout: 15000 }).catch(() => null);
    out.status = camErrors.length ? 'failed' : 'ok';
    if (camErrors.length) out.failure = { kind: 'interaction-error', detail: camErrors.map((e) => `${e.step}: ${e.error}`).join('; ') };
    return out;
  } catch (err) {
    out.status = 'error';
    out.failure = { kind: session.events.crashed ? 'renderer-crash' : 'harness-error', detail: String(err?.message ?? err).slice(0, 600) };
    return out;
  } finally {
    if (ticker) clearInterval(ticker);
    out.sampling = await sampler.stop().then((x) => x.peak).catch(() => null);
    encoder.pause();
    await stop();
    await session.close();
  }
}

/** A failure verdict card in a fresh browser (the failing tab may be dead), held for 5 s and saved as a still. */
async function verdictCard(encoder, stills, label, manifest, r) {
  const s = manifest.scenario;
  const session = await launchGpu();
  try {
    const stop = await attachScreencast(session.context, session.page, encoder);
    const t = r.load?.timings;
    await session.page.setContent(cardHtml({ tone: 'bad', title: `${s.scenario} · ${tierLabel(s.nominal)}: FAILED (${r.failure?.kind ?? 'unknown'})`, lines: [
      String(r.failure?.detail ?? '').slice(0, 220),
      t ? `loaded first: complete ${(t.interactiveMs / 1000).toFixed(1)} s, first frame ${t.firstFrameMs === null ? '–' : (t.firstFrameMs / 1000).toFixed(1)} s` : 'load did not complete',
      `peak: renderer ${gb(r.sampling?.rendererPssMiB)} · JS heap ${gb(r.sampling?.jsHeapMiB)} · VRAM ${gb(r.sampling?.vramMiB)}`,
      `${fmt(manifest.totals.elements)} elements · file ${gb(manifest.totals.bytes / 2 ** 20)} · label ${label}`] }));
    encoder.realtime();
    await session.page.waitForTimeout(500);
    await encoder.hold(5);
    await session.page.screenshot({ path: join(stills, `${label}-${s.name}-verdict.png`), timeout: 15000 }).catch(() => null);
    encoder.pause();
    await stop();
  } finally { await session.close(); }
}

async function main() {
  const { values } = parseArgs({ options: {
    label: { type: 'string' }, 'models-dir': { type: 'string' }, out: { type: 'string' }, scenarios: { type: 'string', default: 'mixed' },
    tiers: { type: 'string', default: '10k,100k,250k,500k,1M,2M' }, frames: { type: 'string', default: '180' }, fps: { type: 'string', default: '20' },
    'timeout-min': { type: 'string', default: '20' }, dist: { type: 'string', default: join(ROOT, 'apps/viewer/dist') },
  } });
  if (!values.label || !values['models-dir'] || !values.out || !/^[\w.-]+$/.test(values.label)) {
    console.error('usage: huge-geometry-record.mjs --label NAME --models-dir DIR --out DIR [--scenarios mixed] [--tiers 10k,100k] [--frames 180] [--fps 20] [--timeout-min 20]');
    process.exit(2);
  }
  const out = resolve(values.out), stills = join(out, 'stills');
  mkdirSync(stills, { recursive: true });
  const fps = Number(values.fps), webm = join(out, `${values.label}.webm`);
  const encoder = startEncoder(webm, { fps });
  let enc = null;
  const { server, baseUrl } = await startViewerServer(() => resolve(values.dist));
  const tiers = values.tiers.split(',').map(parseTier);
  const record = { label: values.label, tiers: [] };
  try {
    for (const scenario of values.scenarios.split(',')) {
      const marks = tiers.map((n) => `${tierLabel(n)} ·`);
      for (let i = 0; i < tiers.length; i++) {
        const manifest = generateScenario(resolve(values['models-dir']), { scenario, elements: tiers[i] });
        marks[i] = `[${tierLabel(tiers[i])}]`;
        const r = await recordTier({ encoder, baseUrl, manifest, frames: Number(values.frames), timeoutMs: Number(values['timeout-min']) * 60000,
          label: values.label, stills, ladder: marks.join(' ') });
        marks[i] = `${tierLabel(tiers[i])} ${r.status === 'ok' ? '✓' : '✗'}`;
        if (r.status !== 'ok') await verdictCard(encoder, stills, values.label, manifest, r);
        record.tiers.push({ ...r, videoSecond: encoder.seconds });
        console.log(`[record ${scenario} ${tierLabel(tiers[i])}] ${r.status}${r.failure ? `: ${r.failure.kind}: ${r.failure.detail}` : ''} (video at ${encoder.seconds.toFixed(0)} s)`);
        writeFileSync(join(out, `${values.label}.json`), `${JSON.stringify(record, null, 1)}\n`);
        if (r.status !== 'ok') break;
      }
    }
  } finally {
    server.close();
    enc = await encoder.close();
  }
  if (enc.code !== 0) throw new Error(`ffmpeg exited ${enc.code}: ${enc.stderr.slice(0, 600)}`);
  const mp4 = toMp4(webm, join(out, `${values.label}.mp4`));
  record.video = { webm, mp4: mp4.mp4, mp4Reason: mp4.reason, seconds: encoder.seconds, droppedFrames: encoder.dropped };
  writeFileSync(join(out, `${values.label}.json`), `${JSON.stringify(record, null, 1)}\n`);
  console.log(JSON.stringify(record.video));
}

if (isMainEntry(import.meta.url)) {
  main().catch((err) => { console.error(`huge-geometry-record: ${err.stack ?? err}`); process.exit(1); });
}
