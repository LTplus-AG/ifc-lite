/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, it, expect } from 'vitest';
import { readSpecularMaterial } from './mesh-specular.js';

/**
 * `readSpecularMaterial` (#5582) shapes the wasm `MeshDataJs.metallic`/
 * `.roughness` getters into `MeshData.material`, shared by both
 * `MeshCollection` converters (`geometry.worker.ts`, `geometry-coordinate.ts`)
 * so they read the IFC-authored specular pair identically.
 */
describe('readSpecularMaterial (#5582)', () => {
  it('returns undefined when neither field is authored (older wasm bundle, or no specular evidence)', () => {
    expect(readSpecularMaterial({})).toBeUndefined();
    expect(readSpecularMaterial({ metallic: undefined, roughness: undefined })).toBeUndefined();
  });

  it('carries metallic alone', () => {
    expect(readSpecularMaterial({ metallic: 1 })).toEqual({ metallic: 1 });
  });

  it('carries roughness alone', () => {
    expect(readSpecularMaterial({ roughness: 0.25 })).toEqual({ roughness: 0.25 });
  });

  it('carries both fields', () => {
    expect(readSpecularMaterial({ metallic: 0, roughness: 0.05 })).toEqual({ metallic: 0, roughness: 0.05 });
  });

  it('preserves a metallic/roughness of exactly 0 rather than dropping it as falsy', () => {
    // A naive `metallic || undefined` guard would drop 0 (a legitimate
    // dielectric value); this locks the `!== undefined` check instead.
    const result = readSpecularMaterial({ metallic: 0, roughness: 0 });
    expect(result).toEqual({ metallic: 0, roughness: 0 });
  });
});
