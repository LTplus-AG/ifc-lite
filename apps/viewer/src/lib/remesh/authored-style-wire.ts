/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The style wire of what was authored this session. The model's own wire is a
 * prepass over the file's bytes, captured once per load, so an IfcStyledItem
 * written after that (a curtain wall's glazing) reaches the export but not the
 * re-mesh. This reads those items from the overlay in the same shape: the
 * styled representation item's id, then its colour as RGBA bytes.
 */

interface OverlayEntity {
  readonly type: string;
  readonly expressId: number;
  readonly attributes: readonly unknown[];
}

interface OverlayView {
  getNewEntities(): readonly OverlayEntity[];
  getNewEntity(expressId: number): OverlayEntity | null | undefined;
}

const refId = (value: unknown): number | null => {
  if (typeof value !== 'string' || !value.startsWith('#')) return null;
  const id = Number(value.slice(1));
  return Number.isInteger(id) ? id : null;
};

const real = (value: unknown): number | null => {
  if (typeof value === 'number') return value;
  const wrapped = (value as { real?: unknown } | null)?.real;
  return typeof wrapped === 'number' ? wrapped : null;
};

const toByte = (channel: number): number => Math.round(Math.min(1, Math.max(0, channel)) * 255);

/** The first style reference's shading colour, through IFC2X3's assignment when there is one. */
function shadingRgba(view: OverlayView, styled: OverlayEntity): [number, number, number, number] | null {
  const styles = styled.attributes[1];
  let style = view.getNewEntity(refId(Array.isArray(styles) ? styles[0] : null) ?? -1);
  if (style?.type === 'IfcPresentationStyleAssignment') {
    const inner = style.attributes[0];
    style = view.getNewEntity(refId(Array.isArray(inner) ? inner[0] : null) ?? -1);
  }
  if (style?.type !== 'IfcSurfaceStyle') return null;
  const parts = style.attributes[2];
  if (!Array.isArray(parts)) return null;
  for (const part of parts) {
    const shading = view.getNewEntity(refId(part) ?? -1);
    if (shading?.type !== 'IfcSurfaceStyleShading' && shading?.type !== 'IfcSurfaceStyleRendering') continue;
    const colour = view.getNewEntity(refId(shading.attributes[0]) ?? -1);
    if (colour?.type !== 'IfcColourRgb') continue;
    const [r, g, b] = [real(colour.attributes[1]), real(colour.attributes[2]), real(colour.attributes[3])];
    if (r === null || g === null || b === null) continue;
    return [toByte(r), toByte(g), toByte(b), toByte(1 - (real(shading.attributes[1]) ?? 0))];
  }
  return null;
}

/** Append the authored items among `keep` to a filtered wire; a file item keeps its own entry. */
export function withAuthoredStyles(
  wire: { styleIds: Uint32Array; styleColors: Uint8Array },
  view: OverlayView | null | undefined,
  keep: ReadonlySet<number>,
): { styleIds: Uint32Array; styleColors: Uint8Array } {
  if (!view) return wire;
  const known = new Set(wire.styleIds);
  const ids: number[] = [];
  const colors: number[] = [];
  for (const entity of view.getNewEntities()) {
    if (entity.type !== 'IfcStyledItem') continue;
    const item = refId(entity.attributes[0]);
    if (item === null || !keep.has(item) || known.has(item)) continue;
    const rgba = shadingRgba(view, entity);
    if (!rgba) continue;
    known.add(item);
    ids.push(item);
    colors.push(...rgba);
  }
  if (ids.length === 0) return wire;
  return {
    styleIds: Uint32Array.from([...wire.styleIds, ...ids]),
    styleColors: Uint8Array.from([...wire.styleColors, ...colors]),
  };
}
