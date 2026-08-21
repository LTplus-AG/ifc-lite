/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { hexToRgba } from '@ifc-lite/lens';
import type { ApplyStyleOptions, ApplyStyleResult, SurfaceStyleColor } from '@ifc-lite/create';
import type { BimBackend, EntityRef } from '../types.js';

/** One colour and the entities to paint with it. */
export interface ColorBatch {
  refs: EntityRef[];
  /** A hex string in any form `bim.viewer.colorize` takes, or channels in 0..1. */
  color: SurfaceStyleColor | string;
  /** `IfcSurfaceStyle.Name`, useful when the colour stands for a class. */
  name?: string;
}

/** Anything `hexToRgba` resolves: `#rgb`, `#rrggbb`, `#rrggbbaa`, with or without `#`. */
const HEX_COLOR = /^#?(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/;

/**
 * Resolve a colour to channels.
 *
 * Strings go through the same `hexToRgba` that `bim.viewer.colorize` uses, so
 * the two APIs accept exactly the same syntax rather than one of them rejecting
 * a string the other paints with.
 *
 * Two deliberate differences. The failure mode: `hexToRgba` degrades an
 * unparseable string to black, which is right for a transient overlay and wrong
 * here, where the result is written into the file and shipped, so a typo throws
 * rather than being baked in as black. And the alpha pair of an `#rrggbbaa`
 * string is honoured rather than discarded — the viewer takes alpha from its
 * own argument and ignores those digits, but here they are the only place a
 * caller using the string form can express transparency.
 */
function resolveColor(color: SurfaceStyleColor | string): SurfaceStyleColor {
  if (typeof color !== 'string') return color;
  const trimmed = color.trim();
  if (!HEX_COLOR.test(trimmed)) {
    throw new Error(
      `style: "${color}" is not a hex colour (#rgb, #rrggbb or #rrggbbaa). ` +
      'Pass { red, green, blue } channels in 0..1 for anything else.',
    );
  }
  const digits = trimmed.startsWith('#') ? trimmed.slice(1) : trimmed;
  const alpha = digits.length === 8 ? parseInt(digits.slice(6, 8), 16) / 255 : 1;
  const [red, green, blue] = hexToRgba(trimmed, alpha);
  return { red, green, blue, alpha };
}

/**
 * `bim.style` — colour that ends up in the exported IFC.
 *
 * `bim.viewer.colorize` paints the current view; the colour is an overlay and
 * is gone the moment the model is written out. This writes real
 * `IfcSurfaceStyle` / `IfcStyledItem` entities, so the file opens coloured
 * anywhere. Needs direct store access: the headless CLI and MCP contexts
 * implement it; a backend without the store, including the browser viewer's,
 * throws rather than silently doing nothing.
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
        'direct store access (use a headless context, not a remote transport).',
      );
    }
    return this.backend.style;
  }

  /** Colour these entities. Hex string, or channels in 0..1. */
  apply(
    refs: EntityRef[],
    color: SurfaceStyleColor | string,
    options?: ApplyStyleOptions & { name?: string },
  ): ApplyStyleResult {
    const { name, ...rest } = options ?? {};
    return this.applyAll([{ refs, color, name }], rest)[0];
  }

  /**
   * Colour several groups in one pass, the persistent counterpart to
   * `bim.viewer.colorizeAll`. Batches are applied in order, so a later batch
   * wins where two of them reach the same geometry.
   *
   * One call rather than a loop over `apply`: the "at most one IfcStyledItem
   * per representation item" rule has to hold across the whole pass, and the
   * index of already-styled geometry is built once instead of per batch.
   */
  applyAll(batches: ColorBatch[], options?: ApplyStyleOptions): ApplyStyleResult[] {
    return this.impl().applyColors(
      batches.map(batch => ({
        refs: batch.refs,
        color: resolveColor(batch.color),
        name: batch.name,
      })),
      options,
    );
  }
}
