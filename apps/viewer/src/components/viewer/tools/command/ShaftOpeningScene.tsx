/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { useViewerStore } from '@/store';
import type { CommandHudProps } from '@/lib/commands/modeling/types';
import type { HostedPlaceGesture } from '@/lib/commands/modeling/commands/hosted-place';
import { shaftOutline } from '@/lib/commands/modeling/commands/hosted-slab-fit';
import { planeZ } from '@/lib/commands/modeling/commands/placement-shared';
import { useProjectorTick } from '../../../viewport-ui/scene';

/** Keep the shaft boundary readable over a selected host, like slab.place's outline. */
export function ShaftOpeningScene({ gesture, ctx }: CommandHudProps<HostedPlaceGesture>) {
  const project = useViewerStore(s => s.cameraCallbacks.projectToScreen);
  const { host, position, shaft } = gesture, plane = ctx.workplane;
  const showing = !!plane && host?.hostKind === 'slab' && !!position;
  void useProjectorTick(showing);
  if (!showing || !plane || !host || !position || !project) return null;
  const top = host.origin[2] - planeZ(plane) + host.z[1] + .01;
  const points = shaftOutline(host, position, shaft.Width, shaft.Depth).flatMap(([x,y]) => {
    const r = plane.localToRender([x,y,top]);
    const p = project({ x: r[0], y: r[1], z: r[2] });
    return p ? [p] : [];
  });
  if (points.length !== 4) return null;
  const polygon = points.map(p => `${p.x},${p.y}`).join(' ');
  return (
    <svg data-slab-shaft-preview className="absolute inset-0 pointer-events-none z-(--z-scene)" style={{ overflow: 'visible' }}>
      <polygon points={polygon} fill="none" className="stroke-overlay-halo" strokeWidth={4} strokeLinejoin="round" />
      <polygon points={polygon} className="fill-overlay-accent-soft stroke-overlay-accent" strokeWidth={2} strokeLinejoin="round" />
    </svg>
  );
}
