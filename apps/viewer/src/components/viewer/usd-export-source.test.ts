/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Unit coverage for the USD export source gate. The mutation-vs-raw routing is
 * `resolveHbjsonMutationSource` (covered in `hbjson-export-source.test.ts`) and
 * the end-to-end export + WASM disposal is `UsdExportDialog.test.tsx`; this
 * suite locks which models the USD exporter is offered — in particular that
 * `.ifcx` (USD-flavored JSON, a separate exporter) is excluded so it can never
 * be fed to the STEP-byte `exportUsd` and produce a silent empty stage.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { FederatedModel } from '@/store/types.js';
import { isUsdExportableModel } from './usd-export-source.js';

function model(name: string | null): FederatedModel {
  return {
    id: 'm',
    name: name ?? 'unnamed',
    ifcDataStore: null,
    geometryResult: null,
    visible: true,
    collapsed: false,
    schemaVersion: 'IFC4',
    loadedAt: 1,
    fileSize: 3,
    sourceFile: name ? new File([new Uint8Array([1])], name) : undefined,
    idOffset: 0,
    maxExpressId: 0,
  };
}

describe('isUsdExportableModel', () => {
  it('accepts STEP-backed IFC sources (.ifc, .ifczip), case-insensitively', () => {
    assert.equal(isUsdExportableModel(model('building.ifc')), true);
    assert.equal(isUsdExportableModel(model('site.IFC')), true);
    assert.equal(isUsdExportableModel(model('archive.ifczip')), true);
    assert.equal(isUsdExportableModel(model('archive.IfcZip')), true);
  });

  it('excludes .ifcx (USD-flavored JSON — a separate exporter, not a STEP source)', () => {
    assert.equal(isUsdExportableModel(model('model.ifcx')), false);
  });

  it('excludes models with no source file (cache-restored) and non-IFC sources', () => {
    assert.equal(isUsdExportableModel(model(null)), false);
    assert.equal(isUsdExportableModel(model('scan.glb')), false);
    assert.equal(isUsdExportableModel(model('cloud.las')), false);
  });
});
