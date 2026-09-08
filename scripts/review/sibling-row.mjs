/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * THE SINGLE TEMPLATE for a rendered sibling row -- charged against the budget
 * in `build-context-pack.mjs`'s `buildPack` and rendered into the prompt in
 * `run-reviewer.mjs`'s `buildPrompt`. #3732: those two used to recompute the
 * same template independently, and the charge was `Buffer.byteLength(h.text,
 * 'utf8') + 120` -- `h.key` never entered it, even though the render puts
 * `JSON.stringify(h.key)` on the wire. `h.key` is unbounded: `searchKeys`'s
 * identifier branch (`/[A-Za-z_$][A-Za-z0-9_$]{4,}/g`) has no upper length
 * bound (only the quoted-string branch is capped, at 60 chars), so a long
 * token -- a base64 constant, a minified bundle line -- could become an
 * arbitrarily long key. `rank()`'s length bonus (`Math.min(30, h.key.length *
 * 2)`) saturates at 30, but a cap on the SCORE a key earns is not a cap on the
 * BYTES it costs once rendered, so the pack could emit more than it had
 * charged itself for.
 *
 * One function, imported by both the charge and the render, makes that
 * divergence structurally impossible rather than merely fixed once: whatever
 * this returns is exactly what both sides agree the row costs.
 */
export function renderSiblingRow(h) {
  return `--- SIBLING: ${h.path}:${h.line} (key ${JSON.stringify(h.key)})\n${h.text}`;
}

/**
 * Bytes the `\n\n` join between sibling rows adds beyond what
 * `renderSiblingRow` itself returns. Charged once per row -- so the very last
 * row (which the join never follows) is overcharged by 2 bytes -- rather than
 * once for the whole section, keeping this a simple per-item loop like every
 * other charge in `buildPack`.
 */
export const SIBLING_ROW_JOIN_MARGIN = 2;
