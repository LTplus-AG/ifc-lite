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

/** Times of an early open, moved from the change event to the arm (the pick): the dispatch delay is the user's wait. */
export function rebaseToArm(open) {
  const delay = Number.isFinite(open.inputDelayMs) ? open.inputDelayMs : 0;
  const shift = (v) => (Number.isFinite(v) ? v + delay : v);
  return { ...open, clockFrom: 'arm (file picked at first paint)', interactiveFromChangeMs: open.interactiveMs,
    firstFrameMs: shift(open.firstFrameMs), interactiveMs: shift(open.interactiveMs), uiQuietMs: shift(open.uiQuietMs),
    geometryMs: shift(open.geometryMs), propsMs: shift(open.propsMs), storeSettledMs: shift(open.storeSettledMs),
    settlePaintMs: shift(open.settlePaintMs), publishPaintMs: shift(open.publishPaintMs) };
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
 * at or after `shellReadyMs`; `shellReadyMs` itself when no long task follows it.
 */
export function bootTimeToInteractive(tasks, shellReadyMs, quietMs = 1000) {
  const sorted = tasks.map(([s, d]) => [s, s + d]).sort((a, b) => a[0] - b[0]);
  let busyUntil = shellReadyMs;
  for (const [start, end] of sorted) {
    if (end <= busyUntil) continue;
    if (start - busyUntil >= quietMs) break;
    busyUntil = Math.max(busyUntil, end);
  }
  return busyUntil;
}

/**
 * Combine per-realm WebAssembly memory sums. Memory a realm owns adds up. A
 * shared (SharedArrayBuffer-backed) memory appears in every realm that imports
 * it, and realms cannot tell whether two shared buffers are the same one, so
 * shared memories are counted once per distinct exact size (`sharedBytes`, the
 * estimate in the total). `sharedBytesUpperBound` counts every occurrence, and
 * `sharedAmbiguous` says when the two differ, i.e. when the dedupe assumption
 * (one size, one memory) decided the number.
 */
export function combineWasmRealms(realms) {
  const own = realms.reduce((a, r) => a + (r.own ?? 0), 0);
  const occurrences = realms.flatMap((r) => (Array.isArray(r.shared) ? r.shared : r.shared ? [r.shared] : []));
  const shared = [...new Set(occurrences)].reduce((a, n) => a + n, 0);
  const upper = occurrences.reduce((a, n) => a + n, 0);
  return { totalBytes: own + shared, ownBytes: own, sharedBytes: shared, sharedBytesUpperBound: upper, sharedAmbiguous: upper !== shared,
    memories: realms.reduce((a, r) => a + (r.count ?? 0), 0), realms: realms.length };
}

/**
 * Why the first reopen cannot be prepared, or null. The cache entry must have
 * been readable and must have stopped changing; otherwise a snapshot written at
 * the end of the cold load may still race the reopen.
 */
export function entryStabilityFailure(entry) {
  if (!entry) return null;
  if (entry.error) return `cache entry unreadable before the first reopen (${entry.error})`;
  if (!entry.stable) return `cache entry still changing ${entry.waitedMs} ms after the cold load, so a snapshot write may race the first reopen`;
  return null;
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
export async function wasmHeaps(context, page) {
  const cdp = await context.newCDPSession(page);
  try {
    const realms = [{ realm: 'page', ...(await realmWasm((m, p) => cdp.send(m, p))) }];
    const { targetInfos } = await cdp.send('Target.getTargets');
    let id = 0;
    const pending = new Map();
    cdp.on('Target.receivedMessageFromTarget', ({ message }) => { const msg = JSON.parse(message); pending.get(msg.id)?.(msg); });
    for (const t of targetInfos.filter((x) => x.type === 'worker' || x.type === 'shared_worker')) {
      const { sessionId } = await cdp.send('Target.attachToTarget', { targetId: t.targetId, flatten: false });
      const send = (method, params) => new Promise((resolve, reject) => {
        const mid = ++id;
        pending.set(mid, (msg) => (msg.error ? reject(new Error(msg.error.message)) : resolve(msg.result)));
        cdp.send('Target.sendMessageToTarget', { sessionId, message: JSON.stringify({ id: mid, method, params }) }).catch(reject);
      });
      realms.push({ realm: t.type, ...(await realmWasm(send)) });
      await cdp.send('Target.detachFromTarget', { sessionId }).catch(() => {});
    }
    return combineWasmRealms(realms);
  } finally {
    await cdp.detach().catch(() => {});
  }
}

/** In page: long tasks so far and the shell's own readiness. */
function bootState() {
  return { now: performance.now(), tasks: globalThis.__benchLongTasks ?? [],
    jsHeap: performance.memory ? performance.memory.usedJSHeapSize : null };
}

/** In page: JS + wasm memory of the page and its workers (cross-origin isolated pages only), bounded. */
function measureAgentMemory(timeoutMs) {
  if (typeof performance.measureUserAgentSpecificMemory !== 'function') return Promise.resolve({ error: 'measureUserAgentSpecificMemory unavailable' });
  return Promise.race([
    performance.measureUserAgentSpecificMemory().then((m) => {
      const byScope = {};
      for (const b of m.breakdown) {
        const scope = b.attribution?.[0]?.scope ?? (b.attribution?.length ? 'other' : 'unattributed');
        byScope[scope] = (byScope[scope] ?? 0) + b.bytes;
      }
      return { bytes: m.bytes, byScope };
    }),
    new Promise((done) => setTimeout(() => done({ error: `no result within ${timeoutMs} ms` }), timeoutMs)),
  ]);
}

/**
 * One `boot` sample: fresh browser, no file. Never throws; a failure is a row
 * with `ok: false`. `openShell(context)` navigates and waits for the shell
 * (store + file input), as the timed lanes do.
 */
export async function bootSample({ chromium, launchOptions, initScripts, openShell, idleAfterMs = 5000, log, tag }) {
  const profileDir = mkdtempSync(join(tmpdir(), 'load-scoreboard-boot-'));
  const row = { lane: 'boot', ok: false };
  let context = null;
  try {
    context = await chromium.launchPersistentContext(profileDir, launchOptions);
    for (const [script, arg] of initScripts) await context.addInitScript(script, arg);
    const page = await openShell(context);
    const shellReadyMs = await page.evaluate(() => globalThis.__benchShellAt ?? performance.now());
    const now = await page.evaluate(() => performance.now());
    if (now < idleAfterMs) await page.waitForTimeout(idleAfterMs - now);
    const s = await page.evaluate(bootState);
    const pids = chromePids(profileDir);
    const pss = memoryOf(pids);
    const agent = await page.evaluate(measureAgentMemory, 30000).catch((e) => ({ error: String(e).slice(0, 200) }));
    const wasm = await wasmHeaps(context, page).catch((e) => ({ error: String(e).slice(0, 200) }));
    const interactive = bootTimeToInteractive(s.tasks, shellReadyMs);
    Object.assign(row, {
      ok: true, shellReadyMs, interactiveMs: interactive, bootLongTasks: s.tasks.length,
      bootLongTaskMs: s.tasks.reduce((a, [, d]) => a + d, 0), idleAtMs: s.now,
      peakMemoryMiB: pss.pssMiB, peakMemoryMetric: `PSS sum of the profile's Chrome processes ${Math.round(s.now)} ms after navigation (idle)`,
      idleRssMiB: pss.rssMiB, idleJsMiB: agent.bytes === undefined ? null : agent.bytes / 2 ** 20, idleJsByScope: agent.byScope ?? null,
      idleJsError: agent.error ?? null, idleMainHeapMiB: s.jsHeap === null ? null : s.jsHeap / 2 ** 20, idleVramMiB: vramOf(pids),
      idleWasmMiB: wasm.totalBytes === undefined ? null : wasm.totalBytes / 2 ** 20, idleWasm: wasm,
      firstGeometryMs: null, uiQuietMs: null, fingerprint: 'no model',
    });
    log?.(`  ${tag} boot: shell ${shellReadyMs.toFixed(0)} ms, interactive ${interactive.toFixed(0)} ms, ${row.bootLongTasks} long tasks, idle PSS ${pss.pssMiB.toFixed(0)} MiB, JS ${row.idleJsMiB?.toFixed(1) ?? 'n/a'} MiB, wasm ${row.idleWasmMiB?.toFixed(1) ?? 'n/a'} MiB, GPU ${row.idleVramMiB ?? 'n/a'} MiB`);
  } catch (err) {
    row.error = `boot: ${String(err?.message ?? err).slice(0, 600)}`;
    log?.(`  ${tag} FAILED ${row.error}`);
  } finally {
    await context?.close().catch(() => {});
    rmSync(profileDir, { recursive: true, force: true });
  }
  return row;
}
