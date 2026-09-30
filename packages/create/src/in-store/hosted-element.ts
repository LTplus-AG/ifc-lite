/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/** Params-to-commit core for hosted placement (#6232 D5). Hosts supply their
 * editor and history/remesh policy; the IFC graph and refusal rules live here. */
import type { StoreEditor, MutablePropertyView } from '@ifc-lite/mutations';
import type { IfcDataStore } from '@ifc-lite/parser';
import { toNativeLength, type HostAnchor, type HostBounds } from './anchor.js';
import { assertPositiveFinite } from './_emit-helpers.js';
import { addOpeningToStore, type OpeningInStoreParams } from './opening.js';
import {
  addHostedDoorToStore, addHostedWindowToStore,
  type HostedDoorInStoreParams, type HostedWindowInStoreParams,
} from './hosted-fill.js';
import { readHostedFill, type HostedFillRead } from './hosted-fill-read.js';
import { AnchorEntityReader } from './resolve-anchor.js';
import { placedBodyExtent, resolveHostAnchor } from './resolve-host.js';
import { assertHostedGlobalIdAvailable } from './hosted-global-id.js';

export type HostedElementInStoreSpec =
  | { readonly kind: 'opening'; readonly params: OpeningInStoreParams }
  | { readonly kind: 'door'; readonly params: HostedDoorInStoreParams }
  | { readonly kind: 'window'; readonly params: HostedWindowInStoreParams };

export interface HostedElementInStoreResult {
  readonly expressId: number;
  readonly openingId: number;
  readonly hostId: number;
}

export interface HostedOpeningExtent extends HostedFillRead {
  /** Cut bounds in the host's placement frame, in the file's native units. */
  readonly bounds: HostBounds;
}

/** Effective void relationships, including this session's creations, edits
 * and deletions. Unreadable placement/geometry is reported rather than guessed. */
export function readHostOpeningExtents(
  store: IfcDataStore,
  hostId: number,
  view?: MutablePropertyView | null,
): { cuts: HostedOpeningExtent[]; unreadable: number[] } {
  const reader = new AnchorEntityReader(store, view);
  const cuts: HostedOpeningExtent[] = [];
  const unreadable: number[] = [];
  for (const id of reader.ids('IFCRELVOIDSELEMENT')) {
    const rel = reader.entity(id);
    if (!rel) { unreadable.push(id); continue; }
    const relatingHost = refId(rel.attributes[4]);
    // An unreadable host reference cannot establish that this cut belongs to
    // a different wall, so fail conservatively instead of skipping it.
    if (relatingHost === null) { unreadable.push(id); continue; }
    if (relatingHost !== hostId) continue;
    const openingId = refId(rel.attributes[5]);
    if (openingId === null) { unreadable.push(id); continue; }
    const fill = readHostedFill(store, openingId, view);
    const bounds = fill ? placedBodyExtent(store, openingId, view) : null;
    if (!fill || fill.hostId !== hostId || !bounds) unreadable.push(openingId);
    else cuts.push({ ...fill, bounds });
  }
  return { cuts, unreadable };
}

function refId(value: unknown): number | null {
  if (typeof value === 'number' && Number.isInteger(value) && value > 0) return value;
  return typeof value === 'string' && /^#[1-9][0-9]*$/.test(value) ? Number(value.slice(1)) : null;
}

function validateWallCut(store: IfcDataStore, view: MutablePropertyView, host: HostAnchor, spec: HostedElementInStoreSpec): void {
  if (host.hostKind !== 'wall') return; // Slab openings retain their existing builder contract.
  const params = spec.params;
  if (!('Offset' in params)) throw new Error('Hosted wall placement requires Offset, Width and Height');
  assertPositiveFinite([params.Width, params.Height], 'Hosted wall placement: Width and Height must be positive');
  const sill = params.Sill ?? 0;
  if (!Number.isFinite(params.Offset) || !Number.isFinite(sill)) throw new Error('Hosted wall placement: Offset and Sill must be finite');
  const bounds = host.hostBounds;
  if (!bounds) throw new Error(`The body of host #${host.hostId} cannot be read, so hosted placement is refused`);
  const x = toNativeLength(host, params.Offset), w = toNativeLength(host, params.Width);
  const z = toNativeLength(host, sill), h = toNativeLength(host, params.Height);
  validateWallOpeningBounds(store, view, host, {
    min: [x - w / 2, bounds.min[1], z], max: [x + w / 2, bounds.max[1], z + h],
  });
}

/** Package-private fit/overlap decision shared by placement and edits. The
 * selected cut alone is excluded; every other unreadable cut still refuses. */
export function validateWallOpeningBounds(
  store: IfcDataStore,
  view: MutablePropertyView,
  host: HostAnchor,
  proposed: HostBounds,
  excludeOpeningId?: number,
): void {
  if (host.hostKind !== 'wall') return;
  if ([...proposed.min, ...proposed.max].some(value => !Number.isFinite(value))
    || proposed.min.some((value, axis) => value >= proposed.max[axis])) {
    throw new Error('Hosted opening bounds must be finite with positive dimensions');
  }
  const bounds = host.hostBounds;
  if (!bounds) throw new Error(`The body of host #${host.hostId} cannot be read, so hosted placement is refused`);
  const eps = toNativeLength(host, 1e-6);
  if (proposed.min[0] < bounds.min[0] - eps || proposed.max[0] > bounds.max[0] + eps
    || proposed.min[2] < bounds.min[2] - eps || proposed.max[2] > bounds.max[2] + eps) {
    throw new Error("It doesn't fit in this wall: change its offset or sill");
  }
  const existing = readHostOpeningExtents(store, host.hostId, view);
  if (existing.unreadable.length) {
    throw new Error(`Opening geometry ${existing.unreadable.map(id => `#${id}`).join(', ')} cannot be read, so hosted placement is refused`);
  }
  const overlap = existing.cuts.find(({ openingId, bounds: cut }) => openingId !== excludeOpeningId
    && Math.min(proposed.max[0], cut.max[0]) - Math.max(proposed.min[0], cut.min[0]) > eps
    && Math.min(proposed.max[2], cut.max[2]) - Math.max(proposed.min[2], cut.min[2]) > eps
    && Math.min(bounds.max[1], proposed.max[1], cut.max[1]) - Math.max(bounds.min[1], proposed.min[1], cut.min[1]) > eps);
  if (overlap) throw new Error(`The new opening overlaps opening #${overlap.openingId} in wall #${host.hostId}`);
}

/** Write an opening or wall-hosted filling in one atomic overlay operation.
 * The viewer, SDK and MCP share this core; callers group its mutation records
 * into their own undo batch. Every refusal leaves the overlay unchanged. */
export function addHostedElementInStore(
  store: IfcDataStore,
  editor: StoreEditor,
  hostId: number,
  spec: HostedElementInStoreSpec,
): HostedElementInStoreResult {
  const schema = store.schemaVersion ?? 'IFC4';
  if (!['IFC2X3', 'IFC4', 'IFC4X3'].includes(schema)) {
    throw new Error(`Hosted placement supports IFC2X3, IFC4 and IFC4X3 only; ${schema} is refused`);
  }
  return editor.runAtomic(draft => {
    const view = draft.getMutationView();
    if (spec.params.GlobalId !== undefined) {
      assertHostedGlobalIdAvailable(store, view, spec.params.GlobalId);
    }
    const host = resolveHostAnchor(store, hostId, view);
    validateWallCut(store, view, host, spec);
    if (spec.kind === 'opening') {
      const opening = addOpeningToStore(draft, host, spec.params);
      return { expressId: opening.openingId, openingId: opening.openingId, hostId };
    }
    const fill = spec.kind === 'door'
      ? addHostedDoorToStore(draft, host, spec.params)
      : addHostedWindowToStore(draft, host, spec.params);
    return { expressId: fill.fillingId, openingId: fill.opening.openingId, hostId };
  });
}
