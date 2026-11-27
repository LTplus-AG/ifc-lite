/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
const pending = new WeakMap<GPUCommandEncoder, GPUCommandBuffer>();
export function setOpaqueVisibilityCommands(encoder: GPUCommandEncoder, commands: GPUCommandBuffer): void { pending.set(encoder, commands); }
const leading = new WeakMap<GPUCommandEncoder, GPUCommandBuffer>();
/** Work that must run before everything else of `encoder`'s frame, the opaque-visibility prepass included (a GPU instance cull). */
export function setFrameLeadCommands(encoder: GPUCommandEncoder, commands: GPUCommandBuffer): void { leading.set(encoder, commands); }
export function takeOpaqueVisibilityCommands(encoder: GPUCommandEncoder): GPUCommandBuffer[] {
  const lead = leading.get(encoder), commands = pending.get(encoder); leading.delete(encoder); pending.delete(encoder);
  return [...(lead ? [lead] : []), ...(commands ? [commands] : [])];
}
