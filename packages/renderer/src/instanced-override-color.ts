/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * How a colour override and X-Ray compose on one instanced occurrence.
 *
 * The two channels share the instance colour bytes, so whichever wrote last
 * would otherwise win. The rule is that the override owns RGB and the ghost
 * owns alpha: X-Ray is a stronger statement about visibility than a lens tint,
 * and the flat path resolves it the same way.
 *
 * It lives here because there are now two writers. `setInstancedColorOverrides`
 * applies it when the override changes, and `addInstancedShard` applies it to
 * occurrences that arrive AFTER an override was recorded (#3890) — a shard can
 * stream in long after the colour was chosen, and nothing re-derives the
 * overlay for it. Two copies of a composition rule held together by nothing but
 * proximity is how they drift.
 */

export function composeInstancedOverrideColor(
  rgba: readonly [number, number, number, number],
  ghosted: boolean,
  ghostAlpha: number,
): [number, number, number, number] {
  return ghosted ? [rgba[0], rgba[1], rgba[2], ghostAlpha] : [rgba[0], rgba[1], rgba[2], rgba[3]];
}

/** Restore every occurrence's own authored RGB while applying one alpha. */
export function writeOriginalInstancedColors(
  device: GPUDevice,
  occurrences: readonly { templateIndex: number; byteOffset: number; originalColor: readonly [number, number, number, number] }[],
  templates: readonly ({ instanceBuffer: GPUBuffer } | undefined)[],
  colorOffset: number,
  alpha: number,
): void {
  for (const occurrence of occurrences) {
    const buffer = templates[occurrence.templateIndex]?.instanceBuffer;
    if (!buffer) continue;
    const color = occurrence.originalColor;
    device.queue.writeBuffer(
      buffer,
      occurrence.byteOffset + colorOffset,
      new Float32Array([color[0], color[1], color[2], alpha]),
    );
  }
}
