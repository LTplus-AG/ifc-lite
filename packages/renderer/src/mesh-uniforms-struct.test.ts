/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { MESH_UNIFORM_OFFSET } from './mesh-rte-uniforms.js';
import { meshUniformsWgsl } from './shaders/mesh-uniforms.wgsl.js';

/**
 * The per-mesh uniform block is packed on the CPU by `MESH_UNIFORM_OFFSET`
 * and declared once in WGSL (`mesh-uniforms.wgsl.ts`, shared by the main
 * shader and the selection mask). A field the packer writes but the struct
 * does not declare fails WGSL compilation for EVERY mesh draw: a merge of
 * #5748 dropped `overrideParams` (#6076) this way and left the viewer blank.
 */
describe('mesh uniform struct declares every packed field', () => {
  const struct = /struct Uniforms \{([\s\S]*?)\n\s*\}/.exec(meshUniformsWgsl)?.[1] ?? '';
  const members = new Set([...struct.matchAll(/^\s*(\w+)\s*:/gm)].map((m) => m[1]));

  it('declares each MESH_UNIFORM_OFFSET field as a struct member', () => {
    // A high/low f32 pair is packed under one name (drawableDelta -> drawableDelta{High,Low},
    // rteCameraOrigin -> rteCamera{High,Low}); BOTH halves must be declared.
    for (const field of Object.keys(MESH_UNIFORM_OFFSET)) {
      if (members.has(field)) continue;
      const base = members.has(`${field}High`) ? field : field.replace(/Origin$/, '');
      assert.ok(members.has(`${base}High`), `${field} is packed by MESH_UNIFORM_OFFSET but missing from struct Uniforms`);
      assert.ok(members.has(`${base}Low`), `${field}'s low half (${base}Low) is missing from struct Uniforms`);
    }
  });

  it('declares overrideParams as the last, u32 member (#6076)', () => {
    assert.match(struct, /overrideParams: vec4<u32>,[^\n]*\n?\s*$/);
  });
});
