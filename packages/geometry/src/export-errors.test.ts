/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, expect, it } from 'vitest';
import { isNoRenderGeometryError, NO_RENDER_GEOMETRY } from './export-errors.js';

describe('isNoRenderGeometryError', () => {
  it('matches the typed wasm error by its stable code prefix', () => {
    // Mirrors rust/export/src/error.rs Display: "<CODE>: <prose>".
    const err = new Error(`${NO_RENDER_GEOMETRY}: export produced no render geometry`);
    expect(isNoRenderGeometryError(err)).toBe(true);
  });

  it('rejects other errors and non-errors', () => {
    expect(isNoRenderGeometryError(new Error('RuntimeError: unreachable'))).toBe(false);
    expect(isNoRenderGeometryError('NO_RENDER_GEOMETRY')).toBe(false);
    expect(isNoRenderGeometryError(undefined)).toBe(false);
    expect(isNoRenderGeometryError(new Error(`prefix ${NO_RENDER_GEOMETRY}`))).toBe(false);
    expect(isNoRenderGeometryError(new Error(`${NO_RENDER_GEOMETRY}_OTHER: x`))).toBe(false);
    expect(isNoRenderGeometryError(new Error(NO_RENDER_GEOMETRY))).toBe(true);
  });
});
