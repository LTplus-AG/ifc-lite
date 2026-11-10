/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The probe registry. A probe is `{ name, level, covers?(row), run(rows, ctx) }`:
 * `run` receives every row it covers (default: every row the level applies to)
 * and returns a Map of row id -> `{ status, reason?, evidence? }`, with status
 * one of pass | partial | fail | error | skip. Several probes may cover one
 * cell; the best result counts.
 *
 * `unwritten()` registers a named probe that does not exist yet. It scores as
 * unmet, so a level is never "absent", only measured or owed. Replace the
 * placeholder with the real probe in the same PR that makes it pass or fail.
 */

import capabilities from './capabilities.mjs';
import convert from './convert.mjs';
import create from './create.mjs';
import fixture from './fixture.mjs';
import read from './read.mjs';

export function unwritten(level, name, plan, covers) {
  return {
    name,
    level,
    unwritten: true,
    ...(covers ? { covers } : {}),
    async run(rows) {
      return new Map(rows.map((r) => [r.id, { status: 'unwritten', reason: `probe ${name} not written yet: ${plan}` }]));
    },
  };
}

const cap = (id) => (row) => row.id === id;

export const PROBES = [
  fixture,
  read,
  create,
  convert,
  ...capabilities,
  unwritten('card', 'card:structural-properties-card', 'select the entity (or the item that references it) in the viewer and assert the properties card shows its attribute values'),
  unwritten('render', 'render:mesh-or-glyph', 'load a fixture carrying the entity and assert a mesh or glyph is drawn for it'),
  unwritten('edit', 'edit:in-store-update', 'change an attribute of the entity in a store, export, re-read and assert the new value and an intact sub-graph'),
  unwritten('remove', 'remove:in-store-owned-subgraph', 'remove the entity in a store, export and assert it and the records it alone owns are gone, and nothing dangles'),
  unwritten('capability', 'capability:analytical-physical-toggle', 'switch the viewer between the analytical and physical model and assert which products are visible', cap('cap/analytical-physical-toggle')),
  unwritten('capability', 'capability:derive-analytical-model', 'derive members and connections from a physical frame and compare axes, ends and links to the reference analytical model', cap('cap/derive-analytical-model')),
  unwritten('capability', 'capability:check-unlinked-load-bearing', 'run the check on a fixture with a load-bearing element lacking a structural item and assert exactly that element is reported', cap('cap/check-unlinked-load-bearing')),
  unwritten('capability', 'capability:check-axis-drift', 'offset one member from its physical element and assert the check reports it with the distance', cap('cap/check-axis-drift')),
  unwritten('capability', 'capability:check-unconnected-member', 'remove one IfcRelConnectsStructuralMember and assert the check reports that member', cap('cap/check-unconnected-member')),
  unwritten('capability', 'capability:check-stale-after-physical-change', 'move a physical element and assert its linked item is reported stale', cap('cap/check-stale-after-physical-change')),
  unwritten('capability', 'capability:cli-structural-command', 'run the CLI structural command on a fixture and assert its JSON lists the members, loads and links', cap('cap/cli-structural-command')),
];
