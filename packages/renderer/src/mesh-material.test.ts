/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { packMeshMaterial, DEFAULT_MATERIAL_METALLIC, DEFAULT_MATERIAL_ROUGHNESS, GLASS_ROUGHNESS } from './mesh-material.js';
import { MESH_UNIFORM_OFFSET, MESH_UNIFORM_FLOATS } from './mesh-rte-uniforms.js';

/**
 * `packMeshMaterial` is the single writer of the mesh uniform's material row
 * (#5386): every draw path (flat, batched, textured, instanced template) goes
 * through it instead of repeating `mesh.material?.roughness ?? 0.6` at each
 * call site.
 */
describe('packMeshMaterial (#5386)', () => {
  const at = MESH_UNIFORM_OFFSET.metallicRoughness;

  function pack(authoredAlpha?: number, material?: { metallic?: number; roughness?: number }): Float32Array {
    const buf = new Float32Array(MESH_UNIFORM_FLOATS);
    packMeshMaterial(buf, authoredAlpha, material);
    return buf;
  }

  it('defaults an opaque draw to a matte dielectric', () => {
    const buf = pack(1);
    assert.equal(buf[at], DEFAULT_MATERIAL_METALLIC, 'metallic');
    assert.equal(buf[at + 1], Math.fround(DEFAULT_MATERIAL_ROUGHNESS), 'roughness');
    assert.equal(buf[at + 2], 0, 'transmission flag: opaque is not glass');
  });

  it('defaults with no authoredAlpha argument at all (the opaque instanced template)', () => {
    const buf = new Float32Array(MESH_UNIFORM_FLOATS);
    packMeshMaterial(buf);
    assert.equal(buf[at + 1], Math.fround(DEFAULT_MATERIAL_ROUGHNESS), 'a call with no alpha argument must stay opaque, not glass');
    assert.equal(buf[at + 2], 0, 'transmission flag');
  });

  it('turns a translucent AUTHORED alpha into glass: smooth roughness, transmission flag set', () => {
    const buf = pack(0.5);
    assert.equal(buf[at + 1], Math.fround(GLASS_ROUGHNESS), 'roughness');
    assert.equal(buf[at + 2], 1, 'transmission flag: translucent is glass');
  });

  it('uses the same OPAQUE_ALPHA_CUTOFF boundary as the rest of the renderer (overlay-routing.ts)', () => {
    // 0.99 itself is opaque (>=), just under it is glass — this must track
    // overlay-routing.ts's OPAQUE_ALPHA_CUTOFF, not a second literal 0.99.
    assert.equal(pack(0.99)[at + 2], 0, 'alpha exactly at the cutoff is opaque');
    assert.equal(pack(0.989)[at + 2], 1, 'alpha just under the cutoff is glass');
  });

  it('does NOT turn an X-Ray/compare-faded alpha into glass — only the AUTHORED alpha decides', () => {
    // An opaque wall faded to 0.2 by X-Ray still passes its AUTHORED alpha
    // (1) here; the caller is responsible for not passing the faded value.
    const buf = pack(1);
    assert.equal(buf[at + 2], 0, 'an authored-opaque material stays a dielectric regardless of any display fade');
  });

  it('lets a caller-supplied material override the defaults, including for an authored-translucent draw', () => {
    const buf = pack(0.5, { metallic: 0.8, roughness: 0.3 });
    assert.equal(buf[at], Math.fround(0.8), 'metallic override');
    assert.equal(buf[at + 1], Math.fround(0.3), 'roughness override wins over GLASS_ROUGHNESS');
    assert.equal(buf[at + 2], 1, 'still authored-translucent, so still flagged as glass');
  });

  it('lets a partial override (metallic only) fall back to the roughness default', () => {
    const buf = pack(1, { metallic: 0.5 });
    assert.equal(buf[at], Math.fround(0.5), 'metallic override');
    assert.equal(buf[at + 1], Math.fround(DEFAULT_MATERIAL_ROUGHNESS), 'unset roughness falls back to the default');
  });

  it('zeroes the padding lane', () => {
    const buf = pack(1);
    assert.equal(buf[at + 3], 0);
  });

  it('does not disturb bytes outside the material row', () => {
    const buf = new Float32Array(MESH_UNIFORM_FLOATS).fill(-1);
    packMeshMaterial(buf, 0.5, { metallic: 0.2, roughness: 0.1 });
    for (let i = 0; i < buf.length; i++) {
      if (i >= at && i < at + 4) continue;
      assert.equal(buf[i], -1, `offset ${i} outside the material row was overwritten`);
    }
  });
});
