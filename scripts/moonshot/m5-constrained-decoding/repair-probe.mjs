/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Adversarial probe of the constrained-decoding repair loop. The 12-task
 * exam finished with ZERO live repairs (Haiku one-shot every brief), so
 * this probe deliberately hands the model a brief whose literal numbers
 * violate the DSL fit rules (window sill 2.0 + height 1.4 on a 3 m wall
 * needs 3.4 m > the 2.95 m allowed), forcing the validator to reject and
 * the repair re-prompt to fire. Pass criterion: the loop converges to a
 * compiling program within the repair cap, with >= 1 repair actually used.
 *
 * Results are appended to results.json under summary.repairProbe and kept
 * OUT of the exam aggregates.
 */

import fs from 'node:fs';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { newState, validateOp, applyOp, describeState, DSL_SPEC } from './dsl.mjs';
import { compileProgram } from './compile.mjs';
import { kernelGate, measureModel } from './kernel.mjs';
import { initModel, callModel, extractJsonArray, totalCalls } from './model.mjs';
import { acceptOps } from './run-exam.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SCRATCH = process.env.M5_SCRATCH
  ?? path.join(tmpdir(), 'ifc-lite-m5');
const log = (...a) => process.stderr.write(`[m5-probe] ${a.join(' ')}\n`);
const MAX_REPAIRS = 3;

const BRIEF = 'One storey at elevation 0 with a single wall, 6 m long, 0.3 m thick, 3 m high, containing one window 1.6 m wide and 1.4 m high with a sill at exactly 2.0 m, centred on the wall.';

function genPrompt() {
  return [
    'You translate natural-language building briefs into IFC-OPS programs.',
    '',
    DSL_SPEC,
    '',
    `BRIEF: ${BRIEF}`,
    '',
    'Follow the brief numbers EXACTLY as stated.',
    'Output ONLY the complete op program as a raw JSON array of op objects. No prose, no markdown fences.',
  ].join('\n');
}

function repairPrompt(accepted, state, failure) {
  const parts = [
    'You are completing an IFC-OPS program that is being validated op by op.',
    '', DSL_SPEC, '', `BRIEF: ${BRIEF}`, '',
  ];
  if (accepted.length > 0) {
    parts.push('These ops are already ACCEPTED and applied. Do NOT repeat any of them:',
      JSON.stringify(accepted), '', 'Current applied state:', describeState(state), '');
  }
  if (failure.op !== undefined) {
    parts.push('Your next op was REJECTED by the validator/kernel:', JSON.stringify(failure.op),
      `Error: ${failure.error}`,
      'Adjust the offending values as little as possible so the op becomes valid, and continue.', '');
  } else {
    parts.push(`Your previous response could not be used: ${failure.error}`, '');
  }
  parts.push('Output ONLY a raw JSON array with the corrected REMAINING ops. No prose, no fences.');
  return parts.join('\n');
}

async function main() {
  // Standalone runs must not depend on run-exam.mjs having created the
  // scratch tree first.
  fs.mkdirSync(path.join(SCRATCH, 'ifc'), { recursive: true });
  initModel(path.join(SCRATCH, 'raw'));
  const accepted = [];
  const stateRef = { state: newState() };
  let repairs = 0;
  let exhausted = false;
  const rejections = [];

  let res = await callModel(genPrompt(), 'probe-r0');
  for (;;) {
    let failure = null;
    if (!res.ok) failure = { error: `model call failed: ${res.error}` };
    else {
      const ext = extractJsonArray(res.text);
      failure = ext.ok ? await acceptOps(accepted, stateRef, ext.ops) : { error: ext.error };
    }
    if (!failure) break;
    rejections.push({ op: failure.op ?? null, error: failure.error });
    log(`rejection: ${failure.error.slice(0, 160)}`);
    if (repairs >= MAX_REPAIRS) { exhausted = true; break; }
    repairs += 1;
    res = await callModel(repairPrompt(accepted, stateRef.state, failure), `probe-r${repairs}`);
  }

  let outcome = { repairs, exhausted, rejections, opsCount: accepted.length, compileOk: false };
  if (accepted.length > 0) {
    const { content } = compileProgram(accepted);
    fs.writeFileSync(path.join(SCRATCH, 'ifc', 'probe-constrained.ifc'), content);
    const m = await measureModel(content);
    outcome.compileOk = m.schema.errors === 0 && m.meshedElements > 0;
    outcome.counts = m.counts;
    outcome.finalOps = accepted;
  }
  log(`probe outcome: repairs=${repairs} exhausted=${exhausted} ops=${accepted.length} compileOk=${outcome.compileOk}`);

  const resultsPath = path.join(__dirname, 'results.json');
  const data = JSON.parse(fs.readFileSync(resultsPath, 'utf8'));
  if (!data.summary || typeof data.summary !== 'object') {
    throw new Error(`${resultsPath} has no summary object; run the exam first (the probe annotates its results)`);
  }
  data.summary.repairProbe = { brief: BRIEF, ...outcome, modelCalls: totalCalls() };
  fs.writeFileSync(resultsPath, JSON.stringify(data, null, 2));
  log('DONE');
}

main().then(() => process.exit(0)).catch((e) => { log(`FATAL: ${e.stack}`); process.exit(1); });
