/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The format groups are the source of every extension list. These pin what
 * the lists held before the groups existed, so regrouping cannot change what
 * a picker offers or the drop guard admits, and state the invariant that
 * keeps the welcome card honest: every extension that loads is in one group.
 */
import '../test/setup-dom.js';
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { splitDxfFiles } from '@/hooks/ingest/dxfIngest';
import { GEO_RASTER_FILE_EXTENSIONS } from '@/lib/terrain-imagery/raster-bundle';
import {
  DROP_FORMAT_GROUPS,
  FILE_ACCEPT,
  MODEL_FILE_EXTENSIONS,
  PICKER_FILE_EXTENSIONS,
  REFERENCE_FILE_EXTENSIONS,
  isSupportedModelFile,
} from './supported-model-files.js';

const MODEL = ['.ifc', '.ifcx', '.ifczip', '.glb', '.gltf', '.las', '.laz', '.ply', '.pcd', '.e57', '.pts', '.xyz', '.xml'];
const PICKER = [
  ...MODEL, '.splat', '.dxf', '.bin', '.png', '.jpg', '.jpeg',
  '.tif', '.tiff', '.tfw', '.tifw', '.pgw', '.pngw', '.jgw', '.jpgw', '.wld', '.prj',
];

const named = (name: string) => new File([], name);
const groupsHolding = (ext: string) => DROP_FORMAT_GROUPS.filter((group) => group.extensions.includes(ext));

describe('supported file formats, derived from the format groups', () => {
  it('keeps the model, reference and picker lists at their values and order', () => {
    assert.deepEqual([...MODEL_FILE_EXTENSIONS], MODEL);
    assert.deepEqual([...REFERENCE_FILE_EXTENSIONS], ['.dxf']);
    assert.deepEqual([...PICKER_FILE_EXTENSIONS], PICKER);
    assert.equal(FILE_ACCEPT, PICKER.join(','));
  });

  it('admits model and capture files through the drop guard, and nothing else the pickers offer', () => {
    for (const ext of [...MODEL, '.splat']) assert.equal(isSupportedModelFile(named(`Site${ext.toUpperCase()}`)), true, ext);
    for (const ext of PICKER.filter((e) => !MODEL.includes(e) && e !== '.splat')) {
      assert.equal(isSupportedModelFile(named(`site${ext}`)), false, `${ext} is not a model on its own`);
    }
  });

  it('puts every model extension in exactly one group', () => {
    for (const ext of MODEL_FILE_EXTENSIONS) assert.equal(groupsHolding(ext).length, 1, ext);
  });

  it('lists for a drop exactly what the drop path opens: models, captures and underlays', () => {
    // The drop handler splits underlays off with `splitDxfFiles`, then admits
    // the rest through `isSupportedModelFile` (ViewportContainer.tsx).
    const opensOnDrop = [...PICKER_FILE_EXTENSIONS].filter((ext) => {
      const { dxfFiles, modelFiles } = splitDxfFiles([named(`site${ext}`)]);
      return dxfFiles.length > 0 || modelFiles.some(isSupportedModelFile);
    });
    assert.deepEqual(DROP_FORMAT_GROUPS.flatMap((group) => group.extensions).sort(), opensOnDrop.sort());
    assert.deepEqual(splitDxfFiles(REFERENCE_FILE_EXTENSIONS.map((ext) => named(`plan${ext}`))).modelFiles, [],
      'every reference extension takes the underlay path');
    // Rasters need a loaded terrain, and .3dm import has not shipped.
    for (const ext of [...GEO_RASTER_FILE_EXTENSIONS, '.3dm']) assert.equal(groupsHolding(ext).length, 0, ext);
  });
});
