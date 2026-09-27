/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The modeling commands' mesh snap source (charter #6232, WP2): a minimal
 * adapter over the renderer's magnetic raycast (`raycastSceneMagnetic`),
 * mapping its one snap target into workplane-local candidates for the WP3
 * solver. SEAM: WP3's `meshSource` (PR3.2, `lib/snap/sources/`) replaces this
 * wholesale; `commandPointer.ts` is its only caller.
 */

import { SnapType, type SnapTarget } from '@ifc-lite/renderer';
import type { SnapSource, Vec2 } from '@/lib/snap/types';

type Point = { x: number; y: number; z: number };

export function meshSnapSource(target: SnapTarget | null, toLocal: (p: Point) => Vec2): SnapSource {
  return {
    id: 'mesh',
    collect(_query, _radius, out) {
      if (!target) return;
      const local = toLocal(target.position);
      const vertices = target.metadata?.vertices;
      if (target.type === SnapType.VERTEX) {
        out.push({ kind: 'vertex', local, source: 'mesh' });
      } else if (target.type === SnapType.EDGE && vertices && vertices.length >= 2) {
        const a = toLocal(vertices[0]);
        const b = toLocal(vertices[1]);
        out.push(
          { kind: 'edge', local, source: 'mesh', guide: { kind: 'segment', a, b, role: 'edge' } },
          { kind: 'endpoint', local: a, source: 'mesh' },
          { kind: 'endpoint', local: b, source: 'mesh' },
          { kind: 'midpoint', local: [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2], source: 'mesh' },
        );
      } else if (target.type === SnapType.FACE || target.type === SnapType.FACE_CENTER) {
        out.push({ kind: 'face', local, source: 'mesh' });
      }
    },
  };
}
