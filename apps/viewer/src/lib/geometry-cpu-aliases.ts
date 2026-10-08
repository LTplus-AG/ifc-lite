/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { MeshData } from '@ifc-lite/geometry';
import { meshCpuBuffers, rememberCpuMeshBuffers } from './geometry-cpu-buffers';

type Aliases = Set<WeakRef<MeshData>>;
const copies = new WeakMap<MeshData, { aliases: Aliases; reference: WeakRef<MeshData> }>();
// Registry keys and members are weak; finalizer holdings use weak group
// references. No CPU buffer is retained. Pruning on registration/release
// also removes collected members without waiting for finalization (#6584).
const collected = new FinalizationRegistry<{ aliases: WeakRef<Aliases>; reference: WeakRef<MeshData> }>(
  ({ aliases, reference }) => { aliases.deref()?.delete(reference); },
);

function prune(aliases: Aliases): void {
  for (const reference of aliases) if (!reference.deref()) {
    aliases.delete(reference);
    collected.unregister(reference);
  }
}

function remember(mesh: MeshData, aliases: Aliases): void {
  const prior = copies.get(mesh);
  if (prior?.aliases === aliases) return;
  if (prior) {
    prior.aliases.delete(prior.reference);
    collected.unregister(prior.reference);
  }
  const reference = new WeakRef(mesh);
  copies.set(mesh, { aliases, reference });
  aliases.add(reference);
  collected.register(mesh, { aliases: new WeakRef(aliases), reference }, reference);
}

/** Track the actual shallow-copy seam, including immutable recolours. */
export function registerCpuMeshCopy(source: MeshData, copy: MeshData): void {
  if (source === copy) return;
  const sourceBuffers = meshCpuBuffers(source);
  const copyBuffers = meshCpuBuffers(copy);
  const sharesBuffers = [...copyBuffers].some(buffer => sourceBuffers.has(buffer));
  if (!sharesBuffers) return;
  rememberCpuMeshBuffers(source, sourceBuffers);
  rememberCpuMeshBuffers(copy, copyBuffers);
  const aliases = copies.get(source)?.aliases ?? new Set<WeakRef<MeshData>>();
  prune(aliases);
  remember(source, aliases);
  remember(copy, aliases);
}

/** Yield live copies; no cached wrapper/source array needs to be retained. */
export function* cpuMeshAliases(mesh: MeshData): Iterable<MeshData> {
  const aliases = copies.get(mesh)?.aliases;
  if (!aliases) { yield mesh; return; }
  prune(aliases);
  for (const reference of aliases) {
    const alias = reference.deref();
    if (alias) yield alias;
  }
}
