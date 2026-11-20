/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Instanced shards a model drew before the backing tap started (#10264). The tap
 * never saw them, so it cannot back them: the model's instancing is lost at the
 * supply point it had when the tap started, and only a fresh supply after that
 * point, stated whole and drawn (`instanced-resupply.ts`), replaces them. The
 * shard-event comparison starts from the revision each model had at start, so
 * the historical gap neither blocks that fresh supply forever nor hides a later
 * shard the tap misses.
 */

import { instancedShardModelIds, instancedShardRevision } from '@/store/instancedShardModels';
import { supplyPoint, type SupplyPoint } from './instanced-resupply';

export class PreTapSupply {
  private readonly baseline = new Map<string, number>();
  private readonly lostAt = new Map<string, SupplyPoint>();

  constructor() {
    for (const id of instancedShardModelIds()) {
      const revision = instancedShardRevision(id);
      if (revision > 0) { this.baseline.set(id, revision); this.lostAt.set(id, supplyPoint(id)); }
    }
  }

  /** Shards noted for the model since the tap started that it never saw as events. */
  missed(modelId: string, events: number): boolean { return instancedShardRevision(modelId) > (this.baseline.get(modelId) ?? 0) + events; }

  /** Where the model's pre-tap instancing is lost, until a fresh supply is accepted whole. */
  lost(modelId: string): SupplyPoint | undefined { return this.lostAt.get(modelId); }

  resupplied(modelId: string): void { this.lostAt.delete(modelId); }
}
