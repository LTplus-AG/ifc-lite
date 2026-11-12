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
 * - snapshots: the batches a load wrote to the cache or a reopen adopted.
 *
 * A reopen matches when its pieces equal its own cold open's, and every
 * snapshot it adopted equals one an earlier open of the sample wrote.
 * Chained with browser-cold's element-hash verdict (base cold == branch cold),
 * that verifies the reopen lanes. Timed and memory samples never set the flag.
 *
 * `LOAD_SCOREBOARD_CORRUPT_SNAPSHOT=1` is the harness proof: before every reopen
 * of the identity pass, once cache writes have settled, it flips one vertex byte of every stored scene
 * snapshot (a different byte per reopen, so a rewritten copy is never flipped back).
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

/**
 * Before leaving a page: re-read the tapped snapshots (writes that completed after the open's identity read,
 * once cache writes have settled) and merge them into that open's record, by position (the tap list only grows).
 */
export async function settleIdentityWrites(page, record) {
  if (!record?.identity?.tap) return record;
  const deadline = Date.now() + 60000;
  for (;;) {
    const late = await page.evaluate(async () => {
      const hook = globalThis.__ifc_lite_scene_identity__;
      if (typeof hook !== 'function') return null;
      const r = await hook({ perElement: false });
      return { snapshots: r.snapshots, pending: r.pending };
    });
    if (!late) return record;
    if (late.pending === 0 || Date.now() > deadline) {
      record.identity.snapshots = late.snapshots;
      if (late.pending > 0) record.identity.error = `snapshot hashing still pending after cache writes settled (${late.pending})`;
      return record;
    }
    await page.waitForTimeout(250);
  }
}

/** In page: flip one vertex byte of the first batch of every stored scene snapshot. Returns how many it altered. */
export function corruptStoredSnapshots(page, open = 1) {
  // A reopen may rewrite the snapshot it adopted, flipped byte included: flip a different byte per open, never the same one back.
  return page.evaluate((reopen) => new Promise((done) => {
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
          const at = start + target.vertexData[0] + (((target.vertexData[1] >> 1) + 4 * reopen) % target.vertexData[1]);
          if (!Number.isInteger(at) || at < start || at >= bytes.length) throw new Error(`control: bad byte position ${at}`);
          bytes[at] ^= 0x5a;
          entry.sceneSnapshot = new Blob([bytes]);
          await new Promise((res, rej) => {
            const tx = db.transaction('models', 'readwrite');
            const store = tx.objectStore('models');
            if (store.keyPath === null) store.put(entry, ids[i]); else store.put(entry);
            tx.oncomplete = res; tx.onerror = () => rej(tx.error);
          });
          altered++;
          notes.push(`${target.key}@${at}:${(bytes[at] ^ 0x5a).toString(16)}->${bytes[at].toString(16)}`);
        }
        db.close();
        done({ altered, notes });
      } catch (e) { db.close(); done({ altered: 0, error: String(e) }); }
    };
  }), open);
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
  const written = new Set(opens.slice(0, index).flatMap((o) => (o.identity?.snapshots ?? []).filter((s) => s.kind === 'written' && s.sig).map((s) => s.sig)));
  const adopted = (warm.snapshots ?? []).filter((s) => s.kind === 'adopted');
  for (const s of adopted) {
    if (!s.sig) problems.push(`adopted snapshot not hashed (${s.error ?? 'no signature'})`);
    else if (!written.has(s.sig)) problems.push(`adopted ${s.sig} equals no snapshot an earlier open wrote (${written.size} written)`);
  }
  if (problems.length) return { verdict: `RESTORE MISMATCH vs cold: ${problems.join('; ')}`, match: false, adopted: adopted.length };
  return { verdict: `match (pieces = cold${adopted.length ? `, ${adopted.length} adopted snapshot(s) = written` : ', streamed (no snapshot adopted)'})`, match: true, adopted: adopted.length };
}

/**
 * A reopen lane's output verdict from its identity rows (one per side). Both sides must match their own
 * cold; the cold lanes' element-hash verdict carries the identity across sides. Null when no identity
 * row exists for the lane (the timed passes' verdict then stands). 'match' means: every reopen of the identity
 * pass restored its own cold output, on both sides; the cold lanes' element hashes chain it across sides.
 */
/**
 * A reopen lane's final output verdict: a RESTORE MISMATCH, CHANGED or VARIED seen in the timed samples wins; then the identity pass
 * (each reopen = its own cold) is a match only when the cold lane is a cross-side match too, so two builds with
 * different output never read as matching (review #9863). Null when no identity row exists for the lane.
 */
export function reopenOutputVerdict(identityVerdict, timedVerdict, coldVerdict) {
  // Positive evidence from the timed samples is never overwritten (review #9863).
  if (typeof timedVerdict === 'string' && /^(RESTORE MISMATCH|CHANGED|VARIED)/.test(timedVerdict)) return timedVerdict;
  if (identityVerdict === null || identityVerdict === undefined) return null;
  if (identityVerdict !== 'match') return identityVerdict;
  if (coldVerdict === 'match') return 'match';
  if (typeof coldVerdict === 'string' && (coldVerdict === 'CHANGED' || coldVerdict.startsWith('VARIED')))
    return `CHANGED (cold output ${coldVerdict} across sides; each reopen restored its own cold open)`;
  return `unverifiable (each reopen restored its own cold open, but the cold lane is ${coldVerdict ?? 'missing'}, so the sides are not linked)`;
}

export function laneIdentityVerdict(rows, lane) {
  // Each reopen's own status decides (identityRowReopens marks a reopen the sample failed at or after as UNVERIFIABLE);
  // an earlier clean reopen keeps its verdict when a later one failed (review #9863).
  const mine = rows.filter((r) => r.lane === 'identity' && r.reopens?.[lane]);
  if (mine.length === 0) return null;
  const bySide = Object.fromEntries(['base', 'branch'].map((side) => [side, mine.filter((r) => r.side === side).map((r) => r.reopens[lane])]));
  const verdicts = [...bySide.base, ...bySide.branch];
  if (verdicts.some((v) => v.verdict.startsWith('RESTORE MISMATCH'))) return `RESTORE MISMATCH (identity pass: ${verdicts.find((v) => v.verdict.startsWith('RESTORE')).verdict.slice(0, 200)})`;
  if (bySide.base.length === 0 || bySide.branch.length === 0) return 'unverifiable (identity pass missing on a side)';
  if (!verdicts.every((v) => v.match)) return `unverifiable (identity pass: ${verdicts.find((v) => !v.match).verdict.slice(0, 160)})`;
  return 'match';
}

/** The identity pass runs in round 0 unless the plan turns it off; it needs reopens to verify. */
/** The default-arm reopen lane whose identity rows a reopen lane uses: output identity is a property of the build and
 * the cache state, not of when the file was picked, so #9744's -early and -settled reopen arms share them. Null for others. */
export function identityLaneFor(lane) {
  const base = String(lane).replace(/-(early|settled)$/, '');
  return base === 'browser-warm1' || base === 'browser-warm' ? base : null;
}

export function identityWanted(plan, round) {
  return round === 0 && plan.identityPass !== false && (plan.warmOpens ?? 0) > 0 && plan.lanes.some((l) => identityLaneFor(l) !== null);
}

/** Each reopen lane of an identity sample with its verdict against the sample's own earlier opens. */
export function identityRowReopens(sample, warmOpens) {
  const opens = sample.meta?.identityOpens ?? [];
  const out = {};
  const n = warmOpens;
  for (let i = 1; i < opens.length; i++) {
    const lane = i === n ? 'browser-warm' : i === 1 ? 'browser-warm1' : null;
    if (!lane) continue;
    // A reopen the sample failed at or after (e.g. the final GPU-health check) is never a match (review #9863).
    const failed = sample.lanes?.[lane]?.ok === false;
    out[lane] = failed ? { verdict: `UNVERIFIABLE (identity sample failed: ${String(sample.lanes[lane].error ?? 'unknown').slice(0, 160)})`, match: false }
      : reopenIdentityVerdict(opens, i);
  }
  return out;
}

/** The recorded identity row: verdicts and layer signatures; per-element maps go to their own trace file. */
export function identityRow(common, sample, warmOpens, writeFile) {
  const opens = sample.meta?.identityOpens ?? [];
  writeFile(`${common.fixture}-${common.side}-r${common.round}-identity.json`, JSON.stringify(opens));
  const failed = Object.values(sample.lanes ?? {}).find((l) => l && l.ok === false && l.error);
  return { ...common, lane: 'identity', ok: !failed, error: failed?.error ?? null, reopens: identityRowReopens(sample, warmOpens),
    corrupted: sample.meta?.corrupted ?? null, query: sample.meta?.query ?? null,
    opens: opens.map(({ label, identity }) => ({ label, tap: identity?.tap ?? false, error: identity?.error ?? null,
      pieces: identity?.pieces ? { pieces: identity.pieces.pieces, elements: identity.pieces.elements, sig: identity.pieces.sig } : null,
      instancedEntities: identity?.instancedEntities ?? null, snapshots: identity?.snapshots ?? [] })) };
}
