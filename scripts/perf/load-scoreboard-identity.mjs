/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Reopen output identity: the scoreboard's untimed identity pass.
 *
 * A cache hit has no element geometry hashes, so the timed passes can only call
 * a reopen UNVERIFIABLE. The identity pass repeats a sample once per side and
 * fixture (round 0) with `?perf.sceneIdentity=1`. The viewer then hashes what
 * its scene holds, after each open (apps/viewer/src/lib/perf/sceneIdentity.ts):
 *
 * - pieces: every CPU geometry piece (flat and materialized instanced), over
 *   exact bytes, per expressId, independent of order;
 * - snapshots: the batches a finalize captured or a reopen adopted.
 *
 * A reopen matches when its pieces equal its own cold open's, and every
 * snapshot it adopted equals one an earlier open of the sample captured.
 * Chained with browser-cold's element-hash verdict (base cold == branch cold),
 * that verifies the reopen lanes. Timed and memory samples never set the flag.
 *
 * `LOAD_SCOREBOARD_CORRUPT_SNAPSHOT=1` is the harness proof: before every reopen
 * of the identity pass, it flips one vertex byte of every stored scene snapshot.
 * Its table CRC still passes, so the viewer adopts and draws it, and the
 * verdict must read RESTORE MISMATCH. Never set it for a board.
 */

export const IDENTITY_QUERY = 'perf.sceneIdentity=1';

/** In page: the identity hook's answer once nothing is still hashing, hydrating or finalizing (bounded). */
export async function readSceneIdentity(page, { timeoutMs = 180000 } = {}) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const r = await page.evaluate(async () => {
      const hook = globalThis.__ifc_lite_scene_identity__;
      if (typeof hook !== 'function') return { tap: false };
      return { tap: true, ...(await hook({ perElement: true })) };
    });
    if (!r.tap) return { tap: false, error: 'the page exposes no __ifc_lite_scene_identity__ (build without the identity tap, or flag not applied)' };
    if (r.pending === 0 && !r.hydrating && !r.finalizing) return r;
    if (Date.now() > deadline) return { ...r, error: `identity not settled within ${timeoutMs} ms (pending ${r.pending}, hydrating ${r.hydrating}, finalizing ${r.finalizing})` };
    await page.waitForTimeout(250);
  }
}

/** In page: flip one vertex byte of the first batch of every stored scene snapshot. Returns how many it altered. */
export function corruptStoredSnapshots(page) {
  return page.evaluate(() => new Promise((done) => {
    const open = indexedDB.open('ifc-lite-cache');
    open.onerror = () => done({ altered: 0, error: 'open failed' });
    open.onsuccess = async () => {
      const db = open.result;
      const read = () => new Promise((res, rej) => { const q = db.transaction('models').objectStore('models').getAll(); q.onsuccess = () => res(q.result); q.onerror = () => rej(q.error); });
      const keys = () => new Promise((res, rej) => { const q = db.transaction('models').objectStore('models').getAllKeys(); q.onsuccess = () => res(q.result); q.onerror = () => rej(q.error); });
      try {
        const [entries, ids] = [await read(), await keys()];
        let altered = 0;
        const notes = [];
        for (let i = 0; i < entries.length; i++) {
          const entry = entries[i];
          if (!(entry?.sceneSnapshot instanceof Blob)) continue;
          const bytes = new Uint8Array(await entry.sceneSnapshot.arrayBuffer());
          const view = new DataView(bytes.buffer);
          const tableBytes = view.getUint32(8, true);
          const table = JSON.parse(new TextDecoder().decode(bytes.subarray(16, 16 + tableBytes)));
          const start = (16 + tableBytes + 15) & -16;
          const target = table.batches.find((b) => b.vertexData[1] > 0);
          if (!target) continue;
          const at = start + target.vertexData[0] + (target.vertexData[1] >> 1);
          bytes[at] ^= 0x5a;
          entry.sceneSnapshot = new Blob([bytes]);
          await new Promise((res, rej) => {
            const tx = db.transaction('models', 'readwrite');
            const store = tx.objectStore('models');
            if (store.keyPath === null) store.put(entry, ids[i]); else store.put(entry);
            tx.oncomplete = res; tx.onerror = () => rej(tx.error);
          });
          altered++;
          notes.push(`${target.key}@${at}`);
        }
        db.close();
        done({ altered, notes });
      } catch (e) { db.close(); done({ altered: 0, error: String(e) }); }
    };
  }));
}

/**
 * Verdict of one reopen against its sample's earlier opens (`opens[0]` is cold).
 * Each open: { label, identity: readSceneIdentity() result }. Never a match on missing input.
 */
export function reopenIdentityVerdict(opens, index) {
  const cold = opens[0]?.identity, warm = opens[index]?.identity;
  if (!cold?.tap || !warm?.tap) return { verdict: 'UNVERIFIABLE (no identity tap in this build)', match: false };
  if (cold.error || warm.error) return { verdict: `UNVERIFIABLE (${warm.error ?? cold.error})`, match: false };
  if (!cold.pieces?.sig || !warm.pieces?.sig || !(cold.pieces.elements > 0)) return { verdict: 'UNVERIFIABLE (no geometry pieces read)', match: false };
  const problems = [];
  if (warm.pieces.sig !== cold.pieces.sig) {
    const a = cold.pieces.perElement ?? {}, b = warm.pieces.perElement ?? {};
    const changed = Object.keys(a).filter((id) => id in b && a[id] !== b[id]);
    const missing = Object.keys(a).filter((id) => !(id in b)), extra = Object.keys(b).filter((id) => !(id in a));
    problems.push(`pieces ${warm.pieces.elements} vs cold ${cold.pieces.elements} elements: ${changed.length} changed, ${missing.length} missing, ${extra.length} extra (e.g. ${[...changed, ...missing, ...extra].slice(0, 5).join(', ')})`);
  }
  const captured = new Set(opens.slice(0, index).flatMap((o) => (o.identity?.snapshots ?? []).filter((s) => s.kind === 'captured' && s.sig).map((s) => s.sig)));
  const adopted = (warm.snapshots ?? []).filter((s) => s.kind === 'adopted');
  for (const s of adopted) {
    if (!s.sig) problems.push(`adopted snapshot not hashed (${s.error ?? 'no signature'})`);
    else if (!captured.has(s.sig)) problems.push(`adopted ${s.sig} equals no snapshot an earlier open captured (${captured.size} captured)`);
  }
  if (problems.length) return { verdict: `RESTORE MISMATCH vs cold: ${problems.join('; ')}`, match: false, adopted: adopted.length };
  return { verdict: `match (pieces = cold${adopted.length ? `, ${adopted.length} adopted snapshot(s) = captured` : ', streamed (no snapshot adopted)'})`, match: true, adopted: adopted.length };
}

/**
 * A reopen lane's output verdict from its identity rows (one per side). Both sides must match their own
 * cold; the cold lanes' element-hash verdict carries the identity across sides. Null when no identity
 * row exists for the lane (the timed passes' verdict then stands). 'match' means: every reopen of the identity
 * pass restored its own cold output, on both sides; the cold lanes' element hashes chain it across sides.
 */
export function laneIdentityVerdict(rows, lane) {
  const mine = rows.filter((r) => r.lane === 'identity' && r.reopens?.[lane]);
  if (mine.length === 0) return null;
  const bySide = Object.fromEntries(['base', 'branch'].map((side) => [side, mine.filter((r) => r.side === side).map((r) => r.reopens[lane])]));
  const all = [...bySide.base, ...bySide.branch];
  if (all.some((v) => v.verdict.startsWith('RESTORE MISMATCH'))) return `RESTORE MISMATCH (identity pass: ${all.find((v) => v.verdict.startsWith('RESTORE')).verdict.slice(0, 200)})`;
  if (bySide.base.length === 0 || bySide.branch.length === 0) return 'unverifiable (identity pass missing on a side)';
  if (!all.every((v) => v.match)) return `unverifiable (identity pass: ${all.find((v) => !v.match).verdict.slice(0, 160)})`;
  return 'match';
}
