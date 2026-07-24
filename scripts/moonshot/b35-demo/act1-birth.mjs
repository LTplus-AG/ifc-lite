/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * ACT 1 -- BIRTH.
 *
 * World-gym generates a deterministic seeded building (M2), the labeler
 * runs the real check pipeline over the serialized bytes in-process, and the
 * five reward channels score the newborn model. All imports are the exact
 * modules `ifc-lite gym` / the benchmark factory use -- nothing is
 * reimplemented here.
 */

import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import { generateModel } from '../../../tools/world-gym/generator.mjs';
import { labelModel } from '../../../tools/world-gym/labeler.mjs';
import { initChecks } from '../../../tools/world-gym/lib/checks.mjs';
import { computeRewardChannels, CHANNEL_NAMES } from '../../../tools/world-gym/lib/reward-channels.mjs';
import { OUT_DIR, banner, round, say, short } from './util.mjs';

export async function runAct1({ seed }) {
  banner(1, 'BIRTH', `a building is born from seed ${seed} -- same seed, same bytes, forever`);

  await initChecks(); // one warm GeometryProcessor for the whole demo

  const model = generateModel(seed, 'auto');
  const filePath = path.join(OUT_DIR, `act1-birth-${seed}.ifc`);
  await writeFile(filePath, model.content, 'utf-8');

  const line = await labelModel(model, filePath, { engine: 'in-process' });
  const channels = computeRewardChannels(line); // includes the determinism re-proof (regenerate + hash)

  say(`  family:        ${model.family} (picked by the seed itself)`);
  say(`  entities:      ${line.entityCount} across ${line.storeyCount} storey(s), ${line.fileSize} bytes`);
  say(`  sha256:        ${short(line.sha256)}... (regenerable from the seed alone)`);
  say(`  schema:        valid=${line.schemaCheck.valid} (${line.schemaCheck.errors} errors, ${line.schemaCheck.warnings} warnings)`);
  say(`  clashes:       ${line.clash.total} (clean by construction)`);
  say('  reward channels (the five scores every agent edit gets judged by):');
  for (const name of CHANNEL_NAMES) {
    const v = channels[name];
    say(`    ${name.padEnd(22)} ${v === null ? 'n/a' : v}`);
  }

  const allChannelsPerfect = CHANNEL_NAMES.every((n) => channels[n] === 1);
  say('');
  say(`  HEADLINE: ${line.entityCount} entities born deterministic, all five reward channels = ${allChannelsPerfect ? '1.0' : 'NOT all 1.0 (unexpected for a clean model)'}`);

  return {
    model, // handed to acts 2 and 4
    line,
    deterministic: {
      seed,
      family: model.family,
      entityCount: line.entityCount,
      fileSize: line.fileSize,
      storeyCount: line.storeyCount,
      sha256: line.sha256,
      groundTruthTotals: Object.fromEntries(
        Object.entries(line.groundTruth?.totals ?? {}).map(([k, v]) => [k, round(v)]),
      ),
      schema: { valid: line.schemaCheck.valid, errors: line.schemaCheck.errors, warnings: line.schemaCheck.warnings },
      clashTotal: line.clash.total,
      rewardChannels: channels,
      allChannelsPerfect,
    },
  };
}
