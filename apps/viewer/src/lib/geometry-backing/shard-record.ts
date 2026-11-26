/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Backing records for GPU-instanced geometry. The flat store mesh list does
 * not contain instanced occurrences, so exports and device recovery need the
 * decoded shard itself: template topology plus every occurrence's transform,
 * colour, item and finish. Field lists are exhaustive at compile time, like
 * `mesh-record.ts`, and unknown runtime fields are refused.
 */

import type { DecodedInstance, DecodedInstancedShard, DecodedInstancedTemplate } from '@ifc-lite/geometry';
import { UnsupportedBackingFieldError } from './mesh-record';

const SHARD_FIELDS = { templates: true, instances: true, carriesItemIds: true, carriesFinishes: true, templateKeys: true } as const satisfies Record<keyof DecodedInstancedShard, true>;
const TEMPLATE_FIELDS = { positions: true, normals: true, indices: true, origin: true } as const satisfies Record<keyof DecodedInstancedTemplate, true>;
const INSTANCE_FIELDS = {
  templateIndex: true, entityId: true, color: true, transform: true, itemId: true, metallic: true, roughness: true,
} as const satisfies Record<keyof DecodedInstance, true>;

/** Structured-clone image of one shard; typed arrays are exact standalone copies. */
export type ShardRecord = DecodedInstancedShard;

function refuseUnknown(value: object, known: object, what: string): void {
  for (const key of Object.keys(value)) {
    if (!Object.prototype.hasOwnProperty.call(known, key)) {
      throw new UnsupportedBackingFieldError(`Instanced ${what} carries unknown field "${key}"`);
    }
  }
}

export interface EncodedShard { record: ShardRecord; bytes: number; entityIds: Uint32Array }

export function encodeShardRecord(shard: DecodedInstancedShard): EncodedShard {
  refuseUnknown(shard, SHARD_FIELDS, 'shard');
  let bytes = 0;
  const templates = shard.templates.map((template) => {
    refuseUnknown(template, TEMPLATE_FIELDS, 'template');
    const copy: DecodedInstancedTemplate = {
      positions: template.positions.slice(), normals: template.normals.slice(),
      indices: template.indices.slice(), origin: [...template.origin],
    };
    bytes += copy.positions.byteLength + copy.normals.byteLength + copy.indices.byteLength;
    return copy;
  });
  const entities = new Set<number>();
  const instances = shard.instances.map((instance) => {
    refuseUnknown(instance, INSTANCE_FIELDS, 'occurrence');
    if (!Number.isInteger(instance.templateIndex) || instance.templateIndex < 0 || instance.templateIndex >= templates.length) {
      throw new RangeError(`Instanced occurrence of ${instance.entityId} names missing template ${instance.templateIndex}`);
    }
    entities.add(instance.entityId);
    const copy: DecodedInstance = {
      templateIndex: instance.templateIndex, entityId: instance.entityId,
      color: [...instance.color], transform: instance.transform.slice(),
      ...(instance.itemId !== undefined ? { itemId: instance.itemId } : {}),
      ...(instance.metallic !== undefined ? { metallic: instance.metallic } : {}),
      ...(instance.roughness !== undefined ? { roughness: instance.roughness } : {}),
    };
    bytes += copy.transform.byteLength + 64;
    return copy;
  });
  const record: ShardRecord = {
    templates, instances, carriesItemIds: shard.carriesItemIds,
    ...(shard.carriesFinishes !== undefined ? { carriesFinishes: shard.carriesFinishes } : {}),
    // Keyed records (global instance plan) rejoin their model-wide slot on replay.
    ...(shard.templateKeys !== undefined ? { templateKeys: [...shard.templateKeys] } : {}),
  };
  return { record, bytes, entityIds: Uint32Array.from([...entities].sort((a, b) => a - b)) };
}

/** Shard records decode to themselves: structured clone already rebuilt them. */
export function shardRecordBytes(record: ShardRecord): number {
  let bytes = 0;
  for (const template of record.templates) {
    bytes += template.positions.byteLength + template.normals.byteLength + template.indices.byteLength;
  }
  return bytes + record.instances.length * 128;
}
