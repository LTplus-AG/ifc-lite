/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, it, expect } from 'vitest';
import { getPropertySets, type IfcSchemaVersion } from '@ifc-lite/data';
import { LIST_PRESETS } from './presets.js';

// Presets ship buildingSMART-published set names (`Pset_*` / `Qto_*`), so every
// member they reference has to be a real EXPRESS name in some supported schema.
// A preset naming a member that no schema defines renders a permanently empty
// column: the value lookup is an exact string match against the model, so it
// can never hit. #1873 shipped exactly that — the Wall Schedule asked for
// `Qto_WallBaseQuantities.NetArea`, which is `NetSideArea` in every schema.
const SCHEMA_VERSIONS: IfcSchemaVersion[] = ['IFC2X3', 'IFC4', 'IFC4X3'];

async function buildSchemaIndex(): Promise<Map<string, Set<string>>> {
  const index = new Map<string, Set<string>>();
  for (const version of SCHEMA_VERSIONS) {
    for (const set of await getPropertySets(version)) {
      let members = index.get(set.name);
      if (!members) {
        members = new Set<string>();
        index.set(set.name, members);
      }
      for (const property of set.properties) members.add(property.name);
    }
  }
  return index;
}

describe('LIST_PRESETS schema fidelity', () => {
  it('references only Pset_/Qto_ members defined by a supported IFC schema', async () => {
    const index = await buildSchemaIndex();

    const invalid: string[] = [];
    for (const preset of LIST_PRESETS) {
      for (const column of preset.columns) {
        if (column.source !== 'property' && column.source !== 'quantity') continue;
        const setName = column.psetName;
        const member = column.propertyName;
        if (!setName || !member) continue;
        // Only buildingSMART-published sets are schema-checkable; a
        // user-defined set is out of scope by definition.
        if (!setName.startsWith('Pset_') && !setName.startsWith('Qto_')) continue;

        const members = index.get(setName);
        if (!members) {
          invalid.push(`${preset.name}: unknown set ${setName}`);
        } else if (!members.has(member)) {
          invalid.push(
            `${preset.name}: ${setName}.${member} is not defined ` +
              `(valid: ${[...members].sort().join(', ')})`,
          );
        }
      }
    }

    expect(invalid).toEqual([]);
  });

  it('asks walls for NetSideArea, the real Qto_WallBaseQuantities member (#1873)', async () => {
    const wallSchedule = LIST_PRESETS.find((p) => p.name === 'Wall Schedule');
    expect(wallSchedule, 'Wall Schedule preset missing').toBeDefined();

    const wallQuantities = wallSchedule!.columns
      .filter((c) => c.source === 'quantity' && c.psetName === 'Qto_WallBaseQuantities')
      .map((c) => c.propertyName);

    expect(wallQuantities).toContain('NetSideArea');
    expect(wallQuantities).not.toContain('NetArea');
  });
});
