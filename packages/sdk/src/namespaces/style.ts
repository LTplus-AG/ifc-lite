/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { ApplyStyleResult, SurfaceStyleColor } from '@ifc-lite/create';
import type { BimBackend, EntityRef } from '../types.js';

export interface ApplyColorOptions {
  /** `IfcSurfaceStyle.Name`, useful when the colour stands for a class. */
  name?: string;
  /** Replace a style the geometry already carries. Default `true`. */
  replaceExisting?: boolean;
}

/** One colour and the entities to paint with it. */
export interface ColorBatch {
  refs: EntityRef[];
  color: SurfaceStyleColor | string;
  name?: string;
}

/**
 * `bim.style` — colour that ends up in the exported IFC.
 *
 * `bim.viewer.colorize` paints the current view; the colour is an overlay and
 * is gone the moment the model is written out. This writes real
 * `IfcSurfaceStyle` / `IfcStyledItem` entities, so the file opens coloured
 * anywhere. Available on local and headless contexts, which have direct store
 * access; a remote backend throws.
 *
 * @example
 * bim.style.apply(bim.query().byType('IfcDuctSegment').refs(), '#9caec9');
 * const ifc = bim.export.ifc([], { schema: 'IFC4' }); // carries the colour
 */
export class StyleNamespace {
  constructor(private backend: BimBackend) {}

  private impl() {
    if (!this.backend.style) {
      throw new Error(
        'style: not available on this backend — persistent colouring needs ' +
        'direct store access (use a headless/local context, not a remote transport).',
      );
    }
    return this.backend.style;
  }

  /** Colour these entities. `color` is `#rgb`, `#rrggbb`, or channels in 0..1. */
  apply(
    refs: EntityRef[],
    color: SurfaceStyleColor | string,
    options?: ApplyColorOptions,
  ): ApplyStyleResult {
    return this.impl().applyColor(refs, color, options);
  }

  /**
   * Colour several groups in one pass, the persistent counterpart to
   * `bim.viewer.colorizeAll`. Batches are applied in order, so a later batch
   * wins where two of them name the same geometry.
   */
  applyAll(batches: ColorBatch[], options?: ApplyColorOptions): ApplyStyleResult[] {
    return batches.map(batch =>
      this.impl().applyColor(batch.refs, batch.color, { ...options, name: batch.name ?? options?.name }),
    );
  }
}
