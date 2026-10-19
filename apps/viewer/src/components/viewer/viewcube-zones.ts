/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * ViewCube hit geometry, kept free of React and the DOM so the mapping from a
 * clickable region to a camera direction is testable on its own.
 *
 * Every cube face is a 3x3 grid: the centre cell is the face, the four edge
 * cells are the cube edges shared with the neighbouring faces, and the four
 * corner cells are the cube corners. A cell's direction is the face normal
 * plus its offset along the face's own right/up axes, so the same edge reached
 * from either of its two faces resolves to the same direction (and the same
 * highlight key). Directions are in the preset face frame the camera uses:
 * +X right, +Y top, +Z front.
 */

export type CubeFace = 'front' | 'back' | 'top' | 'bottom' | 'right' | 'left';

export interface CubeDirection {
  x: number;
  y: number;
  z: number;
}

export type CubeZoneKind = 'face' | 'edge' | 'corner';

export interface CubeZone {
  /** Shared by every cell, on any face, that maps to the same direction. */
  key: string;
  kind: CubeZoneKind;
  direction: CubeDirection;
  /** Grid cell on the owning face: column -1..1 (left to right), row -1..1 (top to bottom). */
  col: number;
  row: number;
}

interface FaceFrame {
  normal: CubeDirection;
  /** Direction the face's local "right" points to, in the face frame. */
  right: CubeDirection;
  /** Direction the face's local "up" points to. */
  up: CubeDirection;
}

/** Matches the CSS transforms of the faces in `ViewCube.tsx`. */
export const FACE_FRAMES: Record<CubeFace, FaceFrame> = {
  front: { normal: { x: 0, y: 0, z: 1 }, right: { x: 1, y: 0, z: 0 }, up: { x: 0, y: 1, z: 0 } },
  back: { normal: { x: 0, y: 0, z: -1 }, right: { x: -1, y: 0, z: 0 }, up: { x: 0, y: 1, z: 0 } },
  right: { normal: { x: 1, y: 0, z: 0 }, right: { x: 0, y: 0, z: -1 }, up: { x: 0, y: 1, z: 0 } },
  left: { normal: { x: -1, y: 0, z: 0 }, right: { x: 0, y: 0, z: 1 }, up: { x: 0, y: 1, z: 0 } },
  top: { normal: { x: 0, y: 1, z: 0 }, right: { x: 1, y: 0, z: 0 }, up: { x: 0, y: 0, z: -1 } },
  bottom: { normal: { x: 0, y: -1, z: 0 }, right: { x: 1, y: 0, z: 0 }, up: { x: 0, y: 0, z: 1 } },
};

export const CUBE_FACES = Object.keys(FACE_FRAMES) as CubeFace[];

export function directionKey(d: CubeDirection): string {
  // `+ 0` folds -0 into 0 so opposite derivations of one direction share a key.
  return `${d.x + 0},${d.y + 0},${d.z + 0}`;
}

function zoneKind(d: CubeDirection): CubeZoneKind {
  const axes = Math.abs(d.x) + Math.abs(d.y) + Math.abs(d.z);
  return axes === 1 ? 'face' : axes === 2 ? 'edge' : 'corner';
}

/** The nine cells of one face, row-major from the top-left. */
export function zonesForFace(face: CubeFace): CubeZone[] {
  const { normal, right, up } = FACE_FRAMES[face];
  const zones: CubeZone[] = [];
  for (const row of [-1, 0, 1]) {
    for (const col of [-1, 0, 1]) {
      // Row -1 is the top of the face, so it moves along +up.
      const direction: CubeDirection = {
        x: normal.x + col * right.x - row * up.x,
        y: normal.y + col * right.y - row * up.y,
        z: normal.z + col * right.z - row * up.z,
      };
      zones.push({ key: directionKey(direction), kind: zoneKind(direction), direction, col, row });
    }
  }
  return zones;
}

/** The named face a direction points straight at, or null for an edge or corner. */
export function faceOfDirection(d: CubeDirection): CubeFace | null {
  if (zoneKind(d) !== 'face') return null;
  return CUBE_FACES.find((f) => directionKey(FACE_FRAMES[f].normal) === directionKey(d)) ?? null;
}

/**
 * Whether `zone`, drawn on `face`, should light up while `hoveredKey` is
 * hovered: the zone itself and its twins on neighbouring faces, or, for a
 * face hover, every cell of that face (the whole-side preview).
 */
export function isZoneHighlighted(zone: CubeZone, face: CubeFace, hoveredKey: string | null): boolean {
  if (!hoveredKey) return false;
  if (zone.key === hoveredKey) return true;
  return directionKey(FACE_FRAMES[face].normal) === hoveredKey;
}

/** The one to three faces a direction touches, in cube-face order. */
export function facesOfDirection(d: CubeDirection): CubeFace[] {
  return CUBE_FACES.filter((f) => {
    const n = FACE_FRAMES[f].normal;
    return n.x * d.x + n.y * d.y + n.z * d.z > 0;
  });
}
