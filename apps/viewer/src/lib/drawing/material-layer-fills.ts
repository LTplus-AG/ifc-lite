/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Per-material fills for the layers of a cut element (#9296).
 *
 * The cut of a layered wall or slab comes back as one polygon per layer, each
 * carrying its layer's `IfcMaterial` id and the colour its mesh was drawn in.
 * A material with no colour of its own is drawn in the element's colour, so
 * every layer of such a wall filled identically and the build-up could not be
 * read off the drawing.
 *
 * Layers of ONE element that share a colour but not a material are told apart
 * here. Each gets a drafting fill for its material: by the material's name
 * where the name says what it is (brick, insulation, concrete, ...), and a
 * stable tone otherwise. Two materials of one element never end on the same
 * fill. A layer whose material has a colour of its own keeps it, and
 * `sourceColor` (what the 3D section cap reads) is never touched.
 *
 * This is a 2D drafting convention, like `IFC_TYPE_FILL_COLORS`, not 3D
 * appearance: no mesh colour changes.
 */

import type { Drawing2D, DrawingPolygon } from '@ifc-lite/drawing-2d';
import { entityName } from '@/lib/commands/modeling/authored-kinds';
import { useViewerStore, type ViewerState } from '@/store';

type Rgb = readonly [number, number, number];
type LayerPolygon = Pick<DrawingPolygon, 'entityId' | 'modelIndex' | 'color' | 'materialId'>;

const rgb = (hex: string): Rgb => [1, 3, 5].map((at) => Number.parseInt(hex.slice(at, at + 2), 16) / 255) as unknown as Rgb;

/** What a material's name says it is, and the fill a drawing gives that. First match wins. */
const NAMED_FILLS: ReadonlyArray<readonly [RegExp, Rgb]> = [
  [/insulat|d[aä]mm|isol|wool|wolle|\beps\b|\bxps\b|\bpir\b|foam/i, rgb('#f2d86b')],
  [/brick|masonry|block|ziegel|mauerwerk|klinker|brique|matton|laterizio/i, rgb('#c8765a')],
  [/plaster|render|stucco|gypsum|gips|putz|pl[aâ]tre|intonaco|enduit/i, rgb('#ece7dc')],
  [/concrete|beton|béton|calcestruzzo|cement|screed|estrich|mortar/i, rgb('#b4b7ba')],
  [/timber|wood|holz|bois|legno|\bosb\b|plywood|\bclt\b/i, rgb('#d9a866')],
  [/steel|metal|stahl|alumin|acier|acciaio/i, rgb('#8fa3b8')],
  [/glass|glas|verre|vetro/i, rgb('#a9d5e8')],
  [/stone|stein|pierre|pietra|granit|marble|tile|fliese|ceramic/i, rgb('#a89f91')],
  [/membrane|vapou?r|folie|bitum|waterproof|abdichtung/i, rgb('#5b6770')],
];

/** Fills for a material whose name says nothing a drawing can use: distinct, mid-light, readable under black linework. */
const TONES: readonly Rgb[] = ['#9db7c9', '#c9b79d', '#b3c99d', '#c99db3', '#9dc9c0', '#c0a3d6', '#d6c0a3', '#a3b8d6'].map(rgb);

function hash(text: string): number {
  let h = 2166136261;
  for (let i = 0; i < text.length; i++) h = Math.imul(h ^ text.charCodeAt(i), 16777619);
  return h >>> 0;
}

/** Colours closer than 1/1000 per channel are one fill; alpha is the polygon's own and not compared. */
const keyOf = (fill: readonly number[]): string => fill.slice(0, 3).map((v) => Math.round(v * 1000)).join(',');
const colorKey = (color: readonly number[] | undefined): string => (color ? keyOf(color) : 'none');

/**
 * The drafting fill for one material, avoiding every fill in `taken` (the
 * other layers of the same element). A named fill already taken (two bricks in
 * one wall) falls through to the tones; past the tones, the fill darkens.
 */
function fillFor(name: string | undefined, materialId: number, taken: ReadonlySet<string>): Rgb {
  const named = name ? NAMED_FILLS.find(([pattern]) => pattern.test(name))?.[1] : undefined;
  if (named && !taken.has(keyOf(named))) return named;
  const start = hash(name || String(materialId));
  for (let step = 0; step < TONES.length; step++) {
    const tone = TONES[(start + step) % TONES.length];
    if (!taken.has(keyOf(tone))) return tone;
  }
  let fill = TONES[start % TONES.length];
  while (taken.has(keyOf(fill))) fill = [fill[0] * 0.85, fill[1] * 0.85, fill[2] * 0.85];
  return fill;
}

/**
 * `polygons` with a per-material fill on every layer that shared its colour
 * with another material of the same element. Returns the input array itself
 * when nothing needed telling apart.
 */
export function withMaterialLayerFills<P extends LayerPolygon>(polygons: readonly P[], materialName: (polygon: P) => string | undefined): readonly P[] {
  const byElement = new Map<string, P[]>();
  for (const polygon of polygons) {
    if (polygon.materialId === undefined || !polygon.color) continue;
    const element = `${polygon.modelIndex}:${polygon.entityId}`;
    byElement.set(element, [...(byElement.get(element) ?? []), polygon]);
  }
  const fills = new Map<P, Rgb>();
  for (const layers of byElement.values()) {
    // One representative polygon per material, in drawing order.
    const materials = new Map<number, P>();
    for (const layer of layers) if (!materials.has(layer.materialId!)) materials.set(layer.materialId!, layer);
    if (materials.size < 2) continue;
    const users = new Map<string, number>();
    for (const layer of materials.values()) users.set(colorKey(layer.color), (users.get(colorKey(layer.color)) ?? 0) + 1);
    const taken = new Set<string>();
    for (const layer of materials.values()) if (users.get(colorKey(layer.color)) === 1) taken.add(colorKey(layer.color));
    const fillOf = new Map<number, Rgb>();
    for (const [materialId, layer] of materials) {
      if (users.get(colorKey(layer.color)) === 1) continue;
      const fill = fillFor(materialName(layer), materialId, taken);
      taken.add(keyOf(fill));
      fillOf.set(materialId, fill);
    }
    for (const layer of layers) {
      const fill = fillOf.get(layer.materialId!);
      if (fill) fills.set(layer, fill);
    }
  }
  if (fills.size === 0) return polygons;
  return polygons.map((polygon) => {
    const fill = fills.get(polygon);
    return fill ? { ...polygon, color: [fill[0], fill[1], fill[2], polygon.color?.[3] ?? 1] } : polygon;
  });
}

/** The live `Name` of the `IfcMaterial` a cut polygon's layer is made of, in the model the polygon's element belongs to. */
function materialNameIn(state: ViewerState, polygon: LayerPolygon): string | undefined {
  if (polygon.materialId === undefined) return undefined;
  // Single-model: the global id is the express id, and the one model owns it.
  const modelId = state.resolveGlobalIdFromModels(polygon.entityId)?.modelId ?? state.models.keys().next().value ?? '__legacy__';
  const dataStore = state.models.get(modelId)?.ifcDataStore ?? state.ifcDataStore;
  if (!dataStore) return undefined;
  return entityName({ dataStore, view: state.mutationViews.get(modelId) ?? null }, polygon.materialId) || undefined;
}

/** A generated drawing whose layered cuts fill per material (see the module doc). */
export function drawingWithMaterialLayerFills<D extends Pick<Drawing2D, 'cutPolygons'>>(drawing: D, state: ViewerState = useViewerStore.getState()): D {
  const cutPolygons = withMaterialLayerFills(drawing.cutPolygons, (polygon) => materialNameIn(state, polygon));
  return cutPolygons === drawing.cutPolygons ? drawing : { ...drawing, cutPolygons: [...cutPolygons] };
}
