/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Surface styling for `IfcCreator`: the default grey, named colour styles, and
 * the `IfcStyledItem` rows that bind them to representation items.
 *
 * Split out of `ifc-creator.ts` alongside the other emitter modules — this is
 * pure STEP assembly over maps the creator already holds.
 */

import { esc, num } from './ifc-creator-math.js';

/** The one creator hook these emitters need. */
export interface StyleContext {
  emit: (type: string, attrs: string) => number;
}

/** A per-element colour assignment, as `IfcCreator` records it. */
export interface ElementColor {
  name: string;
  rgb: [number, number, number];
}

/** A named `IfcSurfaceStyle` with the given RGB colour. */
export function emitColorStyle(name: string, rgb: readonly [number, number, number], ctx: StyleContext): number {
  const colourId = ctx.emit('IFCCOLOURRGB', `$,${num(rgb[0])},${num(rgb[1])},${num(rgb[2])}`);
  const renderingId = ctx.emit(
    'IFCSURFACESTYLERENDERING',
    `#${colourId},0.,$,$,$,$,IFCNORMALISEDRATIOMEASURE(0.5),IFCSPECULAREXPONENT(64.),.NOTDEFINED.`,
  );
  return ctx.emit('IFCSURFACESTYLE', `'${esc(name)}',.BOTH.,(#${renderingId})`);
}

/** The default `IfcSurfaceStyle` — warm concrete grey (RGB 0.75, 0.73, 0.68). */
export function emitDefaultStyle(ctx: StyleContext): number {
  return emitColorStyle('Default', [0.75, 0.73, 0.68], ctx);
}

/**
 * Bind a style to every representation item of every element.
 *
 * Identical colours share one `IfcSurfaceStyle`: without the cache, N elements
 * painted the same colour wrote N identical style trees, which is legal but
 * bloats the file and makes a diff between two exports unreadable.
 */
export function emitStyledItems(
  elementSolids: ReadonlyMap<number, readonly number[]>,
  elementColors: ReadonlyMap<number, ElementColor>,
  defaultStyleId: number,
  ctx: StyleContext,
): void {
  const styleCache = new Map<string, number>();
  for (const [elementId, solidIds] of elementSolids) {
    const color = elementColors.get(elementId);
    let styleId = defaultStyleId;
    if (color) {
      const key = `${color.name}|${color.rgb.join(',')}`;
      const cached = styleCache.get(key);
      if (cached !== undefined) {
        styleId = cached;
      } else {
        styleId = emitColorStyle(color.name, color.rgb, ctx);
        styleCache.set(key, styleId);
      }
    }
    for (const solidId of solidIds) {
      ctx.emit('IFCSTYLEDITEM', `#${solidId},(#${styleId}),$`);
    }
  }
}
