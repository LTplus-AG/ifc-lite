/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Compile a validated IFC-OPS program to real IFC4 via @ifc-lite/create.
 * Follows the dist-import pattern of scripts/moonshot/diff-spike/build-ifc.mjs
 * (this script is not a workspace package).
 */

import { fileURLToPath } from 'node:url';
import path from 'node:path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = path.resolve(__dirname, '../../..');

const { IfcCreator } = await import(
  path.join(REPO_ROOT, 'packages/create/dist/index.js')
);

/**
 * Map ops 1:1 onto IfcCreator calls. Assumes every op already passed
 * validateOp/applyOp (compile.mjs performs no validation of its own beyond
 * what the creator enforces). Returns { content, idMap, stats } where idMap
 * maps DSL ids to express ids.
 */
export function compileProgram(ops, { name = 'm5 constrained decoding' } = {}) {
  const creator = new IfcCreator({ Name: name, Schema: 'IFC4', Author: 'M5 harness' });
  const idMap = new Map();
  const sid = (ref) => idMap.get(ref);

  for (const op of ops) {
    switch (op.op) {
      case 'create_storey':
        idMap.set(op.id, creator.addIfcBuildingStorey({ Name: op.name, Elevation: op.elevation }));
        break;
      case 'create_slab':
        idMap.set(op.id, creator.addIfcSlab(sid(op.storey), {
          Name: `Slab ${op.id}`,
          Position: op.position,
          Width: op.width,
          Depth: op.depth,
          Thickness: op.thickness,
        }));
        break;
      case 'create_wall':
        idMap.set(op.id, creator.addIfcWall(sid(op.storey), {
          Name: `Wall ${op.id}`,
          Start: op.start,
          End: op.end,
          Thickness: op.thickness,
          Height: op.height,
        }));
        break;
      case 'add_window':
        idMap.set(op.id, creator.addIfcWallWindow(sid(op.wall), {
          Name: `Window ${op.id}`,
          Position: [op.along, 0, op.sill],
          Width: op.width,
          Height: op.height,
        }));
        break;
      case 'add_door':
        idMap.set(op.id, creator.addIfcWallDoor(sid(op.wall), {
          Name: `Door ${op.id}`,
          Position: [op.along, 0, 0],
          Width: op.width,
          Height: op.height,
        }));
        break;
      case 'create_column':
        idMap.set(op.id, creator.addIfcColumn(sid(op.storey), {
          Name: `Column ${op.id}`,
          Position: op.position,
          Width: op.width,
          Depth: op.depth,
          Height: op.height,
        }));
        break;
      case 'create_beam':
        idMap.set(op.id, creator.addIfcBeam(sid(op.storey), {
          Name: `Beam ${op.id}`,
          Start: op.start,
          End: op.end,
          Width: op.width,
          Height: op.height,
        }));
        break;
      case 'create_space':
        idMap.set(op.id, creator.addIfcSpace(sid(op.storey), {
          Name: op.name,
          LongName: op.name,
          Position: op.position,
          Width: op.width,
          Depth: op.depth,
          Height: op.height,
        }));
        break;
      case 'set_property':
        creator.addIfcPropertySet(sid(op.target), {
          Name: op.pset,
          Properties: [{ Name: op.name, NominalValue: op.value }],
        });
        break;
      default:
        throw new Error(`compileProgram: unknown op "${op.op}"`);
    }
  }

  const result = creator.toIfc();
  return { content: result.content, idMap, stats: result.stats };
}
