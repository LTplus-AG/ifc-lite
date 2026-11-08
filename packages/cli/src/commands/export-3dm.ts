/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { writeFile } from 'node:fs/promises';
import { RHINO_UNITS, RHINO_COORDINATES, RHINO_LAYER_SCHEMES, RHINO_PROPERTIES, isNoRenderGeometryError, type GeometryProcessor, type RhinoSceneExportOptions } from '@ifc-lite/geometry';
import { RHINO_3DM_VERSIONS, writeRhino3dm, type Rhino3dmVersion } from '@ifc-lite/rhino3dm';
import { getFlag, hasFlag, fatal } from '../output.js';
import { logger } from '../logger.js';

function choice<const T extends string>(args: string[], flag: string, values: readonly T[]): T | undefined {
  const value = getFlag(args, flag);
  if (args.includes(flag) && (value === undefined || !values.includes(value as T))) {
    fatal(`Invalid ${flag}: expected ${values.join('|')}`);
  }
  return value as T | undefined;
}

export function rhinoFlags(args: string[]): { options: RhinoSceneExportOptions; version: Rhino3dmVersion | undefined } {
  const version = choice(args, '--3dm-version', RHINO_3DM_VERSIONS.map(v => `${v}`));
  return {
    options: {
      units: choice(args, '--units', RHINO_UNITS),
      coordinates: choice(args, '--coordinates', RHINO_COORDINATES),
      layerScheme: choice(args, '--layers', RHINO_LAYER_SCHEMES),
      properties: choice(args, '--properties', RHINO_PROPERTIES),
      instancing: hasFlag(args, '--no-instancing') ? false : undefined,
      includeSpaces: hasFlag(args, '--no-spaces') ? false : undefined,
      normals: hasFlag(args, '--no-normals') ? false : undefined,
      layerSlicing: hasFlag(args, '--layer-slicing') ? true : undefined,
    },
    version: version === undefined ? undefined : Number(version) as Rhino3dmVersion,
  };
}

export function validateRhinoArgs(args: string[]) {
  const out = getFlag(args, '--out');
  if (!out) fatal('--out is required for 3DM export');
  return { out, ...rhinoFlags(args) };
}

export async function export3dm(gp: GeometryProcessor, bytes: Uint8Array, { out, options, version }: ReturnType<typeof validateRhinoArgs>, isolated?: number[]): Promise<void> {
  try {
    const scene = gp.exportRhinoScene(bytes, { ...options, ...(isolated ? { isolated } : {}) });
    const { bytes: data, warnings } = await writeRhino3dm(scene, { version });
    for (const warning of warnings) logger.warn(warning);
    await writeFile(out, data);
    logger.info(`Written to ${out}`);
  } catch (error) {
    if (isNoRenderGeometryError(error)) fatal('3DM export produced 0 meshes - the model has no exportable render geometry.');
    throw error;
  }
}
