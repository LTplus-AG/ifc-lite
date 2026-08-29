/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * `viewer_set_section`'s `flipped` and `enabled` parameters, crossing the
 * producer -> consumer boundary.
 *
 * The MCP tool schema (`packages/mcp/src/tools/viewer.ts`) declares
 * `flipped` and `enabled` alongside `axis`/`position`, and the playground's
 * own tool catalogue (`apps/viewer/src/components/mcp/data.ts`) advertises
 * the same two params to the LLM. But `setSection` in this file — the
 * playground's client-side three.js implementation — read only `axis` and
 * `position`: an agent told by the catalogue it could pass `flipped: true`
 * or `enabled: false` got a plane built as if it hadn't.
 *
 * `setSection` is plain math over `THREE.Plane` — no WebGL context needed —
 * so the crossing is testable directly, without going through the
 * dispatcher or mounting the scene.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';

import { createSectionState, setSection, clearSection } from './playground-scene-view.js';
import type { EntityRecord } from './playground-scene-registry.js';

function fakeRecord(): EntityRecord {
  const material = new THREE.MeshStandardMaterial();
  const geometry = new THREE.BufferGeometry();
  const mesh = new THREE.Mesh(geometry, material);
  return {
    expressId: 1,
    mesh,
    baseColor: new THREE.Color(0xffffff),
    baseOpacity: 1,
  };
}

describe('setSection flipped/enabled', () => {
  it('flips which half-space the plane keeps', () => {
    const section = createSectionState();
    const records = [fakeRecord()];

    setSection(section, records, { axis: 'x', position: 2 });
    assert.ok(section.active);
    const unflipped = section.active!.clone();

    setSection(section, records, { axis: 'x', position: 2, flipped: true });
    const flipped = section.active!;

    // A flipped plane keeps the opposite side: for any point, the signed
    // distance to the flipped plane is the negation of the distance to the
    // unflipped one.
    const probe = new THREE.Vector3(5, 0, 0);
    const dUnflipped = unflipped.distanceToPoint(probe);
    const dFlipped = flipped.distanceToPoint(probe);
    assert.ok(
      Math.abs(dUnflipped + dFlipped) < 1e-9,
      `expected flipped plane to negate distance (unflipped=${dUnflipped}, flipped=${dFlipped})`,
    );
  });

  it('does not clip when enabled is false', () => {
    const section = createSectionState();
    const record = fakeRecord();

    setSection(section, [record], { axis: 'z', position: 1, enabled: false });

    const mat = record.mesh.material as THREE.MeshStandardMaterial;
    assert.deepEqual(mat.clippingPlanes, []);
    assert.equal(section.active, null);
  });

  it('clips when enabled is true (default)', () => {
    const section = createSectionState();
    const record = fakeRecord();

    setSection(section, [record], { axis: 'z', position: 1 });

    const mat = record.mesh.material as THREE.MeshStandardMaterial;
    assert.equal(mat.clippingPlanes?.length, 1);
    assert.ok(section.active);
  });

  it('clearSection still removes the plane after a flipped/disabled call', () => {
    const section = createSectionState();
    const record = fakeRecord();

    setSection(section, [record], { axis: 'y', position: 0, flipped: true });
    clearSection(section, [record]);

    const mat = record.mesh.material as THREE.MeshStandardMaterial;
    assert.deepEqual(mat.clippingPlanes, []);
    assert.equal(section.active, null);
  });
});
