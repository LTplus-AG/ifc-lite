#!/usr/bin/env node
/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * CPU time (thread time, not wall time) of one browser load, read from a Chrome trace.
 *
 * Wall-clock load times on a shared machine move with whatever else runs; the CPU a load's own threads
 * spent moves much less. This reads the `tdur` (thread duration) Chrome records on its top-level task events
 * (category `toplevel`) and sums it per thread over the load's window: from the file input event to the
 * interactive mark. A task that straddles a window edge is counted by the share of its wall time inside.
 *
 * Window: the scoreboard writes two User Timing marks into the page when a sample ends, `scoreboard:input` and
 * `scoreboard:interactive` (startTime = page clock). A mark's trace event carries both clocks (ts and
 * args.data.startTime), which aligns the page clock with the trace clock. A trace without those marks can
 * still be read with an explicit window (page clock ms) as long as it holds any other User Timing mark.
 *
 * Threads are grouped by role: the renderer that holds the marks (main thread, dedicated workers, other
 * renderer threads), the GPU process, the browser process, and other renderers.
 *
 * Stages: given the viewer's in-page span trace (`?perfTrace=1`, the scoreboard's traces/<cell>.json), each
 * main-thread span name gets the main thread's CPU inside the union of its intervals; and the two spans that
 * frame worker work on the main thread (`parser.worker`, `geometry.pool`) also get the CPU of all dedicated
 * workers inside their interval. Those two overlap, so their worker figures share time; they are not a split.
 *
 * Needs trace categories `toplevel` and `blink.user_timing` (plus `__metadata`, always on). Linux and macOS
 * Chrome record thread time on task events; a trace without any `tdur` is reported as `threadTime: false`.
 *
 * CLI: node scripts/perf/trace-cpu-time.mjs TRACE.json[.gz] [--spans SPANS.json] [--window START_MS,END_MS] [--json]
 */

import { readFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { isMainEntry } from '../lib/is-main-entry.mjs';

export const TRACE_CATEGORIES = ['toplevel', 'blink.user_timing', '__metadata'];
export const INPUT_MARK = 'scoreboard:input';
export const INTERACTIVE_MARK = 'scoreboard:interactive';
/** The input event (page clock) the viewer's in-page spans are relative to; defaults to the window start. */
export const ORIGIN_MARK = 'scoreboard:origin';
/** Largest share of task wall time in the window without thread time for which CPU still counts as measured. */
export const MAX_UNTIMED_SHARE = 0.05;
/** The roles cpuMs.total sums: the load's renderer (main, workers, other threads) and the GPU process. */
export const TOTAL_ROLES = ['rendererMain', 'workers', 'rendererOther', 'gpu'];
/** Main-thread spans that frame work done on dedicated workers. */
export const WORKER_FRAME_SPANS = ['parser.worker', 'geometry.pool'];
/** The stages the report shows first; every other span name is still computed. */
export const KEY_STAGES = ['parser.worker', 'geometry.pool', 'stream.queueDrain', 'scene.finalize'];

/** Trace events from either container form (`{ traceEvents }` or a bare array). */
export function traceEventsOf(trace) {
  if (Array.isArray(trace)) return trace;
  if (trace && Array.isArray(trace.traceEvents)) return trace.traceEvents;
  throw new Error('not a Chrome trace: expected an array or { traceEvents: [...] }');
}

function names(events) {
  const proc = new Map(), thread = new Map();
  for (const e of events) {
    if (e.ph !== 'M') continue;
    if (e.name === 'process_name') proc.set(e.pid, e.args?.name ?? '');
    if (e.name === 'thread_name') thread.set(`${e.pid}:${e.tid}`, e.args?.name ?? '');
  }
  return { proc, thread };
}

/** User Timing marks that carry the page clock: { name, pid, tsUs, startTimeMs }. */
export function userTimingMarks(events) {
  const out = [];
  for (const e of events) {
    const st = e.args?.data?.startTime;
    if (typeof e.cat === 'string' && e.cat.split(',').includes('blink.user_timing') && Number.isFinite(st) && Number.isFinite(e.ts)) {
      out.push({ name: e.name, pid: e.pid, tid: e.tid, tsUs: e.ts, startTimeMs: st });
    }
  }
  return out;
}

/**
 * The load window in trace microseconds. `window` (page clock ms) overrides the marks; the page-to-trace offset
 * comes from the scoreboard marks when present, else from any mark (median over marks of the chosen renderer).
 */
export function resolveWindow(events, { window = null } = {}) {
  const marks = userTimingMarks(events);
  const input = marks.find((m) => m.name === INPUT_MARK);
  const done = marks.find((m) => m.name === INTERACTIVE_MARK);
  const pid = input?.pid ?? done?.pid ?? marks[0]?.pid ?? null;
  if (pid === null) throw new Error('no User Timing mark in the trace: cannot align the page clock (record blink.user_timing)');
  // Page clock = the main thread's: a worker has its own time origin, so worker marks of the same process must not
  // enter the offset (review #10138). The scoreboard marks (written by the harness on the page) are used when present;
  // otherwise only marks on the renderer's main thread.
  const SCOREBOARD = new Set([INPUT_MARK, INTERACTIVE_MARK, ORIGIN_MARK]);
  const mainTid = events.find((e) => e.ph === 'M' && e.name === 'thread_name' && e.pid === pid && e.args?.name === 'CrRendererMain')?.tid;
  const anchors = marks.some((m) => SCOREBOARD.has(m.name) && m.pid === pid) ? marks.filter((m) => SCOREBOARD.has(m.name) && m.pid === pid)
    : mainTid === undefined ? [] : marks.filter((m) => m.pid === pid && m.tid === mainTid);
  // Without the main thread's identity the page clock cannot be told from worker clocks: refuse (review #10138).
  if (anchors.length === 0) throw new Error('no scoreboard marks and no identifiable main-thread User Timing mark: cannot align the page clock');
  const own = anchors.map((m) => m.tsUs - m.startTimeMs * 1000).sort((a, b) => a - b);
  const offsetUs = own[Math.floor(own.length / 2)];
  let startMs, endMs, source;
  if (window) {
    [startMs, endMs] = window;
    source = 'explicit window';
  } else {
    if (!input || !done) throw new Error(`trace has no ${INPUT_MARK}/${INTERACTIVE_MARK} marks; pass an explicit window`);
    startMs = input.startTimeMs; endMs = done.startTimeMs;
    source = 'scoreboard marks';
  }
  if (!(endMs > startMs)) throw new Error(`empty window ${startMs}..${endMs} ms`);
  const origin = marks.find((m) => m.name === ORIGIN_MARK && m.pid === pid);
  return { pid, offsetUs, startMs, endMs, startUs: offsetUs + startMs * 1000, endUs: offsetUs + endMs * 1000, source, spanOriginMs: origin ? origin.startTimeMs : startMs };
}

/**
 * Top-level complete events per thread (an event nested inside an earlier one on the same thread is skipped,
 * so nothing is counted twice), as { ts, dur, tdur|null } in µs.
 */
function topLevelTasks(events) {
  const by = new Map();
  for (const e of events) {
    // Only task events: a non-toplevel X event spanning a task must not hide the task's thread time (review #10138).
    if (e.ph !== 'X' || !Number.isFinite(e.ts) || !Number.isFinite(e.dur) || !String(e.cat ?? '').split(',').includes('toplevel')) continue;
    const key = `${e.pid}:${e.tid}`;
    if (!by.has(key)) by.set(key, []);
    by.get(key).push({ ts: e.ts, dur: e.dur, tdur: Number.isFinite(e.tdur) ? e.tdur : null });
  }
  for (const [key, list] of by) {
    list.sort((a, b) => a.ts - b.ts || b.dur - a.dur);
    const top = [];
    let end = -Infinity;
    for (const t of list) if (t.ts >= end) { top.push(t); end = t.ts + t.dur; }
    by.set(key, top);
  }
  return by;
}

/** Thread CPU µs and busy wall µs inside [lo, hi] (µs); a straddling task counts by its wall share inside. */
function cpuIn(tasks, lo, hi) {
  let cpu = 0, wall = 0, wallWithoutTdur = 0;
  for (const t of tasks) {
    const a = Math.max(t.ts, lo), b = Math.min(t.ts + t.dur, hi);
    if (b <= a && !(t.dur === 0 && t.ts >= lo && t.ts <= hi)) continue;
    const share = t.dur > 0 ? (b - a) / t.dur : 1;
    wall += Math.max(0, b - a);
    if (t.tdur === null) wallWithoutTdur += Math.max(0, b - a);
    else cpu += t.tdur * share;
  }
  return { cpu, wall, wallWithoutTdur };
}

function classify(pid, processName, threadName, rendererPid) {
  if (pid === rendererPid) {
    if (threadName === 'CrRendererMain') return 'rendererMain';
    if (/^DedicatedWorker/.test(threadName)) return 'workers';
    return 'rendererOther';
  }
  if (/^GPU/i.test(processName)) return 'gpu';
  if (/^Browser/i.test(processName)) return 'browser';
  if (/^Renderer/i.test(processName)) return 'otherRenderers';
  return 'other';
}

function union(intervals) {
  const s = intervals.filter(([a, b]) => b > a).sort((x, y) => x[0] - y[0]);
  const out = [];
  for (const [a, b] of s) {
    const last = out.at(-1);
    if (last && a <= last[1]) last[1] = Math.max(last[1], b); else out.push([a, b]);
  }
  return out;
}

/**
 * Stage intervals from the viewer's in-page trace (scoreboard traces/<cell>.json: one entry per load with
 * `spans` = [name, thread, startMs, durationMs, milestone, id, parentId], times from the input event).
 * Milestones (time-to-X markers from the load start) are not work and are skipped.
 * Returns Map(name -> { main: [[a,b]...], worker: [[a,b]...] }) in ms from the input event.
 */
export function stageIntervals(spansTrace) {
  const out = new Map();
  for (const load of spansTrace ?? []) {
    for (const s of load.spans ?? []) {
      const [name, thread, start, dur, milestone] = s;
      if (milestone || !Number.isFinite(start) || !Number.isFinite(dur)) continue;
      if (!out.has(name)) out.set(name, { main: [], worker: [] });
      out.get(name)[thread === 'main' ? 'main' : 'worker'].push([start, start + dur]);
    }
  }
  return out;
}

const ms = (us) => Math.round(us / 10) / 100;

/**
 * CPU time of one load. `events`: Chrome trace events. Options: `window` [startMs, endMs] on the page clock
 * (default: the scoreboard marks); `spans`: the viewer's in-page span trace, for per-stage figures.
 */
export function traceCpuTime(trace, { window = null, spans = null } = {}) {
  const events = traceEventsOf(trace);
  const w = resolveWindow(events, { window });
  const { proc, thread } = names(events);
  const tasks = topLevelTasks(events);
  const totals = { rendererMain: 0, workers: 0, rendererOther: 0, gpu: 0, browser: 0, otherRenderers: 0, other: 0 };
  const threads = [];
  let withTdur = 0;
  const roleWall = {}, roleNoTdur = {};
  for (const [key, list] of tasks) {
    const [pid, tid] = key.split(':').map(Number);
    const processName = proc.get(pid) ?? '', threadName = thread.get(key) ?? '';
    const role = classify(pid, processName, threadName, w.pid);
    const r = cpuIn(list, w.startUs, w.endUs);
    if (r.wall === 0 && r.cpu === 0) continue;
    totals[role] += r.cpu;
    roleWall[role] = (roleWall[role] ?? 0) + r.wall;
    roleNoTdur[role] = (roleNoTdur[role] ?? 0) + r.wallWithoutTdur;
    if (r.cpu > 0 || list.some((t) => t.tdur !== null && t.ts < w.endUs && t.ts + t.dur > w.startUs)) withTdur++; // thread time measured IN the window (review #10138)
    threads.push({ pid, tid, process: processName, thread: threadName, role, cpuMs: ms(r.cpu), busyWallMs: ms(r.wall) });
  }
  threads.sort((a, b) => b.cpuMs - a.cpuMs);
  const renderer = totals.rendererMain + totals.workers + totals.rendererOther;
  // Untimed share per role, and over exactly the roles cpuMs.total sums (review #10138): other processes' timed work
  // must not dilute a gap in the load's own threads.
  const share = (roles) => {
    const all = roles.reduce((a, k) => a + (roleWall[k] ?? 0), 0), no = roles.reduce((a, k) => a + (roleNoTdur[k] ?? 0), 0);
    return all > 0 ? Math.round((no / all) * 1e6) / 1e6 : null;
  };
  const byRole = Object.fromEntries(Object.keys(totals).map((k) => [k, share([k])]));
  const result = {
    window: { startMs: w.startMs, endMs: w.endMs, wallMs: Math.round((w.endMs - w.startMs) * 100) / 100, source: w.source, rendererPid: w.pid },
    threadTime: withTdur > 0,
    // Share of top-level task wall time inside the window whose events carried no thread time (not counted), over the
    // roles in cpuMs.total, and per role.
    uncountedWallShare: share(TOTAL_ROLES),
    uncountedWallShareByRole: byRole,
    cpuMs: {
      rendererMain: ms(totals.rendererMain), workers: ms(totals.workers), rendererOther: ms(totals.rendererOther), renderer: ms(renderer),
      gpu: ms(totals.gpu), browser: ms(totals.browser), otherRenderers: ms(totals.otherRenderers),
      // The load's own CPU: its renderer (main, workers, other threads) and the GPU process.
      total: ms(renderer + totals.gpu),
    },
    threads,
    stages: null,
  };
  // CPU is measured only when the renderer's main thread has thread time in the window and at most MAX_UNTIMED_SHARE of
  // task wall time lacks it; otherwise every figure is unavailable, never a partial or zero total (review #10138).
  const mainTimed = threads.some((t) => t.role === 'rendererMain' && t.cpuMs > 0);
  // A dedicated worker hosted in another renderer process would fall outside the worker figure and the total. It does
  // not happen with this viewer (208 stored traces: one renderer, every DedicatedWorker in the page's renderer), so it is
  // detected, not attributed: CPU is unavailable with the reason (review #10138).
  const strayWorkers = threads.filter((t) => t.role === 'otherRenderers' && /^DedicatedWorker/.test(t.thread));
  result.coverage = !result.threadTime ? 'no thread time in the window' : !mainTimed ? 'renderer main thread has no thread time in the window'
    : strayWorkers.length ? `dedicated worker thread(s) in another renderer (pid ${[...new Set(strayWorkers.map((t) => t.pid))].join(', ')}) are not attributed`
    : TOTAL_ROLES.some((k) => byRole[k] > MAX_UNTIMED_SHARE) ? `${TOTAL_ROLES.filter((k) => byRole[k] > MAX_UNTIMED_SHARE).map((k) => `${k} ${(byRole[k] * 100).toFixed(1)}%`).join(', ')} of task wall time has no thread time` : 'ok';
  if (result.coverage !== 'ok') {
    for (const k of Object.keys(result.cpuMs)) result.cpuMs[k] = null;
    return result;
  }
  // Roles outside the total (browser, other renderers) are reported only when their own coverage holds.
  for (const k of ['browser', 'otherRenderers']) if (byRole[k] > MAX_UNTIMED_SHARE) result.cpuMs[k] = null;
  if (spans) {
    const toUs = (t) => w.offsetUs + (w.spanOriginMs + t) * 1000; // span times are ms from the input event (ORIGIN_MARK)
    const mainTasks = [], workerTasks = [];
    for (const [key, list] of tasks) {
      const [pid] = key.split(':').map(Number);
      const role = classify(pid, proc.get(pid) ?? '', thread.get(key) ?? '', w.pid);
      if (role === 'rendererMain') mainTasks.push(list);
      if (role === 'workers') workerTasks.push(list);
    }
    const sumIn = (lists, ivs) => lists.reduce((acc, list) => acc + ivs.reduce((a, [lo, hi]) => a + cpuIn(list, toUs(lo), toUs(hi)).cpu, 0), 0);
    const stages = {};
    for (const [name, iv] of stageIntervals(spans)) {
      if (iv.main.length === 0) continue;
      // Clipped to the load window (span time = ms from the input event), as cpuMs.total is (review #10138).
      const lo0 = w.startMs - w.spanOriginMs, hi0 = w.endMs - w.spanOriginMs;
      const u = union(iv.main).map(([a, b]) => [Math.max(a, lo0), Math.min(b, hi0)]).filter(([a, b]) => b > a);
      if (u.length === 0) continue;
      const stage = { wallMs: Math.round(u.reduce((a, [lo, hi]) => a + hi - lo, 0) * 100) / 100, mainCpuMs: ms(sumIn(mainTasks, u)) };
      if (WORKER_FRAME_SPANS.includes(name)) stage.workersCpuMs = ms(sumIn(workerTasks, u));
      stages[name] = stage;
    }
    result.stages = stages;
  }
  return result;
}

function parseArgs(argv) {
  const opt = { trace: null, spans: null, window: null, json: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--spans') opt.spans = argv[++i];
    else if (a === '--window') opt.window = argv[++i].split(',').map(Number);
    else if (a === '--json') opt.json = true;
    else if (a === '-h' || a === '--help') opt.help = true;
    else if (!opt.trace) opt.trace = a;
    else throw new Error(`unexpected argument ${a}`);
  }
  return opt;
}

function format(r) {
  const c = r.cpuMs;
  const lines = [`window ${r.window.wallMs} ms wall (${r.window.source}); thread time ${r.threadTime ? 'present' : 'ABSENT'}; uncounted wall share ${r.uncountedWallShare}`,
    `cpu ms: total ${c.total} = renderer ${c.renderer} (main ${c.rendererMain}, workers ${c.workers}, other ${c.rendererOther}) + gpu ${c.gpu}; browser ${c.browser}`];
  if (r.stages) {
    const names = [...KEY_STAGES.filter((n) => r.stages[n]), ...Object.keys(r.stages).filter((n) => !KEY_STAGES.includes(n)).sort((a, b) => r.stages[b].mainCpuMs - r.stages[a].mainCpuMs)];
    for (const n of names.slice(0, 16)) {
      const s = r.stages[n];
      lines.push(`  ${n}: wall ${s.wallMs} ms, main cpu ${s.mainCpuMs} ms${s.workersCpuMs !== undefined ? `, workers cpu ${s.workersCpuMs} ms` : ''}`);
    }
  }
  return lines.join('\n');
}

if (isMainEntry(import.meta.url)) {
  const opt = parseArgs(process.argv.slice(2));
  if (opt.help || !opt.trace) {
    console.log('usage: node scripts/perf/trace-cpu-time.mjs TRACE.json[.gz] [--spans SPANS.json] [--window START_MS,END_MS] [--json]');
    process.exit(opt.help ? 0 : 2);
  }
  const read = (f) => JSON.parse(f.endsWith('.gz') ? gunzipSync(readFileSync(f)).toString('utf8') : readFileSync(f, 'utf8'));
  const r = traceCpuTime(read(opt.trace), { window: opt.window, spans: opt.spans ? read(opt.spans) : null });
  console.log(opt.json ? JSON.stringify(r, null, 2) : format(r));
}
