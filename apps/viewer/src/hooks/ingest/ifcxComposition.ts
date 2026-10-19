/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { detectFormat, type IfcDataStore, type parseFederatedIfcx } from '@ifc-lite/parser';
import { placementSourceIdentity } from '@/lib/model-placement/source-identity.js';

export interface IfcxBuffer { buffer: ArrayBuffer; name: string }
export type IfcxSource = File | IfcxBuffer;
type Composition = Awaited<ReturnType<typeof parseFederatedIfcx>>;

export interface IfcxDataStore extends IfcDataStore {
  schemaVersion: 'IFC5';
  _federatedLayers?: Array<{ id: string; name: string; enabled: boolean }>;
  _federatedBuffers?: IfcxBuffer[];
  _compositionStats?: Composition['compositionStats'];
  _layerInfo?: Array<{ id: string; name: string; meshCount: number }>;
}

/** Snapshot every source under the canonical loader's cancellation owner. */
export async function prepareIfcxSources(sources: readonly IfcxSource[], isStale: () => boolean) {
  const buffers: IfcxBuffer[] = [];
  const identities: Array<{ name: string; hash: string }> = [];
  for (const source of sources) {
    const buffer = 'buffer' in source ? source.buffer.slice(0) : await source.arrayBuffer();
    if (isStale()) return undefined;
    if (detectFormat(buffer) !== 'ifcx') throw new Error(`File "${source.name}" is not an IFCX file.`);
    buffers.push({ buffer, name: source.name });
    // Composition identity includes source order and names as well as every byte.
    const digest = await crypto.subtle.digest('SHA-256', buffer);
    if (isStale()) return undefined;
    identities.push({ name: source.name, hash: [...new Uint8Array(digest)].map(b => b.toString(16).padStart(2, '0')).join('') });
  }
  if (buffers.length === 0) throw new Error('At least one IFCX file is required');
  const identity = new TextEncoder().encode(JSON.stringify(identities));
  const hash = await placementSourceIdentity(new File([identity], 'composition'), isStale, identity);
  return { buffers, identity, hash };
}

export function attachIfcxComposition(
  store: IfcDataStore,
  result: Composition | undefined,
  buffers?: IfcxBuffer[],
): IfcDataStore {
  if (!buffers || !result?.layerStack) return store;
  return Object.assign(store, {
    _federatedLayers: result.layerStack.getLayers().map(({ id, name, enabled }) => ({ id, name, enabled })),
    // Own retained originals independently of the parse/store source buffer.
    _federatedBuffers: buffers.map(({ buffer, name }) => ({ buffer: buffer.slice(0), name })),
    _compositionStats: result.compositionStats,
  });
}
