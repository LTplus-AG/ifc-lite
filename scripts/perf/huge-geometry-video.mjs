/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Video plumbing of the huge-geometry recorder (huge-geometry-record.mjs):
 *
 * - `startEncoder`: one long-lived ffmpeg (Playwright's bundled build: mjpeg
 *   in, VP9 WebM out) fed at a constant output rate from whatever tab is
 *   currently attached, so one file spans many fresh browser processes.
 *   `realtime` writes every 1/fps s; `timelapse(ms)` writes one frame per
 *   `ms` of wall time (a long load plays faster, and the HUD says so).
 * - `attachScreencast`: CDP Page.startScreencast on a page; the latest JPEG
 *   is what the encoder writes.
 * - `HUD_*`: an overlay drawn into the page DOM, so it is burned into the
 *   screencast. It never covers the ViewCube corner.
 * - `toMp4`: gstreamer transcode (vp9dec, openh264enc, mp4mux) when present.
 */

import { spawn, spawnSync } from 'node:child_process';
import { existsSync, readdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { withTimeout } from './oom-load-probe-lib.mjs';

/** Playwright's bundled ffmpeg (PLAYWRIGHT_BROWSERS_PATH or ~/.cache/ms-playwright), newest first. */
export function playwrightFfmpeg() {
  const base = process.env.PLAYWRIGHT_BROWSERS_PATH || join(homedir(), '.cache/ms-playwright');
  if (!existsSync(base)) return null;
  const dirs = readdirSync(base).filter((d) => /^ffmpeg-\d+$/.test(d)).sort((a, b) => Number(b.split('-')[1]) - Number(a.split('-')[1]));
  for (const d of dirs) { const f = join(base, d, 'ffmpeg-linux'); if (existsSync(f)) return f; }
  return null;
}

export function startEncoder(out, { fps = 20, width = 1600, height = 900, gop = null } = {}) {
  const ffmpeg = playwrightFfmpeg();
  if (!ffmpeg) throw new Error('Playwright ffmpeg not found: run `pnpm exec playwright install ffmpeg`');
  const proc = spawn(ffmpeg, ['-loglevel', 'error', '-f', 'image2pipe', '-c:v', 'mjpeg', '-framerate', String(fps), '-i', 'pipe:0', '-y', '-an',
    '-vf', `scale=${width}:${height}:force_original_aspect_ratio=decrease,pad=${width}:${height}:(ow-iw)/2:(oh-ih)/2`,
    '-c:v', 'libvpx-vp9', '-b:v', '3M', '-deadline', 'realtime', '-cpu-used', '8', '-row-mt', '1', '-threads', '4', ...(gop ? ['-g', String(gop)] : []), '-r', String(fps), out],
  { stdio: ['pipe', 'ignore', 'pipe'] });
  let stderr = '';
  proc.stderr.on('data', (d) => { stderr += d; });
  const done = new Promise((resolve) => proc.on('close', (code) => resolve({ code, stderr })));
  // ffmpeg can die early (bad arguments, disk full): stop writing instead of crashing on EPIPE or waiting on 'drain' forever.
  let pipeError = null;
  proc.stdin.on('error', (err) => { pipeError ??= err; });
  // A failed spawn (ENOENT, EACCES) emits 'error' and may never emit 'close'.
  const spawnFailed = new Promise((resolve) => proc.on('error', (err) => { pipeError ??= err; resolve({ code: -1, stderr: String(err?.message ?? err) }); }));
  proc.on('close', (code) => { pipeError ??= new Error(`ffmpeg exited ${code}: ${stderr.slice(0, 300)}`); });
  const writable = () => !pipeError && !proc.stdin.destroyed;
  const drained = () => new Promise((r) => { const go = () => { proc.stdin.off('drain', go); proc.off('close', go); r(); }; proc.stdin.once('drain', go); proc.once('close', go); });
  // Drift-free: frames owed are counted from an anchor, so the output keeps wall-clock time
  // (a timer that re-arms itself drifts late and makes the video play faster than real time).
  let latest = null, periodMs = 1000 / fps, timer = null, written = 0, paused = true, anchor = Date.now(), emitted = 0, dropped = 0;
  const restart = () => { anchor = Date.now(); emitted = 0; };
  const tick = () => {
    timer = setTimeout(tick, Math.min(periodMs, 8));
    if (paused || !latest || !writable()) return;
    const due = Math.floor((Date.now() - anchor) / periodMs);
    if (due - emitted > fps * 2) emitted = due - 1; // a stalled event loop: skip ahead instead of bursting
    // ffmpeg is behind: drop these frames rather than queue JPEGs in memory without bound.
    if (proc.stdin.writableNeedDrain) { dropped += due - emitted; emitted = due; return; }
    while (emitted < due) { proc.stdin.write(latest); written++; emitted++; }
  };
  tick();
  return {
    frame(jpeg) { latest = jpeg; },
    realtime() { periodMs = 1000 / fps; paused = false; restart(); },
    timelapse(ms) { periodMs = ms; paused = false; restart(); },
    pause() { paused = true; },
    /** Resolve once a screencast frame has arrived (or after `ms`). */
    async waitFrame(ms = 5000) { const end = Date.now() + ms; while (!latest && Date.now() < end) await new Promise((r) => setTimeout(r, 20)); return Boolean(latest); },
    /** Write `seconds` of the current frame now (title and verdict cards). */
    async hold(seconds) {
      const was = paused; paused = true;
      for (let i = 0; i < Math.round(seconds * fps) && latest && writable(); i++) {
        written++;
        if (!proc.stdin.write(latest)) await drained();
      }
      await new Promise((r) => setTimeout(r, 50));
      restart();
      paused = was;
    },
    /** Offline use (no timer, keep paused): write `jpeg` as the next `n` frames, waiting for the pipe to drain. */
    async write(jpeg, n = 1) {
      for (let i = 0; i < n; i++) {
        if (!writable()) throw pipeError ?? new Error('ffmpeg input closed');
        written++;
        if (!proc.stdin.write(jpeg)) await drained();
      }
    },
    get seconds() { return written / fps; },
    /** Live frames dropped because ffmpeg fell behind. */
    get dropped() { return dropped; },
    async close() { clearTimeout(timer); proc.stdin.end(); return Promise.race([done, spawnFailed]); },
  };
}

/** Start a CDP screencast of `page`, forwarding every JPEG to `encoder.frame`. Returns a stop function. */
export async function attachScreencast(context, page, encoder, { width = 1600, height = 900 } = {}) {
  const cdp = await context.newCDPSession(page);
  cdp.on('Page.screencastFrame', (f) => {
    encoder.frame(Buffer.from(f.data, 'base64'));
    cdp.send('Page.screencastFrameAck', { sessionId: f.sessionId }).catch(() => null);
  });
  await cdp.send('Page.startScreencast', { format: 'jpeg', quality: 80, maxWidth: width, maxHeight: height, everyNthFrame: 1 });
  // Bounded: on a crashed target these CDP calls never settle.
  const within = (p) => withTimeout(p.catch(() => null), 5000, () => null);
  return async () => { await within(cdp.send('Page.stopScreencast')); await within(cdp.detach()); };
}

/** A title/verdict card as a full page. */
export function cardHtml({ title, lines = [], tone = 'neutral' }) {
  const esc = (s) => String(s).replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' })[c]);
  const accent = tone === 'bad' ? '#ff6b6b' : tone === 'good' ? '#69db7c' : '#74c0fc';
  return `<!doctype html><html><body style="margin:0;background:#101418;color:#e9ecef;font:22px/1.5 ui-monospace,Menlo,monospace;display:flex;align-items:center;justify-content:center;height:100vh">
<div style="max-width:1300px"><div style="font-size:40px;color:${accent};margin-bottom:24px">${esc(title)}</div>${lines.map((l) => `<div>${esc(l)}</div>`).join('')}</div></body></html>`;
}

/** In page: create the HUD element once. */
export const HUD_INSTALL = () => {
  if (document.getElementById('hg-hud')) return;
  const el = document.createElement('div');
  el.id = 'hg-hud';
  el.style.cssText = 'position:fixed;left:286px;top:92px;z-index:2147483647;pointer-events:none;background:rgba(16,20,24,.86);color:#e9ecef;'
    + 'font:13px/1.45 ui-monospace,Menlo,monospace;padding:10px 12px;border-radius:6px;white-space:pre;box-shadow:0 2px 10px rgba(0,0,0,.35)';
  document.body.appendChild(el);
  // The first-visit privacy notice would cover the viewport for the whole clip; hide it in the recording only.
  const hideNotice = () => {
    for (const n of document.querySelectorAll('[data-sonner-toast]')) if (/stores an action log/i.test(n.textContent ?? '')) n.style.display = 'none';
  };
  hideNotice();
  new MutationObserver(hideNotice).observe(document.body, { childList: true, subtree: true });
};

/**
 * In page: render the HUD from `state` (set by the recorder). While a camera
 * path records, the live frame-time line comes from the harness probe.
 */
export const HUD_UPDATE = (state) => {
  const el = document.getElementById('hg-hud');
  if (!el) return;
  const p = globalThis.__hgProbe;
  let live = '';
  if (p?.recording && p.frames.length > 2) {
    const d = [];
    for (let i = 1; i < p.frames.length; i++) d.push(p.frames[i].ts - p.frames[i - 1].ts);
    d.sort((a, b) => a - b);
    const q = (x) => d[Math.min(d.length - 1, Math.ceil(x * d.length) - 1)].toFixed(1);
    const last = p.frames.at(-1);
    live = `\nlive ${state.path}: median ${q(0.5)} ms · p95 ${q(0.95)} ms · worst ${d.at(-1).toFixed(0)} ms\n     draws ${last.draws} · tris/frame ${(last.tris / 1e6).toFixed(2)} M`;
  }
  const colour = state.tone === 'bad' ? '#ff8787' : state.tone === 'good' ? '#8ce99a' : '#a5d8ff';
  el.innerHTML = '';
  const head = document.createElement('div');
  head.style.cssText = `color:${colour};font-weight:600`;
  head.textContent = state.head;
  const body = document.createElement('div');
  body.textContent = state.lines.join('\n') + live;
  el.append(head, body);
};

/** Transcode WebM to H.264 MP4 with gstreamer; returns the mp4 path or null with a reason. */
export function toMp4(webm, mp4) {
  const probe = spawnSync('gst-inspect-1.0', ['openh264enc'], { stdio: 'ignore' });
  if (probe.status !== 0) return { mp4: null, reason: 'gstreamer openh264enc not available' };
  const r = spawnSync('gst-launch-1.0', ['-q', 'filesrc', `location=${webm}`, '!', 'matroskademux', '!', 'vp9dec', '!', 'videoconvert', '!',
    'openh264enc', 'bitrate=6000000', 'complexity=high', '!', 'h264parse', '!', 'mp4mux', '!', 'filesink', `location=${mp4}`], { encoding: 'utf8' });
  return r.status === 0 && existsSync(mp4) ? { mp4, reason: null } : { mp4: null, reason: (r.stderr || r.stdout || `exit ${r.status}`).slice(0, 600) };
}
