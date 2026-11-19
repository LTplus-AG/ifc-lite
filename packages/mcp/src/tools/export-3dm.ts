/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { writeFile } from 'node:fs/promises';
import { exportRhinoScene, RHINO_UNITS, RHINO_COORDINATES, RHINO_LAYER_SCHEMES, RHINO_PROPERTIES, type RhinoSceneExportOptions } from '@ifc-lite/geometry';
import { RHINO_3DM_VERSIONS, writeRhino3dm, type Rhino3dmVersion } from '@ifc-lite/rhino3dm';
import { validateInput } from '../validate.js';
import type { Tool } from './types.js';
import { withIfcBytes, refusingEmpty } from './export-source.js';
import { okResult, resolveModel, fmtInt } from './util.js';
import { resolveSafePath } from '../safe-path.js';

const EMPTY_3DM = '3DM export produced 0 meshes - the model has no exportable render geometry.';

export const export3dmTool: Tool = {
  name: 'export_3dm',
  description: 'Save the whole model to Rhino .3dm with IFC layers, blocks, materials and user text via the shared Rust scene builder.',
  scope: 'export',
  inputSchema: {
    type: 'object',
    properties: {
      model_id: { type: 'string' }, file_path: { type: 'string' },
      units: { type: 'string', enum: [...RHINO_UNITS] },
      coordinates: { type: 'string', enum: [...RHINO_COORDINATES] },
      layerScheme: { type: 'string', enum: [...RHINO_LAYER_SCHEMES] },
      properties: { type: 'string', enum: [...RHINO_PROPERTIES] },
      instancing: { type: 'boolean' }, includeSpaces: { type: 'boolean' },
      normals: { type: 'boolean' }, layerSlicing: { type: 'boolean' },
      version: { type: 'integer', enum: [...RHINO_3DM_VERSIONS], default: RHINO_3DM_VERSIONS[0] },
    },
    required: ['file_path'], additionalProperties: false,
  },
  async handler(input, ctx) {
    // Validate before reading source bytes or initializing the geometry engine.
    const validation = validateInput(export3dmTool.inputSchema, input);
    if (!validation.valid) {
      throw new Error(`INVALID_INPUT: ${validation.errors.map(e => `${e.path}: ${e.message}`).join('; ')}`);
    }
    input = validation.value as Record<string, unknown>;
    const { model_id: _model, file_path: _path, version, ...given } = input;
    // Null means "absent" for every tool (validate.ts), as it already does for
    // `version`; drop it so serde applies the default instead of failing late.
    const options = Object.fromEntries(Object.entries(given).filter(([, value]) => value !== null));
    const m = resolveModel(ctx, input.model_id as string | undefined);
    const filePath = await resolveSafePath(input.file_path, ctx, 'write');
    // Build the scene inside the source scope, then release the source before
    // rhino3dm.js allocates its own heap for the archive. The Rhino scene wasm
    // stays loaded (its heap at peak size) for later exports in this process.
    const { bytes: data, objectCount, warnings } = await refusingEmpty(async () => {
      const scene = await withIfcBytes(m, bytes => exportRhinoScene(bytes, options as RhinoSceneExportOptions));
      return writeRhino3dm(scene, { version: version as Rhino3dmVersion | undefined });
    }, r => r.objectCount, EMPTY_3DM);
    await writeFile(filePath, data);
    return okResult(`Wrote ${fmtInt(data.length)} bytes to ${filePath}.`, {
      filePath, bytes: data.length, objects: objectCount, warnings,
    });
  },
};
