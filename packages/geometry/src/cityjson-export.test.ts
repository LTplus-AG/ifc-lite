/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Unit coverage for `exportCityJson`'s option handoff to the separate export
 * wasm (mocked here, per AGENTS.md §Geometry & WASM; the real boundary is
 * exercised by `packages/cli/src/commands/export-cityjson.test.ts`).
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

const wasmMocks = vi.hoisted(() => ({ init: vi.fn(async () => undefined), exportCityJson: vi.fn() }));

vi.mock('@ifc-lite/wasm/rhino', () => ({
  default: wasmMocks.init,
  exportCityJson: wasmMocks.exportCityJson,
}));

import { exportCityJson, cityJsonRefusalReason } from './index.js';

describe('exportCityJson', () => {
  beforeEach(() => { wasmMocks.exportCityJson.mockReset(); });

  it('serializes the options for the export wasm', async () => {
    const result = { text: '{}', referenceSystem: null, warnings: [], buildings: 1, cityObjects: 1, vertices: 0 };
    wasmMocks.exportCityJson.mockReturnValue(result);
    const bytes = new Uint8Array([1]);
    await expect(exportCityJson(bytes, { scale: 0.01, sequence: true })).resolves.toBe(result);
    expect(wasmMocks.exportCityJson).toHaveBeenCalledWith(bytes, '{"scale":0.01,"sequence":true}');
  });

  // JSON.stringify turns NaN and Infinity into null, which the writer reads
  // as "default scale": they must be refused, not exported at 1 mm.
  it.each([Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY])('refuses scale %s instead of exporting at the default', async (scale) => {
    const error = await exportCityJson(new Uint8Array([1]), { scale }).catch((e: unknown) => e);
    expect(cityJsonRefusalReason(error)).toMatch(/scale/);
    expect(wasmMocks.exportCityJson).not.toHaveBeenCalled();
  });
});
