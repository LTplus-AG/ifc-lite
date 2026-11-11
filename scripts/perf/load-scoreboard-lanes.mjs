/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Extra lanes for `load-scoreboard.mjs`, for work that moves cost into boot or
 * into the cold load's tail:
 *
 * - `browser-cold-early`: a fresh browser whose file is picked at the first
 *   paint after the file input exists, with no quiet-shell arming. A boot-time
 *   warm-up can only hurt the user who opens at once, so this lane times from
 *   the pick: the input event's dispatch delay is inside the clock here (it is
 *   what that user waits through), unlike the default lanes.
 * - `boot`: a fresh browser that opens no file. App-shell ready, boot
 *   time-to-interactive (end of the last long task before 1 s without one),
 *   boot long tasks, and idle memory 5 s after navigation: Chrome PSS; JS heaps
 *   of the page and its workers (`performance.measureUserAgentSpecificMemory()`,
 *   which does NOT count WebAssembly memory: a 64 MiB WebAssembly.Memory moved it
 *   by 0.3 MiB on Pop); WebAssembly heaps summed explicitly over the page and
 *   every worker through CDP `Runtime.queryObjects(WebAssembly.Memory.prototype)`
 *   (measured exactly: +64.0 MiB for a 64 MiB memory in the page and in a
 *   worker); and GPU memory from nvidia-smi.
 * - Before the first reopen the stored cache entry must stop changing, so a
 *   scene snapshot captured at the end of the cold load is either there or
 *   not, never racing the reopen. The reopen keeps its lane; whether a
 *   snapshot was present and adopted is recorded.
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromePids, memoryOf, vramOf } from './scenoptic-bench-sampling.mjs';

// ---------------------------------------------------------------- pure helpers

/**
 * Times of an early open, moved onto the first paint the file was picked at:
 * `delay` = the clock origin (change event, or arm when none was seen) minus
 * the first paint. It covers both the arm queuing behind boot work and the
 * input event's dispatch delay, which is what the user who opens at once waits
 * through. Without either anchor the timings are unverifiable (null), never
 * silently left on the later origin.
 */
export function rebaseToArm(open) {
  const paint = open.shell?.armedAtMs, origin = open.originAbs;
  const keys = ['firstFrameMs', 'interactiveMs', 'uiQuietMs', 'geometryMs', 'propsMs', 'storeSettledMs', 'settlePaintMs', 'publishPaintMs'];
  if (!Number.isFinite(paint) || !Number.isFinite(origin) || origin < paint) {
    return { ...open, clockFrom: 'unverifiable (no first-paint anchor)', interactiveFromChangeMs: open.interactiveMs, ...Object.fromEntries(keys.map((k) => [k, null])) };
  }
  const delay = origin - paint;
  const shift = (v) => (Number.isFinite(v) ? v + delay : v);
  return { ...open, clockFrom: 'first paint (file picked at once)', pickDelayMs: delay, interactiveFromChangeMs: open.interactiveMs,
    ...Object.fromEntries(keys.map((k) => [k, shift(open[k])])) };
}

/**
 * `observations`: [{ at, sig }] in time order. The time the signature last
 * changed, if it has then held for `stableMs` by the last observation; else null.
 */
export function stableSince(observations, stableMs) {
  if (observations.length === 0) return null;
  let since = observations[0].at;
  for (let i = 1; i < observations.length; i++) if (observations[i].sig !== observations[i - 1].sig) since = observations[i].at;
  return observations.at(-1).at - since >= stableMs ? since : null;
}

/**
 * Boot time-to-interactive (page clock, ms since navigation): the end of the
 * last long task before the first window of `quietMs` without one that starts
 * at or after `shellReadyMs`. `settled` is true only when that quiet window was
 * actually observed: a later task starting at least `quietMs` after it, or
 * `nowMs` at least `quietMs` past it. An unsettled value is not a measurement.
 */
export function bootTti(tasks, shellReadyMs, nowMs, quietMs = 1000) {
  if (!Number.isFinite(shellReadyMs)) return { ms: null, settled: false };
  const sorted = tasks.map(([st, d]) => [st, st + d]).sort((a, b) => a[0] - b[0]);
  let busyUntil = shellReadyMs, gapSeen = false;
  for (const [start, end] of sorted) {
    if (end <= busyUntil) continue;
    if (start - busyUntil >= quietMs) { gapSeen = true; break; }
    busyUntil = Math.max(busyUntil, end);
  }
  return { ms: busyUntil, settled: gapSeen || (Number.isFinite(nowMs) && nowMs - busyUntil >= quietMs) };
}

/**
 * Combine per-realm WebAssembly memory sums. Memory a realm owns adds up. A
 * shared (SharedArrayBuffer-backed) memory appears in every realm that imports
 * it, and realms cannot tell whether two shared buffers are the same one: per
 * exact size, the estimate counts the largest number of such memories any one
 * realm holds (distinct memories inside one realm are distinct objects, so they
 * all count). `sharedBytesUpperBound` counts every occurrence, and
 * `sharedAmbiguous` says when the two differ. No realm measured is not zero
 * memory: the totals are then null (unverifiable).
 */
export function combineWasmRealms(realms) {
  if (!Array.isArray(realms) || realms.length === 0) {
    return { totalBytes: null, ownBytes: null, sharedBytes: null, sharedBytesUpperBound: null, sharedAmbiguous: null, memories: 0, realms: 0, error: 'no realm measured' };
  }
  const own = realms.reduce((a, r) => a + (r.own ?? 0), 0);
  const listOf = (r) => (Array.isArray(r.shared) ? r.shared : r.shared ? [r.shared] : []);
  const perSize = new Map();
  for (const r of realms) {
    const counts = new Map();
    for (const n of listOf(r)) counts.set(n, (counts.get(n) ?? 0) + 1);
    for (const [n, count] of counts) perSize.set(n, Math.max(perSize.get(n) ?? 0, count));
  }
  const shared = [...perSize].reduce((a, [n, count]) => a + n * count, 0);
  const upper = realms.flatMap(listOf).reduce((a, n) => a + n, 0);
  return { totalBytes: own + shared, ownBytes: own, sharedBytes: shared, sharedBytesUpperBound: upper, sharedAmbiguous: upper !== shared,
    memories: realms.reduce((a, r) => a + (r.count ?? 0), 0), realms: realms.length };
}

/**
 * Why the first reopen cannot be prepared, or null. The cache entry must have
 * been checked, readable and must have stopped changing; otherwise a snapshot
 * written at the end of the cold load may still race the reopen. Uncached
 * tiers pass `{ skipped: <reason> }`; an absent result is a failure.
 */
export function entryStabilityFailure(entry) {
  if (!entry) return 'cache entry was not checked before the first reopen';
  if (entry.skipped) return null;
  if (entry.error) return `cache entry unreadable before the first reopen (${entry.error})`;
  if (entry.stable !== true) return `cache entry still changing ${entry.waitedMs} ms after the cold load, so a snapshot write may race the first reopen`;
  return null;
}

/** `promise`, or a rejection naming `what` after `ms`: a CDP request that never answers must not hang a sample. */
export function bounded(promise, ms, what) {
  let timer;
  const timeout = new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`${what} gave no answer within ${ms} ms`)), ms); });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

/** Idle agent memory split from a measureUserAgentSpecificMemory() result: JS heap (entries typed JavaScript) and the total. */
export function agentMemoryParts(result) {
  if (!result || !Array.isArray(result.breakdown) || !Number.isFinite(result.bytes)) return { totalBytes: null, jsBytes: null };
  const js = result.breakdown.filter((b) => (b.types ?? []).includes('JavaScript')).reduce((a, b) => a + b.bytes, 0);
  return { totalBytes: result.bytes, jsBytes: js };
}

// ---------------------------------------------------------------- page helpers

/** Arm at the first paint after the shell exists: one animation frame, no long-task quiet window. */
export async function waitFirstPaint(page) {
  const at = await page.evaluate(() => new Promise((done) => requestAnimationFrame(() => done(performance.now()))));
  return { mode: 'first-paint', armedAtMs: at };
}

/** In page: one signature of the viewer's cache entries (count, write time, snapshot size). */
function cacheEntrySignature() {
  return new Promise((done) => {
    const open = indexedDB.open('ifc-lite-cache');
    open.onerror = () => done({ error: `indexedDB.open failed: ${open.error?.name ?? 'unknown'}` });
    open.onsuccess = () => {
      const db = open.result;
      if (!db.objectStoreNames.contains('models')) { db.close(); done({ sig: 'no-store', snapshot: false }); return; } // nothing cached yet: a real state
      const all = db.transaction('models').objectStore('models').getAll();
      all.onerror = () => { db.close(); done({ error: `models.getAll failed: ${all.error?.name ?? 'unknown'}` }); };
      all.onsuccess = () => {
        db.close();
        const rows = all.result;
        done({ sig: rows.map((e) => `${e.createdAt ?? ''}:${e.sceneSnapshot?.size ?? 0}`).sort().join('|') || 'empty',
          snapshot: rows.length > 0 && rows.every((e) => Boolean(e.sceneSnapshot)) });
      };
    };
  });
}

/** Wait until the cache entry has not changed for `stableMs` (capped). Returns whether a snapshot is present. */
export async function waitCacheEntryStable(page, { stableMs = 3000, timeoutMs = 30000, pollMs = 250 } = {}) {
  const started = Date.now(), observations = [];
  let last = null;
  for (;;) {
    last = await page.evaluate(cacheEntrySignature);
    if (last.error) return { stable: false, snapshotPresent: null, waitedMs: Date.now() - started, error: last.error };
    observations.push({ at: Date.now() - started, sig: last.sig });
    const since = stableSince(observations, stableMs);
    if (since !== null || Date.now() - started >= timeoutMs) {
      return { stable: since !== null, snapshotPresent: last.snapshot, waitedMs: Date.now() - started };
    }
    await page.waitForTimeout(pollMs);
  }
}

const SUM_WASM_MEMORIES = `function () { let own = 0; const shared = []; for (const m of this) { const n = m.buffer.byteLength;
  if (typeof SharedArrayBuffer !== 'undefined' && m.buffer instanceof SharedArrayBuffer) shared.push(n); else own += n; }
  return { own, shared, count: this.length }; }`;

async function realmWasm(send) {
  const proto = await send('Runtime.evaluate', { expression: 'WebAssembly.Memory.prototype' });
  const objs = await send('Runtime.queryObjects', { prototypeObjectId: proto.result.objectId });
  return (await send('Runtime.callFunctionOn', { objectId: objs.objects.objectId, functionDeclaration: SUM_WASM_MEMORIES, returnByValue: true })).result.value;
}

/** Every live WebAssembly.Memory in the page and its (shared) workers, through CDP; see the header. */
export async function wasmHeaps(context, page, { requestTimeoutMs = 15000 } = {}) {
  const cdp = await bounded(context.newCDPSession(page), requestTimeoutMs, 'CDP session');
  // Every page-side request is bounded too, not only the ones relayed to workers.
  const pageSend = (method, params) => bounded(cdp.send(method, params), requestTimeoutMs, method);
  try {
    const realms = [{ realm: 'page', ...(await realmWasm(pageSend)) }];
    const { targetInfos } = await pageSend('Target.getTargets');
    let id = 0;
    const pending = new Map(); // id -> { sessionId, settle(msg) }
    cdp.on('Target.receivedMessageFromTarget', ({ message }) => { const msg = JSON.parse(message); pending.get(msg.id)?.settle(msg); });
    // A worker that goes away mid-request must fail the measurement, never leave it waiting.
    cdp.on('Target.detachedFromTarget', ({ sessionId }) => {
      for (const p of [...pending.values()]) if (p.sessionId === sessionId) p.settle({ error: { message: 'worker detached during measurement' } });
    });
    for (const t of targetInfos.filter((x) => x.type === 'worker' || x.type === 'shared_worker')) {
      const { sessionId } = await pageSend('Target.attachToTarget', { targetId: t.targetId, flatten: false });
      const send = (method, params) => new Promise((resolve, reject) => {
        const mid = ++id;
        const timer = setTimeout(() => settle({ error: { message: `${method} gave no answer within ${requestTimeoutMs} ms` } }), requestTimeoutMs);
        function settle(msg) {
          clearTimeout(timer);
          pending.delete(mid);
          if (msg.error) reject(new Error(msg.error.message)); else resolve(msg.result);
        }
        pending.set(mid, { sessionId, settle });
        cdp.send('Target.sendMessageToTarget', { sessionId, message: JSON.stringify({ id: mid, method, params }) }).catch((e) => settle({ error: { message: String(e) } }));
      });
      realms.push({ realm: t.type, ...(await realmWasm(send)) });
      await pageSend('Target.detachFromTarget', { sessionId }).catch(() => {});
    }
    return combineWasmRealms(realms);
  } finally {
    await bounded(cdp.detach(), requestTimeoutMs, 'CDP detach').catch(() => {});
  }
}

/** In page: long tasks so far and the shell's own readiness. */
function bootState() {
  return { now: performance.now(), tasks: globalThis.__benchLongTasks ?? [],
    jsHeap: performance.memory ? performance.memory.usedJSHeapSize : null };
}

/** In page: agent memory of the page and its workers (cross-origin isolated pages only; no WebAssembly memory), bounded. */
function measureAgentMemory(timeoutMs) {
  if (typeof performance.measureUserAgentSpecificMemory !== 'function') return Promise.resolve({ error: 'measureUserAgentSpecificMemory unavailable' });
  return Promise.race([
    performance.measureUserAgentSpecificMemory().then((m) => {
      const byScope = {};
      for (const b of m.breakdown) {
        const scope = b.attribution?.[0]?.scope ?? (b.attribution?.length ? 'other' : 'unattributed');
        byScope[scope] = (byScope[scope] ?? 0) + b.bytes;
      }
      return { bytes: m.bytes, byScope, breakdown: m.breakdown.map((b) => ({ bytes: b.bytes, types: b.types })) };
    }),
    new Promise((done) => setTimeout(() => done({ error: `no result within ${timeoutMs} ms` }), timeoutMs)),
  ]);
}

/**
 * One `boot` sample: fresh browser, no file. Never throws; a failure is a row
 * with `ok: false`. `openShell(context)` navigates and waits for the shell
 * (store + file input), as the timed lanes do.
 */
export async function bootSample({ chromium, launchOptions, initScripts, openShell, idleAfterMs = 5000, ttiCapMs = 30000, log, tag }) {
  const profileDir = mkdtempSync(join(tmpdir(), 'load-scoreboard-boot-'));
  const row = { lane: 'boot', ok: false };
  let context = null;
  try {
    context = await chromium.launchPersistentContext(profileDir, launchOptions);
    for (const [script, arg] of initScripts) await context.addInitScript(script, arg);
    const page = await openShell(context);
    const shellReadyMs = await page.evaluate(() => globalThis.__benchShellAt ?? null);
    if (!Number.isFinite(shellReadyMs)) throw new Error('app-shell readiness was not stamped (store or file input never appeared)');
    // Boot interactivity first: observe until its 1 s quiet window has actually happened (capped). The
    // memory reads below walk heaps on the main thread, so they come after, never inside, that window.
    const started = Date.now();
    let s = await page.evaluate(bootState), tti = bootTti(s.tasks, shellReadyMs, s.now);
    while (!tti.settled && Date.now() - started < ttiCapMs) {
      await page.waitForTimeout(200);
      s = await page.evaluate(bootState);
      tti = bootTti(s.tasks, shellReadyMs, s.now);
    }
    // Idle memory: at least `idleAfterMs` after navigation, and only once the shell has gone quiet.
    const now = await page.evaluate(() => performance.now());
    if (now < idleAfterMs) await page.waitForTimeout(idleAfterMs - now);
    const idle = await page.evaluate(bootState);
    const pids = chromePids(profileDir);
    const pss = pids.length ? memoryOf(pids) : { pssMiB: null, rssMiB: null };
    const agentRaw = await page.evaluate(measureAgentMemory, 30000).catch((e) => ({ error: String(e).slice(0, 200) }));
    const agent = agentMemoryParts(agentRaw);
    const wasm = await wasmHeaps(context, page).catch((e) => ({ totalBytes: null, error: String(e).slice(0, 200) }));
    const mib = (b) => (Number.isFinite(b) ? b / 2 ** 20 : null);
    Object.assign(row, {
      ok: true, shellReadyMs, interactiveMs: tti.settled ? tti.ms : null, bootInteractiveSettled: tti.settled,
      bootLongTasks: s.tasks.length, bootLongTaskMs: s.tasks.reduce((a, [, d]) => a + d, 0), idleAtMs: idle.now,
      peakMemoryMiB: pss.pssMiB, peakMemoryMetric: `PSS sum of the profile's Chrome processes ${Math.round(idle.now)} ms after navigation (idle)`,
      idleRssMiB: pss.rssMiB, idleJsHeapMiB: mib(agent.jsBytes), idleAgentMiB: mib(agent.totalBytes), idleAgentByScope: agentRaw.byScope ?? null,
      idleAgentError: agentRaw.error ?? null, idleMainHeapMiB: mib(idle.jsHeap), idleVramMiB: pids.length ? vramOf(pids) : null,
      idleWasmMiB: mib(wasm.totalBytes), idleWasm: wasm,
      firstGeometryMs: null, uiQuietMs: null, fingerprint: 'no model',
    });
    const f = (v, d = 0) => (Number.isFinite(v) ? v.toFixed(d) : 'n/a');
    log?.(`  ${tag} boot: shell ${f(shellReadyMs)} ms, interactive ${tti.settled ? `${f(tti.ms)} ms` : 'unsettled (quiet window not observed)'}, ${row.bootLongTasks} long tasks, idle PSS ${f(pss.pssMiB)} MiB, JS heap ${f(row.idleJsHeapMiB, 1)} MiB (agent ${f(row.idleAgentMiB, 1)}), wasm ${f(row.idleWasmMiB, 1)} MiB, GPU ${row.idleVramMiB ?? 'n/a'} MiB`);
  } catch (err) {
    row.error = `boot: ${String(err?.message ?? err).slice(0, 600)}`;
    log?.(`  ${tag} FAILED ${row.error}`);
  } finally {
    await context?.close().catch(() => {});
    rmSync(profileDir, { recursive: true, force: true });
  }
  return row;
}
