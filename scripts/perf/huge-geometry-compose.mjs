#!/usr/bin/env node
/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Compose clips from the cinematic recorder (huge-geometry-cinema.mjs) into
 * one video:
 *
 *   side by side   --pair BEFORE.json,AFTER.json (repeatable): two clips of the
 *                  same showcase tier recorded on the same camera path, in one
 *                  1920x1080 frame with labels, the shot's numbers under each
 *                  pane, a title card, and a verdict card with the headline
 *                  numbers per pair. Loads play side by side from their own
 *                  start (the faster one holds its last frame with a badge),
 *                  then the camera paths play in lock-step by shot timeline.
 *   reel           --clip A.json (repeatable): clips one after the other with
 *                  the title card and a closing card.
 *
 *   node scripts/perf/huge-geometry-compose.mjs --out FILE.webm --title "..." \
 *        [--pair before.json,after.json ...] [--clip a.json ...] [--before-label main] [--after-label branch] [--verdict "..."] [--fps 30]
 *
 * Playwright's bundled ffmpeg has no stacking or text filters, so composing
 * runs in a headless browser: both clips are <video> elements seeked frame by
 * frame, the page is screenshotted, and the frames are piped into the same
 * encoder the recorder uses (mjpeg in, VP9 out; MP4 via gstreamer when present).
 * No GPU needed. Every number on screen is diagnostic, and the cards say so.
 */

import { copyFileSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { isMainEntry } from '../lib/is-main-entry.mjs';
import { loadPlaywright } from './huge-geometry-browser.mjs';
import { startEncoder, toMp4 } from './huge-geometry-video.mjs';

const W = 1920, H = 1080;
const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
const med = (xs) => { const v = xs.filter(Number.isFinite).sort((a, b) => a - b); return v.length ? v[Math.floor(v.length / 2)] : null; };
const gb = (mib) => (Number.isFinite(mib) && mib > 0 ? (mib >= 1024 ? `${(mib / 1024).toFixed(2)} GB` : `${Math.round(mib)} MB`) : '–');

/** Headline numbers of one clip: load, path frame times (median over shots), draws, peak memory. */
export function headline(clip) {
  const shots = (clip.shots ?? []).filter((s) => s.frames);
  return {
    ok: clip.status === 'ok', status: clip.status, failure: clip.failure?.kind ?? null,
    loadS: clip.load?.timings ? clip.load.timings.interactiveMs / 1000 : null,
    firstFrameS: clip.load?.timings?.firstFrameMs != null ? clip.load.timings.firstFrameMs / 1000 : null,
    frameMedianMs: med(shots.map((s) => s.frames.frameMs.median)), frameP95Ms: med(shots.map((s) => s.frames.frameMs.p95)),
    draws: med(shots.map((s) => s.frames.drawsPerFrame.median)),
    tabMiB: clip.peak?.rendererPssMiB ?? null, vramMiB: clip.peak?.vramMiB ?? null,
  };
}

/** One-line comparison of two headlines (after relative to before); only states what both clips measured. */
export function verdictLines(b, a) {
  if (!b.ok && !a.ok) return [`both failed: before ${b.failure ?? b.status}, after ${a.failure ?? a.status}`];
  if (!a.ok) return [`after FAILED (${a.failure ?? a.status}); before loaded in ${b.loadS?.toFixed(1)} s`];
  if (!b.ok) return [`before FAILED (${b.failure ?? b.status}); after loads in ${a.loadS?.toFixed(1)} s and runs the full path`];
  const ratio = (x, y, what, unit, digits = 1) => {
    if (!Number.isFinite(x) || !Number.isFinite(y) || x <= 0 || y <= 0) return null;
    const r = x / y;
    const dir = r >= 1.05 ? `${r.toFixed(2)}× lower` : r <= 0.95 ? `${(1 / r).toFixed(2)}× higher` : 'about the same';
    return `${what}: ${x.toFixed(digits)} → ${y.toFixed(digits)} ${unit} (${dir})`;
  };
  return [ratio(b.loadS, a.loadS, 'load', 's'), ratio(b.frameMedianMs, a.frameMedianMs, 'frame median', 'ms'),
    ratio(b.frameP95Ms, a.frameP95Ms, 'frame p95', 'ms'), ratio(b.draws, a.draws, 'draws/frame', '', 0),
    ratio(b.tabMiB / 1024, a.tabMiB / 1024, 'peak tab memory', 'GB', 2)].filter(Boolean);
}

/**
 * Timeline of a side-by-side pair: an array of segments, each mapping output
 * time to a source time per clip (null source = hold that clip's last frame).
 */
export function pairTimeline(b, a) {
  const seg = [];
  // A clip that errored before or during its load has no load span: hold its last title-card frame.
  const loadOf = (c) => { const h = Math.max(0, (c.timeline.title?.[1] ?? 0.04) - 0.04); return c.timeline.load ?? [h, h + 0.04]; };
  const lb = loadOf(b), la = loadOf(a);
  const loadLen = Math.max(lb[1] - lb[0], la[1] - la[0]);
  seg.push({ kind: 'load', length: loadLen, src: [(t) => Math.min(lb[0] + t, lb[1] - 0.04), (t) => Math.min(la[0] + t, la[1] - 0.04)],
    done: [(t) => t >= lb[1] - lb[0], (t) => t >= la[1] - la[0]] });
  const pb = b.timeline.path, pa = a.timeline.path;
  if (pb || pa) {
    // Shots line up by name: each shot's output length is the longer of the two recordings of it.
    const names = (b.shots.length >= a.shots.length ? b.shots : a.shots).map((s) => s.name);
    for (const name of names) {
      const sb = b.shots.find((s) => s.name === name), sa = a.shots.find((s) => s.name === name);
      const len = Math.max(sb ? sb.end - sb.start : 0, sa ? sa.end - sa.start : 0);
      const at = (s, fallback) => (s ? (t) => Math.min(s.start + t, s.end - 0.04) : () => fallback);
      seg.push({ kind: 'shot', name, caption: (sb ?? sa).caption, length: len, shots: [sb, sa],
        src: [at(sb, lb[1] - 0.04), at(sa, la[1] - 0.04)] });
    }
  }
  return seg;
}

const PAGE = `<!doctype html><html><head><style>
body{margin:0;width:${W}px;height:${H}px;background:#0b0f14;color:#e9ecef;font-family:system-ui,-apple-system,Segoe UI,sans-serif;overflow:hidden}
#stage{position:absolute;inset:0}
.pane{position:absolute;top:96px;width:944px;height:531px;background:#000;border-radius:10px;overflow:hidden;box-shadow:0 6px 30px rgba(0,0,0,.5)}
.pane video{width:100%;height:100%;object-fit:contain;display:block}
#pb{left:16px}#pa{left:960px}
.lab{position:absolute;top:30px;width:944px;font:700 30px/1.2 system-ui;letter-spacing:.3px}
#lb{left:16px;color:#74c0fc}#la{left:960px;color:#8ce99a}
.sub{font:500 15px/1.3 ui-monospace,Menlo,monospace;color:#9aa4ae;margin-top:4px}
.num{position:absolute;top:648px;width:944px;font:19px/1.6 ui-monospace,Menlo,monospace;white-space:pre;color:#ced4da}
#nb{left:16px}#na{left:960px}
.badge{position:absolute;right:14px;top:14px;padding:6px 14px;border-radius:999px;font:700 18px system-ui;display:none}
#cap{position:absolute;left:0;right:0;top:820px;text-align:center;font:600 32px system-ui}
#foot{position:absolute;left:0;right:0;bottom:22px;text-align:center;font:14px ui-monospace,Menlo,monospace;color:#868e96}
#card{position:absolute;inset:0;background:#0b0f14;display:none;align-items:center;justify-content:center}
#card .in{max-width:1500px}#card h1{font:700 52px/1.2 system-ui;margin:0 0 28px;color:#ffd43b}#card div.l{font:24px/1.6 ui-monospace,Menlo,monospace}
#solo{position:absolute;left:160px;top:60px;width:1600px;height:900px;display:none}
</style></head><body><div id="stage">
<div class="lab" id="lb"></div><div class="lab" id="la"></div>
<div class="pane" id="pb"><video id="vb" muted preload="auto"></video><div class="badge" id="bb"></div></div>
<div class="pane" id="pa"><video id="va" muted preload="auto"></video><div class="badge" id="ba"></div></div>
<div class="num" id="nb"></div><div class="num" id="na"></div>
<div id="cap"></div><div id="foot">showcase scene (footage only, not a measurement family) · all timings diagnostic, not evidence</div>
<video id="solo" muted preload="auto"></video>
<div id="card"><div class="in"><h1 id="ct"></h1><div id="cl"></div></div></div></div></body></html>`;

/** In page: set sources. */
const SET_SOURCES = async ({ b, a, solo }) => {
  const load = (v, src) => new Promise((resolve, reject) => {
    if (!src) { v.removeAttribute('src'); resolve(); return; }
    v.onloadeddata = () => resolve(); v.onerror = () => reject(new Error(`cannot load ${src}`)); v.src = src; v.load();
  });
  await Promise.all([load(document.getElementById('vb'), b), load(document.getElementById('va'), a), load(document.getElementById('solo'), solo)]);
};

/** In page: show one frame (card, solo or pair), seeking videos to exact times. */
const SHOW = async (f) => {
  const $ = (id) => document.getElementById(id);
  const seek = (v, t) => new Promise((resolve) => {
    if (t === null || t === undefined || !v.src) { resolve(); return; }
    const target = Math.max(0, Math.min(t, (v.duration || t) - 0.001));
    if (Math.abs(v.currentTime - target) < 0.0005) { resolve(); return; }
    v.addEventListener('seeked', () => resolve(), { once: true });
    v.currentTime = target;
  });
  $('card').style.display = f.card ? 'flex' : 'none';
  if (f.card) {
    $('ct').textContent = f.card.title;
    $('cl').replaceChildren(...f.card.lines.map((l) => { const d = document.createElement('div'); d.className = 'l'; d.textContent = l; return d; }));
    $('ct').style.color = f.card.tone === 'bad' ? '#ff8787' : f.card.tone === 'good' ? '#8ce99a' : '#ffd43b';
    return;
  }
  const pair = !f.solo;
  for (const id of ['lb', 'la', 'pb', 'pa', 'nb', 'na']) $(id).style.display = pair ? '' : 'none';
  $('solo').style.display = pair ? 'none' : 'block';
  if (pair) {
    $('lb').innerHTML = f.labels[0]; $('la').innerHTML = f.labels[1];
    $('nb').textContent = f.nums[0]; $('na').textContent = f.nums[1];
    for (const [k, badge] of [['bb', f.badges[0]], ['ba', f.badges[1]]]) {
      $(k).style.display = badge ? 'block' : 'none';
      if (badge) { $(k).textContent = badge.text; $(k).style.background = badge.tone === 'bad' ? '#c92a2a' : '#2b8a3e'; }
    }
    await Promise.all([seek($('vb'), f.t[0]), seek($('va'), f.t[1])]);
  } else await seek($('solo'), f.t[0]);
  $('cap').textContent = f.caption ?? '';
  $('cap').style.top = pair ? '820px' : '985px';
};

const shotNums = (s, clip) => {
  if (!s) return clip.status === 'ok' ? '' : `FAILED: ${clip.failure?.kind ?? clip.status}`;
  if (!s.frames) return `${s.name}: ${s.error ?? 'no frames'}`;
  const f = s.frames;
  return `${s.name}: frame median ${f.frameMs.median} ms · p95 ${f.frameMs.p95} ms · worst ${Math.round(f.frameMs.worst)} ms\n`
    + `${f.drawsPerFrame.median} draws · ${(f.trianglesPerFrame.median / 1e6).toFixed(2)} M tris/frame${s.pick ? ` · picked #${s.pick.selected?.id ?? '–'}` : ''}${s.beatError ? `\nbeat FAILED: ${s.beatError.slice(0, 70)}` : ''}`;
};

async function main() {
  const { values } = parseArgs({ options: {
    out: { type: 'string' }, title: { type: 'string', default: 'huge-geometry showcase' }, pair: { type: 'string', multiple: true, default: [] },
    clip: { type: 'string', multiple: true, default: [] }, 'before-label': { type: 'string', default: 'before' }, 'after-label': { type: 'string', default: 'after' },
    verdict: { type: 'string' }, fps: { type: 'string', default: '30' }, subtitle: { type: 'string', default: '' },
  } });
  if (!values.out?.endsWith('.webm') || (!values.pair.length && !values.clip.length)) {
    console.error('usage: huge-geometry-compose.mjs --out FILE.webm [--title T] [--pair before.json,after.json ...] [--clip a.json ...] '
      + '[--before-label L] [--after-label L] [--verdict TEXT] [--fps 30]');
    process.exit(2);
  }
  const fps = Number(values.fps), dt = 1 / fps;
  const read = (p) => {
    const clip = { ...JSON.parse(readFileSync(resolve(p), 'utf8')), jsonPath: resolve(p) };
    // A clip recorded on another host (unpacked from its log) carries that host's path: use the webm next to the JSON.
    if (!existsSync(clip.video.webm)) clip.video = { ...clip.video, webm: join(dirname(resolve(p)), basename(clip.video.webm)) };
    return clip;
  };
  const work = mkdtempSync(join(tmpdir(), 'hg-compose-'));
  const local = (clip, k) => { const f = `${k}-${basename(clip.video.webm)}`; copyFileSync(clip.video.webm, join(work, f)); return f; };
  writeFileSync(join(work, 'index.html'), PAGE);
  const { chromium } = loadPlaywright();
  const browser = await chromium.launch({ headless: true, args: ['--autoplay-policy=no-user-gesture-required'] });
  const page = await browser.newPage({ viewport: { width: W, height: H } });
  await page.goto(pathToFileURL(join(work, 'index.html')).href);
  const encoder = startEncoder(resolve(values.out), { fps, width: W, height: H, gop: 60 });
  let frames = 0;
  const shoot = async (f, n = 1) => {
    await page.evaluate(SHOW, f);
    const jpeg = await page.screenshot({ type: 'jpeg', quality: 88 });
    await encoder.write(jpeg, n);
    frames += n;
  };
  const card = (title, lines, seconds, tone) => shoot({ card: { title, lines, tone } }, Math.round(seconds * fps));
  const summary = [];
  try {
    const pairs = values.pair.map((p) => p.split(',').map(read));
    const clips = values.clip.map(read);
    await card(values.title, [values.subtitle, ...pairs.map(([b]) => `${b.name}: ${values['before-label']} vs ${values['after-label']} on the same camera path`),
      ...clips.map((c) => `${c.label} · ${c.name}: ${c.status === 'ok' ? 'runs the full path' : `FAILED (${c.failure?.kind ?? c.status})`}`),
      'showcase scene: footage only, not a measurement family', 'all timings diagnostic, not evidence'].filter(Boolean), 4);
    for (const [b, a] of pairs) {
      await page.evaluate(SET_SOURCES, { b: local(b, 'b'), a: local(a, 'a'), solo: null });
      const label = (txt, clip) => `${esc(txt)}<div class="sub">${esc(clip.label)} · ${esc(clip.name)} · ${esc((clip.url ?? '').replace(/^https?:\/\/[^/]+/, ''))}</div>`;
      const labels = [label(values['before-label'], b), label(values['after-label'], a)];
      const hb = headline(b), ha = headline(a);
      await card(`${b.name.replace(/^showcase-/, 'showcase ')}: ${values['before-label']} vs ${values['after-label']}`,
        [`${b.elements.toLocaleString('en-US')} elements · ${b.buildings} buildings · ${b.styles} styles · same seed, same camera path`,
          `${values['before-label']}: ${b.label}  ·  ${values['after-label']}: ${a.label}`], 3);
      for (const seg of pairTimeline(b, a)) {
        const n = Math.max(1, Math.round(seg.length * fps));
        for (let i = 0; i < n; i++) {
          const t = i * dt;
          if (seg.kind === 'load') {
            const done = seg.done.map((d) => d(t));
            const badge = (clip, d) => (d ? (clip.load?.ok ? { text: `loaded ${(clip.load.timings.interactiveMs / 1000).toFixed(1)} s`, tone: 'good' } : { text: `FAILED: ${clip.failure?.kind ?? 'load'}`, tone: 'bad' }) : null);
            await shoot({ labels, t: seg.src.map((f) => f(t)), badges: [badge(b, done[0]), badge(a, done[1])],
              nums: [b, a].map((c) => `load (video ${c.loadSpeed}× speed)`), caption: 'loading the showcase city' });
          } else {
            const [sb, sa] = seg.shots;
            await shoot({ labels, t: seg.src.map((f) => f(t)), badges: [b.status === 'ok' || sb ? null : { text: 'FAILED', tone: 'bad' }, a.status === 'ok' || sa ? null : { text: 'FAILED', tone: 'bad' }],
              nums: [shotNums(sb, b), shotNums(sa, a)], caption: seg.caption });
          }
        }
      }
      const lines = values.verdict ? [values.verdict, ...verdictLines(hb, ha)] : verdictLines(hb, ha);
      summary.push({ name: b.name, before: hb, after: ha, lines });
      await card(`${b.name.replace(/^showcase-/, 'showcase ')} verdict`, [...lines,
        `${values['before-label']}: load ${hb.loadS?.toFixed(1) ?? '–'} s · frame ${hb.frameMedianMs ?? '–'} / p95 ${hb.frameP95Ms ?? '–'} ms · ${hb.draws ?? '–'} draws · tab ${gb(hb.tabMiB)} · VRAM ${gb(hb.vramMiB)}`,
        `${values['after-label']}: load ${ha.loadS?.toFixed(1) ?? '–'} s · frame ${ha.frameMedianMs ?? '–'} / p95 ${ha.frameP95Ms ?? '–'} ms · ${ha.draws ?? '–'} draws · tab ${gb(ha.tabMiB)} · VRAM ${gb(ha.vramMiB)}`,
        'diagnostic timings (screencast attached, shared GPU), not evidence'], 6, ha.ok ? 'good' : 'bad');
    }
    for (const c of clips) {
      await page.evaluate(SET_SOURCES, { b: null, a: null, solo: local(c, 'c') });
      const total = c.video.seconds;
      const n = Math.round(total * fps);
      for (let i = 0; i < n; i++) await shoot({ solo: true, t: [i * dt], caption: '' });
      summary.push({ name: c.name, clip: headline(c) });
    }
    await card('end', [...summary.map((s) => (s.lines ? `${s.name}: ${s.lines[0] ?? ''}` : `${s.name}: ${s.clip.ok ? `load ${s.clip.loadS?.toFixed(1)} s · frame median ${s.clip.frameMedianMs} ms · ${s.clip.draws} draws` : `FAILED (${s.clip.failure ?? s.clip.status})`}`)),
      'showcase scene: footage only · timings diagnostic, not evidence'], 3);
  } finally {
    await browser.close();
    const enc = await encoder.close();
    if (enc.code !== 0) console.error(`ffmpeg exited ${enc.code}: ${enc.stderr.slice(0, 600)}`);
    rmSync(work, { recursive: true, force: true });
  }
  const mp4 = toMp4(resolve(values.out), resolve(values.out).replace(/\.webm$/, '.mp4'));
  const result = { out: resolve(values.out), mp4: mp4.mp4, mp4Reason: mp4.reason, seconds: frames / fps, summary };
  writeFileSync(resolve(values.out).replace(/\.webm$/, '.json'), `${JSON.stringify(result, null, 1)}\n`);
  console.log(JSON.stringify({ out: result.out, mp4: result.mp4, seconds: result.seconds }));
}

if (isMainEntry(import.meta.url)) {
  main().catch((err) => { console.error(`huge-geometry-compose: ${err.stack ?? err}`); process.exit(1); });
}
