/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { IfcEntity } from '@ifc-lite/data';
import type { EntityByIdIndex } from './columnar-parser-indexes.js';
import { EntityExtractor } from './entity-extractor.js';

interface EntityLookup {
  byId: EntityByIdIndex;
  byType: Map<string, number[]> | { get(key: string): number[] | undefined };
}

export class BufferEntitySource {
  private extractor: EntityExtractor;
  private index: EntityLookup;

  constructor(source: Uint8Array, index: EntityLookup) {
    this.extractor = new EntityExtractor(source);
    this.index = index;
  }

  getEntity(expressId: number): IfcEntity | null {
    const ref = this.index.byId.get(expressId);
    if (!ref) return null;
    return this.extractor.extractEntity(ref);
  }

  getEntitiesByType(typeName: string): IfcEntity[] {
    const ids = this.index.byType.get(typeName.toUpperCase()) ?? [];
    const result: IfcEntity[] = [];
    for (const id of ids) {
      const entity = this.getEntity(id);
      if (entity) result.push(entity);
    }
    return result;
  }
}
