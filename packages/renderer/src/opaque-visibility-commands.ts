/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
const pending = new WeakMap<GPUCommandEncoder, GPUCommandBuffer>();
export function setOpaqueVisibilityCommands(encoder: GPUCommandEncoder, commands: GPUCommandBuffer): void { pending.set(encoder, commands); }
export function takeOpaqueVisibilityCommands(encoder: GPUCommandEncoder): GPUCommandBuffer[] {
  const commands = pending.get(encoder); pending.delete(encoder); return commands ? [commands] : [];
}
