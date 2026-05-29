/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Entity index builder - creates fast lookup structures
 *
 * @deprecated Legacy eager-parse helper. New code should use
 * `scanIfcEntities()` plus `CompactEntityIndexBuilder`/`parseColumnar()`.
 */

import type { EntityRef, EntityIndex } from './types.js';

export class EntityIndexBuilder {
  private byId: Map<number, EntityRef> = new Map();
  private byType: Map<string, number[]> = new Map();

  addEntity(ref: EntityRef): void {
    this.byId.set(ref.expressId, ref);

    // Add to type index
    let typeList = this.byType.get(ref.type);
    if (!typeList) {
      typeList = [];
      this.byType.set(ref.type, typeList);
    }
    typeList.push(ref.expressId);
  }

  build(): EntityIndex {
    return {
      byId: this.byId,
      byType: this.byType,
    };
  }
}
