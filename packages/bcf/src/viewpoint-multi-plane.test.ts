/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Several cutting planes through BCF (#7545). The schema's `ClippingPlanes` is a list; the
 * viewer used to write one entry and read only the first. Every enabled plane is now an
 * entry, in order, and what comes back through a real .bcf archive is the same set of cuts.
 */

import { describe, it, expect } from 'vitest';
import { generateUuid } from '@ifc-lite/encoding';
import {
  createViewpoint,
  extractViewpointState,
  type ViewerBounds,
  type ViewerCameraState,
  type ViewerSectionPlane,
} from './viewpoint.js';
import { writeBCF } from './writer.js';
import { readBCF } from './reader.js';
import type { BCFProject } from './types.js';

const BOUNDS: ViewerBounds = { min: { x: 0, y: 0, z: 0 }, max: { x: 10, y: 4, z: 6 } };
const CAMERA: ViewerCameraState = {
  position: { x: 10, y: 10, z: 10 }, target: { x: 0, y: 0, z: 0 }, up: { x: 0, y: 1, z: 0 }, fov: Math.PI / 3,
};
const cut = (axis: ViewerSectionPlane['axis'], position: number, flipped: boolean, enabled = true): ViewerSectionPlane => ({ axis, position, flipped, enabled });
const THREE = [cut('down', 40, false), cut('side', 70, true), cut('front', 25, false)];

const approx = (planes: ViewerSectionPlane[] | undefined) => planes?.map((p) => ({ ...p, position: Number(p.position.toFixed(9)) }));

describe('several clipping planes in a viewpoint (#7545)', () => {
  it('writes one clipping plane per enabled plane, in order, and reads them all back', () => {
    const viewpoint = createViewpoint({ camera: CAMERA, sectionPlanes: THREE, bounds: BOUNDS });
    expect(viewpoint.clippingPlanes).toHaveLength(3);

    const state = extractViewpointState(viewpoint, BOUNDS);
    expect(approx(state.sectionPlanes)).toEqual(approx(THREE));
    expect(approx(state.sectionPlane ? [state.sectionPlane] : undefined)).toEqual(approx([THREE[0]!]));
  });

  it('a plane that is not enabled is not exported', () => {
    const viewpoint = createViewpoint({ camera: CAMERA, sectionPlanes: [THREE[0]!, cut('side', 10, false, false), THREE[2]!], bounds: BOUNDS });
    expect(extractViewpointState(viewpoint, BOUNDS).sectionPlanes?.map((p) => p.axis)).toEqual(['down', 'front']);
  });

  it('the single-plane inputs and outputs keep their meaning', () => {
    const one = createViewpoint({ camera: CAMERA, sectionPlane: THREE[1]!, bounds: BOUNDS });
    expect(one.clippingPlanes).toHaveLength(1);
    const state = extractViewpointState(one, BOUNDS);
    expect(state.sectionPlane?.axis).toBe('side');
    expect(state.sectionPlanes).toHaveLength(1);
    expect(extractViewpointState(createViewpoint({ camera: CAMERA, bounds: BOUNDS }), BOUNDS).sectionPlanes).toBeUndefined();
  });

  it('survives a real .bcf archive: three planes in, the same three half-spaces out', async () => {
    const topicGuid = generateUuid();
    const viewpoint = createViewpoint({ camera: CAMERA, sectionPlanes: THREE, bounds: BOUNDS });
    const project: BCFProject = {
      version: '2.1',
      projectId: generateUuid(),
      topics: new Map([[topicGuid, {
        guid: topicGuid, title: 'Three cuts', creationDate: new Date().toISOString(), creationAuthor: 'test@example.com', comments: [], viewpoints: [viewpoint],
      }]]),
    };
    const read = await readBCF(await (await writeBCF(project)).arrayBuffer());
    const back = [...read.topics.values()][0]!.viewpoints[0]!;
    expect(back.clippingPlanes).toHaveLength(3);
    expect(approx(extractViewpointState(back, BOUNDS).sectionPlanes)).toEqual(approx(THREE));
  });
});
