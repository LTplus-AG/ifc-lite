/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/** Shared hosted size/position commit (#6232). Resize the actual occurrence's
 * geometry and its cut together, preserving the source's topology and style.
 * Placement, movement and resize share one conservative fit/overlap decision. */
import type { IfcDataStore } from '@ifc-lite/parser';
import type { MutablePropertyView, StoreEditor } from '@ifc-lite/mutations';
import { fromNativeLength, toNativeLength, type HostBounds } from './anchor.js';
import { AnchorEntityReader } from './resolve-anchor.js';
import { localBodyExtent, placedBodyExtent, resolveHostAnchor } from './resolve-host.js';
import { readHostedFill, type HostedFillRead } from './hosted-fill-read.js';
import { validateWallOpeningBounds } from './hosted-element.js';
import { scaleHostedShape } from './hosted-shape-edit.js';
import { placementInAncestor, refId, transformBounds, type Frame3, type Vec3 } from './host-geometry-frame.js';
import { safeLengthUnitScale } from './length-unit-scale.js';

export interface HostedElementSize {
  /** Effective IfcDoor / IfcWindow dimension, metres. Geometry supplies the
   * dimension when the optional EXPRESS attribute is omitted. */
  readonly OverallWidth: number;
  readonly OverallHeight: number;
}

export interface HostedElementEdit {
  readonly OverallWidth?: number;
  readonly OverallHeight?: number;
  /** Along the host's local X to the opening placement origin, metres. */
  readonly Offset?: number;
  /** Height of the opening placement origin in the host frame, metres. */
  readonly Sill?: number;
}

interface HostedGeometry {
  readonly read: HostedFillRead;
  readonly cut: HostBounds;
  readonly openingFrame: Frame3;
  readonly fillingFrame: Frame3 | null;
  readonly size: HostedElementSize | null;
}

function geometry(store: IfcDataStore, reader: AnchorEntityReader, id: number, view?: MutablePropertyView | null): HostedGeometry | null {
  const read = readHostedFill(store, id, view);
  const host = read ? reader.entity(read.hostId) : null;
  const hostPlacement = host ? refId(host.attributes[5]) : null;
  const opening = read ? reader.entity(read.openingId) : null;
  const openingPlacement = opening ? refId(opening.attributes[5]) : null;
  const openingFrame = hostPlacement === null || openingPlacement === null ? null : placementInAncestor(reader, openingPlacement, hostPlacement);
  const cut = read ? placedBodyExtent(store, read.openingId, view) : null;
  if (!read || !cut || !openingFrame || hostPlacement === null) return null;
  if (read.fillingId === null) return { read, cut, openingFrame, fillingFrame: null, size: null };
  const filling = reader.entity(read.fillingId);
  if (!filling || !['IFCDOOR', 'IFCWINDOW'].includes(filling.type.toUpperCase())) return null;
  const fillingPlacement = refId(filling.attributes[5]);
  const fillingFrame = fillingPlacement === null ? null : placementInAncestor(reader, fillingPlacement, hostPlacement);
  const local = localBodyExtent(store, read.fillingId, view);
  if (!local || !fillingFrame) return null;
  const body = transformBounds(local, fillingFrame);
  const scale = store.source.byteLength > 0 ? safeLengthUnitScale(store.source, store.entityIndex, 'readHostedElementSize') ?? 1 : 1;
  const dimension = (name: 'OverallWidth' | 'OverallHeight', axis: 0 | 2): number | null => {
    const index = filling.names.indexOf(name);
    const value = index < 0 ? null : filling.attributes[index];
    const native = value === null || value === undefined ? body.max[axis] - body.min[axis] : value;
    return typeof native === 'number' && Number.isFinite(native) && native > 0 ? fromNativeLength({ lengthUnitScale: scale }, native) : null;
  };
  const OverallWidth = dimension('OverallWidth', 0), OverallHeight = dimension('OverallHeight', 2);
  return OverallWidth === null || OverallHeight === null ? null : {
    read, cut, openingFrame, fillingFrame, size: { OverallWidth, OverallHeight },
  };
}

/** Read through the effective overlay, including imported mapped geometry.
 * A missing or unsupported physical shape is unreadable, never a rectangle. */
export function readHostedElementSize(store: IfcDataStore, id: number, view?: MutablePropertyView | null): HostedElementSize | null {
  return geometry(store, new AnchorEntityReader(store, view), id, view)?.size ?? null;
}

const ref = (id: number) => `#${id}`;

/** A fresh placement prevents a shared source Location/RelativePlacement
 * from moving another occurrence. A filling directly follows its opening. */
function moveOpening(reader: AnchorEntityReader, editor: StoreEditor, read: HostedFillRead, next: Vec3): void {
  const opening = reader.entity(read.openingId)!;
  const oldPlacementId = refId(opening.attributes[5]);
  const oldPlacement = oldPlacementId === null ? null : reader.entity(oldPlacementId);
  const oldAxisId = oldPlacement ? refId(oldPlacement.attributes[1]) : null;
  const oldAxis = oldAxisId === null ? null : reader.entity(oldAxisId);
  const parent = oldPlacement ? refId(oldPlacement.attributes[0]) : null;
  if (!oldAxis || parent === null) throw new Error('The opening placement cannot be edited safely');
  const direction = (value: unknown) => {
    if (value === null || value === undefined) return null;
    const id = refId(value);
    if (id === null) throw new Error('An unreadable placement direction is refused');
    return ref(id);
  };
  const point = editor.addEntity('IfcCartesianPoint', [next]).expressId;
  const axis = editor.addEntity('IfcAxis2Placement3D', [ref(point), direction(oldAxis.attributes[1]), direction(oldAxis.attributes[2])]).expressId;
  const placement = editor.addEntity('IfcLocalPlacement', [ref(parent), ref(axis)]).expressId;
  if (read.fillingId !== null) {
    const filling = reader.entity(read.fillingId)!;
    const fillingPlacementId = refId(filling.attributes[5]);
    const fillingPlacement = fillingPlacementId === null ? null : reader.entity(fillingPlacementId);
    const fillingAxis = fillingPlacement ? refId(fillingPlacement.attributes[1]) : null;
    if (!fillingPlacement || refId(fillingPlacement.attributes[0]) !== oldPlacementId || fillingAxis === null) {
      throw new Error('A filling not placed directly in its opening cannot be moved safely');
    }
    const nextFilling = editor.addEntity('IfcLocalPlacement', [ref(placement), ref(fillingAxis)]).expressId;
    editor.setPositionalAttribute(read.fillingId, 5, ref(nextFilling));
  }
  editor.setPositionalAttribute(read.openingId, 5, ref(placement));
}

/** Atomic params-to-commit operation. Affine resizing is centred across the
 * existing cut and held at its bottom; host thickness stays unchanged. Only
 * the occurrence's Representation/placement/dimensions change, never its type
 * maps, GlobalId, metadata or relationships. Refusals leave no overlay writes. */
export function editHostedElementInStore(store: IfcDataStore, editor: StoreEditor, id: number, patch: HostedElementEdit): HostedFillRead {
  if (!['IFC2X3', 'IFC4', 'IFC4X3'].includes(store.schemaVersion ?? 'IFC4')) throw new Error('Hosted edits support IFC2X3, IFC4 and IFC4X3 only');
  for (const [name, value] of Object.entries(patch)) {
    if (value !== undefined && (!Number.isFinite(value) || ((name === 'OverallWidth' || name === 'OverallHeight') && value <= 0))) {
      throw new Error(`${name} must be ${name.startsWith('Overall') ? 'positive and ' : ''}finite`);
    }
  }
  return editor.runAtomic(draft => {
    const view = draft.getMutationView(), reader = new AnchorEntityReader(store, view);
    const current = geometry(store, reader, id, view);
    if (!current) throw new Error(`The hosted geometry of #${id} cannot be read, so the edit is refused`);
    const { read, cut, size } = current;
    const host = resolveHostAnchor(store, read.hostId, view);
    if (host.hostKind !== 'wall') throw new Error('Hosted size/position edits require a wall host');
    if ((patch.OverallWidth !== undefined || patch.OverallHeight !== undefined) && !size) throw new Error('Overall dimensions apply to a hosted IfcDoor or IfcWindow');
    const widthScale = patch.OverallWidth === undefined || !size ? 1 : patch.OverallWidth / size.OverallWidth;
    const heightScale = patch.OverallHeight === undefined || !size ? 1 : patch.OverallHeight / size.OverallHeight;
    const dx = patch.Offset === undefined ? 0 : toNativeLength(host, patch.Offset) - read.location[0];
    const dz = patch.Sill === undefined ? 0 : toNativeLength(host, patch.Sill) - read.location[2];
    const anchor: Vec3 = [(cut.min[0] + cut.max[0]) / 2, (cut.min[1] + cut.max[1]) / 2, cut.min[2]];
    const proposed: HostBounds = {
      min: [anchor[0] + (cut.min[0] - anchor[0]) * widthScale + dx, cut.min[1], cut.min[2] + dz],
      max: [anchor[0] + (cut.max[0] - anchor[0]) * widthScale + dx, cut.max[1], cut.min[2] + (cut.max[2] - cut.min[2]) * heightScale + dz],
    };
    validateWallOpeningBounds(store, view, host, proposed, read.openingId);
    if (widthScale !== 1 || heightScale !== 1) {
      scaleHostedShape(reader, draft, read.openingId, current.openingFrame, anchor, widthScale, heightScale);
      if (read.fillingId !== null && current.fillingFrame) {
        scaleHostedShape(reader, draft, read.fillingId, current.fillingFrame, anchor, widthScale, heightScale);
      }
    }
    if (read.fillingId !== null && size) {
      const filling = reader.entity(read.fillingId)!;
      for (const name of ['OverallWidth', 'OverallHeight'] as const) {
        const value = patch[name], index = filling.names.indexOf(name);
        if (value !== undefined) {
          if (index < 0) throw new Error(`${filling.type} has no ${name} attribute in this schema`);
          draft.setPositionalAttribute(read.fillingId, index, toNativeLength(host, value));
        }
      }
    }
    if (dx !== 0 || dz !== 0) moveOpening(reader, draft, read, [read.location[0] + dx, read.location[1], read.location[2] + dz]);
    const updated = readHostedFill(store, id, view);
    const actual = placedBodyExtent(store, read.openingId, view);
    const eps = toNativeLength(host, 1e-6);
    if (!updated || !actual || actual.min.some((value, axis) => Math.abs(value - proposed.min[axis]) > eps)
      || actual.max.some((value, axis) => Math.abs(value - proposed.max[axis]) > eps)) {
      throw new Error('The hosted edit cannot reproduce its validated bounds; all writes were rolled back');
    }
    return updated;
  });
}
