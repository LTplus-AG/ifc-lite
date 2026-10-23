/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { afterEach, describe, expect, it, vi } from 'vitest';
import type { IfcAPI } from '@ifc-lite/wasm';
import { runDomainExport } from './domain-export-call.js';
import { NO_RENDER_GEOMETRY, TERRAIN_REFUSED } from './export-errors.js';

const api = {} as IfcAPI;
const content = new Uint8Array(4);

describe('runDomainExport', () => {
  afterEach(() => vi.restoreAllMocks());

  it('logs a failure, reports it and rethrows it', () => {
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {});
    const onError = vi.fn();
    const failure = new Error('RuntimeError: unreachable');
    expect(() => runDomainExport(api, 'exportUsd', content, () => { throw failure; }, onError)).toThrow(failure);
    expect(onError).toHaveBeenCalledWith(failure);
    expect(logged).toHaveBeenCalled();
  });

  it('rethrows a terrain refusal without logging it as a failure (#7600)', () => {
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {});
    const onError = vi.fn();
    const refusal = new Error(`${TERRAIN_REFUSED}: context #5 has no IfcMapConversion`);
    expect(() => runDomainExport(api, 'exportLandXmlTerrain', content, () => { throw refusal; }, onError)).toThrow(refusal);
    expect(onError).toHaveBeenCalledWith(refusal);
    expect(logged).not.toHaveBeenCalled();
  });

  it('rethrows a NO_RENDER_GEOMETRY refusal without logging it as a failure (#7766)', () => {
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {});
    const onError = vi.fn();
    const refusal = new Error(`${NO_RENDER_GEOMETRY}: no mesh would be written`);
    expect(() => runDomainExport(api, 'exportUsd', content, () => { throw refusal; }, onError)).toThrow(refusal);
    expect(onError).toHaveBeenCalledWith(refusal);
    expect(logged).not.toHaveBeenCalled();
  });
});
