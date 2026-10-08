/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Real clash runs for BCF draft tests (#6896). Element identities (GlobalId,
 * name, IFC type) come from the committed SketchUp `building-architecture.ifc`
 * sample through the native parser; their geometry is a controlled layout of
 * axis-aligned boxes so a test can move one proxy and rerun the real TS clash
 * engine. The findings are real engine output for that layout, not
 * measured clashes of the authored building.
 */

import { readFile } from 'node:fs/promises';
import { IfcParser } from '@ifc-lite/parser';
import { createClashEngine, type Clash, type ClashElement, type ClashRule } from '@ifc-lite/clash';
import { manualClashMember, type ManualClashGroup } from '@/lib/clash/manual-groups';

export const PROXY_WALL_RULE: ClashRule = { id: 'proxy-wall', name: 'Proxy × Wall', a: 'IfcBuildingElementProxy', b: 'IfcWall', mode: 'hard' };

interface SampleElement { key: string; name: string; tag: string; expressId: number }
let sample: Promise<{ walls: SampleElement[]; proxies: SampleElement[] }> | undefined;

/** Walls and building-element proxies of the committed sample, in file order. */
export function sampleElements(): Promise<{ walls: SampleElement[]; proxies: SampleElement[] }> {
  sample ??= (async () => {
    const bytes = await readFile(new URL('../../public/samples/building-architecture.ifc', import.meta.url));
    const store = await new IfcParser().parseColumnar(new Uint8Array(bytes).buffer, { disableWorkerScan: true });
    const pick = (type: string): SampleElement[] => Array.from(store.entities.expressId)
      .filter(id => store.entities.getTypeName(id) === type)
      .map(id => ({ key: store.entities.getGlobalId(id), name: store.entities.getName(id) || type, tag: type, expressId: id }));
    return { walls: pick('IfcWall'), proxies: pick('IfcBuildingElementProxy') };
  })();
  return sample;
}

function box(min: [number, number, number], max: [number, number, number]): Pick<ClashElement, 'bounds' | 'positions' | 'indices'> {
  const [x0, y0, z0] = min, [x1, y1, z1] = max;
  const positions = new Float32Array([x0, y0, z0, x1, y0, z0, x1, y1, z0, x0, y1, z0, x0, y0, z1, x1, y0, z1, x1, y1, z1, x0, y1, z1]);
  const indices = new Uint32Array([0, 1, 2, 0, 2, 3, 4, 6, 5, 4, 7, 6, 0, 4, 5, 0, 5, 1, 1, 5, 6, 1, 6, 2, 2, 6, 7, 2, 7, 3, 3, 7, 4, 3, 4, 0]);
  return { bounds: { min, max }, positions, indices };
}

/**
 * Run the real engine. `layout[p]` lists the wall indices proxy `p` crosses
 * (walls sit 10 m apart as unit boxes); an empty list parks the proxy clear
 * of every wall.
 */
export async function proxyWallRun(layout: readonly (readonly number[])[], model = 'architecture'): Promise<Clash[]> {
  const { walls, proxies } = await sampleElements();
  const elements: ClashElement[] = walls.map((wall, index) => ({ key: wall.key, ref: wall.expressId, model, tag: wall.tag, name: wall.name,
    ...box([index * 10, 0, 0], [index * 10 + 1, 1, 1]) }));
  layout.forEach((crossed, index) => {
    const proxy = proxies[index];
    const from = crossed.length ? Math.min(...crossed) * 10 + 0.5 : 500 + index * 10;
    const to = crossed.length ? Math.max(...crossed) * 10 + 1.5 : from + 1;
    elements.push({ key: proxy.key, ref: proxy.expressId, model, tag: proxy.tag, name: proxy.name,
      ...box([from, 0.25, 0.25], [to, 0.75, 0.75]) });
  });
  const result = await createClashEngine({ backend: 'ts' }).run(elements, [PROXY_WALL_RULE]);
  return result.clashes;
}

/** A reviewed manual group holding exactly the findings of the given proxies. */
export function groupOf(id: string, name: string, clashes: readonly Clash[], proxyKeys: readonly string[]): ManualClashGroup {
  return { id, name, members: clashes.filter(clash => proxyKeys.includes(clash.a.key) || proxyKeys.includes(clash.b.key)).map(manualClashMember) };
}
