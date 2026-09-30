/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * A section's outline as polygons (charter #6232, D2): what the picker's
 * preview draws and what the placing commands' ghosts sweep along the
 * element's axis, so the preview, the ghost and the wasm mesh agree.
 *
 * The outlines follow the mesher's construction of each IFC profile class
 * (`rust/geometry/src/profiles`): centred on the bounding box, an L's heel at
 * the lower left, a U's web on the left, a T's flange on top. Fillet radii are
 * not drawn (the picker does not write them). Metres, counter-clockwise, in
 * the profile's own frame: X across, Y up.
 */

import type { MeshData } from '@ifc-lite/geometry';
import type { ProfileSection } from '@ifc-lite/create';
import type { Vec2 } from '@/lib/snap/types';
import type { Vec3, Workplane } from '@/lib/commands/modeling/types';
import { signedArea2, triangulateOutline } from '@/lib/commands/modeling/ghost-shapes';

/**
 * One section as rings: the outer loop, and for a hollow section the inner
 * loop with the same number of points, corresponding one to one (the caps
 * are the strip between the two).
 */
export interface SectionOutline {
  readonly outer: readonly Vec2[];
  readonly inner?: readonly Vec2[];
}

const CIRCLE_SEGMENTS = 32;

function circle(radius: number): Vec2[] {
  return Array.from({ length: CIRCLE_SEGMENTS }, (_, i) => {
    const a = (2 * Math.PI * i) / CIRCLE_SEGMENTS;
    return [radius * Math.cos(a), radius * Math.sin(a)] as Vec2;
  });
}

const box = (w: number, h: number): Vec2[] => [[-w / 2, -h / 2], [w / 2, -h / 2], [w / 2, h / 2], [-w / 2, h / 2]];

/** The rings of `section`, or null when its dimensions cannot make a shape (a wall thicker than the section). */
export function sectionOutline(section: ProfileSection): SectionOutline | null {
  switch (section.Type) {
    case 'Rectangle':
      return { outer: box(section.XDim, section.YDim) };
    case 'I': {
      const { OverallWidth: w, OverallDepth: d, WebThickness: tw, FlangeThickness: tf } = section;
      const [x, y, a, b] = [w / 2, d / 2, tw / 2, d / 2 - tf];
      return { outer: [[-x, -y], [x, -y], [x, -b], [a, -b], [a, b], [x, b], [x, y], [-x, y], [-x, b], [-a, b], [-a, -b], [-x, -b]] };
    }
    case 'L': {
      const { Width: w, Depth: d, Thickness: t } = section;
      return { outer: [[-w / 2, -d / 2], [w / 2, -d / 2], [w / 2, -d / 2 + t], [-w / 2 + t, -d / 2 + t], [-w / 2 + t, d / 2], [-w / 2, d / 2]] };
    }
    case 'T': {
      const { Depth: d, FlangeWidth: f, WebThickness: tw, FlangeThickness: tf } = section;
      const [a, b, y] = [tw / 2, f / 2, d / 2];
      return { outer: [[-a, -y], [a, -y], [a, y - tf], [b, y - tf], [b, y], [-b, y], [-b, y - tf], [-a, y - tf]] };
    }
    case 'U': {
      const { Depth: d, FlangeWidth: f, WebThickness: tw, FlangeThickness: tf } = section;
      const [x, y] = [f / 2, d / 2];
      return { outer: [[-x, -y], [x, -y], [x, -y + tf], [-x + tw, -y + tf], [-x + tw, y - tf], [x, y - tf], [x, y], [-x, y]] };
    }
    case 'C': {
      const { Depth: d, Width: w, WallThickness: t, Girth: g } = section;
      const [x, y] = [w / 2, d / 2];
      return { outer: [[-x, -y], [x, -y], [x, -y + g], [x - t, -y + g], [x - t, -y + t], [-x + t, -y + t], [-x + t, y - t], [x - t, y - t], [x - t, y - g], [x, y - g], [x, y], [-x, y]] };
    }
    case 'Circle':
      return { outer: circle(section.Radius) };
    case 'RectangleHollow': {
      const { XDim: w, YDim: h, WallThickness: t } = section;
      return w - 2 * t > 0 && h - 2 * t > 0 ? { outer: box(w, h), inner: box(w - 2 * t, h - 2 * t) } : null;
    }
    case 'CircleHollow':
      return section.Radius - section.WallThickness > 0
        ? { outer: circle(section.Radius), inner: circle(section.Radius - section.WallThickness) }
        : null;
  }
}

/** An SVG path (even-odd) for `section` scaled to fit a `size` px box, y up on screen. */
export function sectionPath(section: ProfileSection, size: number, padding = 2): string | null {
  const outline = sectionOutline(section);
  if (!outline) return null;
  const extent = Math.max(...outline.outer.map(([x, y]) => Math.max(Math.abs(x), Math.abs(y)))) * 2;
  if (!(extent > 0)) return null;
  const scale = (size - 2 * padding) / extent;
  const ring = (points: readonly Vec2[]) =>
    points.map(([x, y], i) => `${i === 0 ? 'M' : 'L'}${(size / 2 + x * scale).toFixed(2)} ${(size / 2 - y * scale).toFixed(2)}`).join('') + 'Z';
  return [outline.outer, ...(outline.inner ? [outline.inner] : [])].map(ring).join('');
}

const GHOST_COLOR: [number, number, number, number] = [0.25, 0.6, 1, 0.45];
const sub = (a: Vec3, b: Vec3): Vec3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const cross = (a: Vec3, b: Vec3): Vec3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const dot = (a: Vec3, b: Vec3): number => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];

/** Where a section sits: its origin, its X and Y axes (workplane-local metres), and the way it is extruded. */
export interface SectionFrame {
  readonly origin: Vec3;
  readonly u: Vec3;
  readonly v: Vec3;
  /** Unit extrusion direction. */
  readonly along: Vec3;
  readonly length: number;
}

/**
 * The ghost of `section` swept along `frame`: the same shape the builders
 * write for a beam (frame from its axis) or a column (frame from its base
 * centre). Flat-shaded with outward normals; a hollow section shows its bore.
 * Null when the section, or the length, is degenerate.
 */
export function sectionGhostMesh(plane: Workplane, section: ProfileSection, frame: SectionFrame, expressId: number): MeshData | null {
  const outline = sectionOutline(section);
  if (!outline || !(frame.length > 1e-6) || Math.abs(signedArea2(outline.outer)) < 1e-12) return null;
  const map = (p: Vec2, t: number): Vec3 => plane.localToRender([
    frame.origin[0] + frame.u[0] * p[0] + frame.v[0] * p[1] + frame.along[0] * t,
    frame.origin[1] + frame.u[1] * p[0] + frame.v[1] * p[1] + frame.along[1] * t,
    frame.origin[2] + frame.u[2] * p[0] + frame.v[2] * p[1] + frame.along[2] * t,
  ]);
  const at = (p: Vec2, t: number) => map(p, t);
  const far = frame.length;
  const alongDir = sub(map([0, 0], far), map([0, 0], 0));
  const backDir: Vec3 = [-alongDir[0], -alongDir[1], -alongDir[2]];
  // A profile frame whose axes flip handedness turns the winding over; the orientation test below fixes each face.
  const faces: { tri: Vec3[]; out: Vec3 }[] = [];
  const ring = (points: readonly Vec2[], inward: boolean) => {
    const turn = (signedArea2(points) > 0 ? 1 : -1) * (inward ? -1 : 1);
    points.forEach((a, i) => {
      const b = points[(i + 1) % points.length];
      // Outward of the material: the edge turned away from the interior of this ring (towards the bore for an inner ring).
      const edge: Vec2 = [turn * (b[1] - a[1]), -turn * (b[0] - a[0])];
      const out = sub(map([a[0] + edge[0], a[1] + edge[1]], 0), map(a, 0));
      faces.push({ tri: [at(a, 0), at(b, 0), at(b, far)], out }, { tri: [at(a, 0), at(b, far), at(a, far)], out });
    });
  };
  ring(outline.outer, false);
  if (outline.inner) {
    ring(outline.inner, true);
    const n = outline.outer.length;
    for (let i = 0; i < n; i++) {
      const j = (i + 1) % n;
      for (const [t, out] of [[0, backDir], [far, alongDir]] as const) {
        faces.push(
          { tri: [at(outline.outer[i], t), at(outline.outer[j], t), at(outline.inner[j], t)], out },
          { tri: [at(outline.outer[i], t), at(outline.inner[j], t), at(outline.inner[i], t)], out },
        );
      }
    }
  } else {
    for (const [a, b, c] of triangulateOutline(outline.outer)) {
      faces.push({ tri: [at(outline.outer[a], 0), at(outline.outer[b], 0), at(outline.outer[c], 0)], out: backDir });
      faces.push({ tri: [at(outline.outer[a], far), at(outline.outer[b], far), at(outline.outer[c], far)], out: alongDir });
    }
  }
  const positions = new Float32Array(faces.length * 9);
  const normals = new Float32Array(faces.length * 9);
  const indices = new Uint32Array(faces.length * 3);
  faces.forEach(({ tri, out }, f) => {
    let n = cross(sub(tri[1], tri[0]), sub(tri[2], tri[0]));
    const outward = dot(n, out) >= 0;
    const ordered = outward ? tri : [tri[0], tri[2], tri[1]];
    if (!outward) n = [-n[0], -n[1], -n[2]];
    const len = Math.hypot(...n) || 1;
    ordered.forEach((p, i) => {
      positions.set(p, f * 9 + i * 3);
      normals.set([n[0] / len, n[1] / len, n[2] / len], f * 9 + i * 3);
    });
    indices.set([f * 3, f * 3 + 1, f * 3 + 2], f * 3);
  });
  return { expressId, positions, normals, indices, color: [...GHOST_COLOR] };
}
