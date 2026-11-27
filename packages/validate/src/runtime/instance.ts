/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { Model } from './model.js';
import type { ResolvedEntity } from './schema-runtime.js';
import type { Value } from './values.js';

/**
 * An entity instance: either backed by a model record (decoded on first
 * access) or transient, built by an EXPRESS entity constructor inside a
 * compiled function. Transient instances hold resolved values and may be
 * assigned to; model-backed ones never change.
 */
export class EntityInstance {
  private values: Value[] | undefined;

  constructor(
    readonly model: Model | undefined,
    readonly id: number,
    readonly entity: ResolvedEntity,
    values?: Value[],
    readonly transient = false,
  ) {
    this.values = values;
  }

  get attributes(): Value[] {
    if (!this.values) this.values = this.model ? this.model.decode(this.id) : [];
    return this.values;
  }

  toString(): string {
    return this.transient ? `${this.entity.name}(transient)` : `#${this.id}=${this.entity.name}`;
  }
}
