/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { RHINO_UNITS, RHINO_COORDINATES, RHINO_LAYER_SCHEMES, RHINO_PROPERTIES, exportRhinoScene, isNoRenderGeometryError, type RhinoSceneExportOptions } from '@ifc-lite/geometry';
import { RHINO_3DM_VERSIONS, writeRhino3dm, type Rhino3dmVersion } from '@ifc-lite/rhino3dm';
import { getFlag, hasFlag, fatal, writeOutput } from '../output.js';
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
  // `--out --units feet` must not write a file named `--units`; `./--units` still can.
  if (out.startsWith('--')) fatal(`--out needs a file path, got the option ${out}`);
  return { out, ...rhinoFlags(args) };
}

const emptyMessage = (isolated?: number[]) => isolated
  ? '3DM export produced 0 meshes - the matched entities have no exportable render geometry. Check --type/--storey/--where/--limit.'
  : '3DM export produced 0 meshes - the model has no exportable render geometry.';

export async function export3dm(bytes: Uint8Array, { out, options, version }: ReturnType<typeof validateRhinoArgs>, isolated?: number[]): Promise<void> {
  try {
    const scene = await exportRhinoScene(bytes, { ...options, ...(isolated ? { isolated } : {}) });
    const { bytes: data, warnings, objectCount } = await writeRhino3dm(scene, { version });
    // Defense-in-depth beside the Rust refusal: never write a zero-object archive.
    if (objectCount === 0) fatal(emptyMessage(isolated));
    for (const warning of warnings) logger.warn(warning);
    await writeOutput(data, out);
  } catch (error) {
    if (isNoRenderGeometryError(error)) {
      fatal(emptyMessage(isolated));
    }
    throw error;
  }
}
