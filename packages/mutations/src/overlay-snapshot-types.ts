/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import type { PropertySet, QuantitySet } from '@ifc-lite/data';
import type { AttributeMutation, EntityTypeMutation, IfcAttributeValue, Mutation, NewEntity, PropertyMutation, QuantityMutation } from './types.js';

export type PropertySnapshotRow = [number, string, string, PropertyMutation];
export type QuantitySnapshotRow = [number, string, string, QuantityMutation];

/** Package-owned rows retained when a created entity is deleted, for undo. */
export interface ForgottenEntityOverlayV1 {
  properties: PropertySnapshotRow[];
  quantities: QuantitySnapshotRow[];
  attributes: Array<[number, string, AttributeMutation]>;
  positional: Array<[number, IfcAttributeValue]>;
  retype: EntityTypeMutation | null;
  createdSets: { property: PropertySet[]; quantity: QuantitySet[] };
  deletedSets: { property: string[]; quantity: string[] };
  journal: Mutation[];
}

/** Host-owned undo state. GPU resources and Revert registries are excluded. */
export interface OverlaySnapshotHistory {
  undo: string[];
  redo: string[];
  groups: Array<[string, string]>;
  parked: NewEntity[];
}

/** Stable logical rows; private map keys and derived indices are not persisted. */
export interface OverlaySnapshotV1 {
  format: 'ifc-lite/overlay-snapshot';
  version: 1;
  source: { contentHash: string; schema?: string };
  createdAt: string;
  /** First unallocated EXPRESS ID (the public allocator cursor). */
  nextExpressId: number;
  state: {
    properties: PropertySnapshotRow[];
    quantities: QuantitySnapshotRow[];
    attributes: Array<[number, string, AttributeMutation]>;
    positional: Array<[number, number, IfcAttributeValue]>;
    retypes: Array<[number, EntityTypeMutation]>;
    createdSets: { property: Array<[number, PropertySet]>; quantity: Array<[number, QuantitySet]> };
    deletedSets: { property: Array<[number, string]>; quantity: Array<[number, string]> };
    createdEntities: NewEntity[];
    tombstones: number[];
    aliases: Array<[number, number]>;
    forgotten: Array<{ expressId: number; rows: ForgottenEntityOverlayV1 | null }>;
  };
  journal: Mutation[];
  history?: OverlaySnapshotHistory;
}

export interface OverlaySnapshotOptions {
  /** Digest of ALL source bytes, computed by the caller; sampled cache keys are unsuitable. */
  sourceContentHash: string;
  schema?: string;
  history?: OverlaySnapshotHistory;
}
export interface OverlayRestoreOptions {
  sourceContentHash: string;
  replace?: boolean;
  /** UTF-8 input limit, checked before JSON.parse; defaults to 64 MiB. */
  maxBytes?: number;
}
export interface OverlayRestoreResult {
  history?: OverlaySnapshotHistory;
  historyDroppedReason?: string;
}
