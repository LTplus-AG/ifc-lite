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
import card from './card.mjs';
import convert from './convert.mjs';
import create from './create.mjs';
import fixture from './fixture.mjs';
import read from './read.mjs';
import render from './render.mjs';
import renderMembers from './render-members.mjs';
import edit from './edit.mjs';
import remove from './remove.mjs';

export function unwritten(level, name, plan, covers) {
  return {
    name,
    level,
    covers,
    async run(rows) {
      return new Map(rows.map((r) => [r.id, { status: 'unwritten', reason: `probe ${name} not written yet: ${plan}` }]));
    },
  };
}

export const PROBES = [
  fixture,
  read,
  card,
  create,
  convert,
  render,
  renderMembers,
  edit,
  remove,
  ...capabilities,
];
