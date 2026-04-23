/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Deterministic 22-char GlobalId from an arbitrary seed.
 *
 * Used anywhere we need a stable IFC-style GlobalId that (a) is
 * reproducible across runs of the same input and (b) is unique enough
 * that a realistic number of inputs won't collide. Three call sites
 * rely on this today:
 *   • `@ifc-lite/parser` schedule-serializer — fallback when an
 *     upstream caller didn't supply an explicit GlobalId for a task /
 *     sequence / work schedule
 *   • `@ifc-lite/viewer` generate-schedule — every generated task,
 *     work schedule, and sequence gets a seed-derived id
 *   • `@ifc-lite/viewer` scheduleSlice — `addTask()` mints a fresh id
 *     for user-authored tasks
 *
 * History: the single-accumulator 32-bit FNV-1a we shipped first
 * collided on realistic 30-task schedules because the 22-char output
 * carried only ~32 bits of real entropy. A two-stream version reduced
 * but didn't eliminate the problem — seeds differing in just a trailing
 * character still collided at ~100 inputs because both streams'
 * finalizers correlated too strongly on near-identical prefixes.
 *
 * Current: four independent 32-bit rolling hashes (128 bits of state),
 * each seeded with a different basis and mixing the input char with a
 * different rotation, then cross-mixed so every final stream depends on
 * every other. Output cycles through the four streams so the 22-char
 * GlobalId is stamped from all four. Tested collision-free on every
 * adversarial input we've thrown at it (200 sequential storeys, 256
 * single-char deltas, realistic "314.x" series, mixed-length inputs).
 *
 * Round-tripping: constants are hard-coded and seed strings are derived
 * deterministically from their source context, so identical seeds
 * always produce identical outputs across runs and processes.
 *
 * When adding a new call site: always route through this module. The
 * previous convention of "copy-paste but keep byte-identical" shipped
 * at least one drift bug; having a single source of truth avoids that
 * class of mistake entirely.
 */

const GLOBAL_ID_CHARS =
  '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz_$';

export function deterministicGlobalId(seed: string): string {
  let h0 = 0x811c9dc5 >>> 0;
  let h1 = 0x9e3779b9 >>> 0;
  let h2 = 0x6c078965 >>> 0;
  let h3 = 0xb5297a4d >>> 0;
  for (let i = 0; i < seed.length; i++) {
    const c = seed.charCodeAt(i);
    h0 = Math.imul(h0 ^ c, 0x01000193) >>> 0;
    h1 = Math.imul(h1 ^ c ^ (h1 >>> 11), 0x85ebca6b) >>> 0;
    h2 = Math.imul(h2 + c + (h2 >>> 7), 0xc2b2ae35) >>> 0;
    h3 = Math.imul(h3 ^ ((c << 3) | (c >>> 5)) ^ (h3 >>> 13), 0x27d4eb2f) >>> 0;
  }
  const mix = (x: number, y: number): number =>
    Math.imul((x ^ y) + ((x >>> 7) | (y << 25)), 0x85ebca6b) >>> 0;
  const m0 = mix(h0, h2);
  const m1 = mix(h1, h3);
  const m2 = mix(h2, m1);
  const m3 = mix(h3, m0);
  const pool: number[] = [m0, m1, m2, m3];
  let out = '';
  for (let i = 0; i < 22; i++) {
    const idx = i & 3;
    const src = pool[idx];
    out += GLOBAL_ID_CHARS[src & 0x3f];
    pool[idx] = Math.imul(src ^ ((i + 1) * 0x45d9f3b), 0x01000193) >>> 0;
  }
  return out;
}
