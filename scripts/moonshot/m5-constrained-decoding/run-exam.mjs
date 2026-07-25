/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * M5 midterm exam runner (bet B2.3): constrained decoding vs unconstrained
 * baseline over the same base model (Haiku via `claude -p`).
 *
 * Constrained arm: full-program proposals, validated op by op against the
 * IFC-OPS grammar (dsl.mjs) AND the kernel (compile the accepted prefix,
 * parse, schema-validate, mesh, confirm the new element has real geometry).
 * The first rejected op triggers a bounded repair re-prompt carrying the
 * validator/kernel error and the applied-state summary. Ops after a
 * rejected op are discarded. Emitted programs therefore compile by
 * construction. Repair cap: 3 per task; exhaustion is reported.
 *
 * Baseline arm: the SAME initial prompt (same DSL spec, same brief), one
 * shot, no feedback. Compiled leniently (invalid ops skipped) for quality
 * scoring; strict compile = JSON parses and every op is grammar-valid.
 *
 * Usage:
 *   node run-exam.mjs                 # full exam, both arms, 12 tasks
 *   node run-exam.mjs --tasks T01,T03 # subset
 *   node run-exam.mjs --selftest      # pipeline check, zero model calls
 */

import fs from 'node:fs';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { newState, validateOp, applyOp, describeState, DSL_SPEC } from './dsl.mjs';
import { compileProgram } from './compile.mjs';
import { kernelGate, measureModel } from './kernel.mjs';
import { TASKS, scoreTask } from './tasks.mjs';
import { initModel, callModel, extractJsonArray, totalCalls, MODEL } from './model.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SCRATCH = process.env.M5_SCRATCH
  ?? path.join(tmpdir(), 'ifc-lite-m5');
const MAX_REPAIRS = 3;

const log = (...a) => process.stderr.write(`[m5] ${a.join(' ')}\n`);

export function genPrompt(task) {
  return [
    'You translate natural-language building briefs into IFC-OPS programs.',
    '',
    DSL_SPEC,
    '',
    `BRIEF: ${task.brief}`,
    '',
    'Output ONLY the complete op program as a raw JSON array of op objects. No prose, no markdown fences.',
  ].join('\n');
}

export function repairPrompt(task, accepted, state, failure) {
  const parts = [
    'You are completing an IFC-OPS program that is being validated op by op.',
    '',
    DSL_SPEC,
    '',
    `BRIEF: ${task.brief}`,
    '',
  ];
  if (accepted.length > 0) {
    parts.push(
      'These ops are already ACCEPTED and applied. Do NOT repeat any of them:',
      JSON.stringify(accepted),
      '',
      'Current applied state:',
      describeState(state),
      '',
    );
  }
  if (failure.op !== undefined) {
    parts.push(
      'Your next op was REJECTED by the validator/kernel:',
      JSON.stringify(failure.op),
      `Error: ${failure.error}`,
      'Any ops you proposed after the rejected one were discarded.',
      '',
    );
  } else {
    parts.push(`Your previous response could not be used: ${failure.error}`, '');
  }
  parts.push(
    accepted.length > 0
      ? 'Output ONLY a raw JSON array with the corrected REMAINING ops that complete the brief (do not repeat accepted ops). No prose, no fences.'
      : 'Output ONLY the complete corrected op program as a raw JSON array. No prose, no fences.',
  );
  return parts.join('\n');
}

function rebuildState(ops) {
  const state = newState();
  for (const op of ops) applyOp(state, op);
  return state;
}

/** Validate + kernel-gate ops sequentially, extending `accepted` in place.
 *  Returns null when every op was accepted, else { op, error }. */
export async function acceptOps(accepted, stateRef, ops) {
  for (const op of ops) {
    const v = validateOp(stateRef.state, op);
    if (!v.ok) return { op, error: v.error };
    applyOp(stateRef.state, op);
    accepted.push(op);
    let gate;
    try {
      const { content, idMap } = compileProgram(accepted);
      const newIds = op.op === 'set_property' || op.op === 'create_storey' ? [] : [idMap.get(op.id)];
      gate = await kernelGate(content, newIds);
    } catch (e) {
      gate = { ok: false, error: `compiler rejected the op: ${e.message}` };
    }
    if (!gate.ok) {
      accepted.pop();
      stateRef.state = rebuildState(accepted);
      return { op, error: gate.error };
    }
  }
  return null;
}

export async function runConstrained(task) {
  const accepted = [];
  const stateRef = { state: newState() };
  let repairs = 0;
  let exhausted = false;
  const errors = [];

  let res = await callModel(genPrompt(task), `${task.id}-con-r0`);
  for (;;) {
    let failure = null;
    if (!res.ok) {
      failure = { error: `model call failed: ${res.error}` };
    } else {
      const ext = extractJsonArray(res.text);
      if (!ext.ok) {
        failure = { error: ext.error };
      } else {
        failure = await acceptOps(accepted, stateRef, ext.ops);
      }
    }
    if (!failure) break;
    errors.push(failure.error);
    if (repairs >= MAX_REPAIRS) { exhausted = true; break; }
    repairs += 1;
    log(`  ${task.id} constrained repair ${repairs}: ${failure.error.slice(0, 140)}`);
    res = await callModel(repairPrompt(task, accepted, stateRef.state, failure), `${task.id}-con-r${repairs}`);
  }

  return { accepted, repairs, exhausted, errors };
}

export function lenientSalvage(ops) {
  const state = newState();
  const kept = [];
  let skipped = 0;
  for (const op of ops) {
    const v = validateOp(state, op);
    if (v.ok) {
      applyOp(state, op);
      kept.push(op);
    } else {
      skipped += 1;
    }
  }
  return { kept, skipped };
}

export async function finishArm(task, arm, ops, extra) {
  const record = { task: task.id, difficulty: task.difficulty, arm, ...extra, opsCount: ops.length };
  if (ops.length === 0) {
    return { ...record, emitted: false, compileOk: false, quality: 0, criteria: [] };
  }
  let content;
  try {
    ({ content } = compileProgram(ops));
  } catch (e) {
    return { ...record, emitted: false, compileOk: false, compileError: e.message, quality: 0, criteria: [] };
  }
  const ifcPath = path.join(SCRATCH, 'ifc', `${task.id}-${arm}.ifc`);
  // Records carry the SCRATCH-relative path only: absolute paths leak
  // usernames/session temp dirs into the committed results artifacts.
  const ifcPathRel = path.join('ifc', `${task.id}-${arm}.ifc`);
  fs.writeFileSync(ifcPath, content);
  let m;
  try {
    m = await measureModel(content);
  } catch (e) {
    return { ...record, emitted: true, compileOk: false, compileError: `parse/measure failed: ${e.message}`, quality: 0, criteria: [], ifcPath: ifcPathRel };
  }
  const score = scoreTask(task, m);
  return {
    ...record,
    emitted: true,
    compileOk: m.schema.errors === 0,
    quality: score.quality,
    schemaFactor: score.schemaFactor,
    clashFactor: score.clashFactor,
    criteria: score.criteria,
    schema: m.schema,
    clash: m.clash,
    counts: m.counts,
    ifcPath: ifcPathRel,
  };
}

async function selftest() {
  const program = [
    { op: 'create_storey', id: 's1', name: 'Ground', elevation: 0 },
    { op: 'create_slab', id: 'slab1', storey: 's1', position: [0, 0, 0], width: 10, depth: 8, thickness: 0.2 },
    { op: 'create_wall', id: 'w1', storey: 's1', start: [0, 0.1, 0.2], end: [10, 0.1, 0.2], thickness: 0.2, height: 3 },
    { op: 'add_window', id: 'win1', wall: 'w1', along: 5, sill: 0.9, width: 1.2, height: 1.4 },
    { op: 'add_door', id: 'd1', wall: 'w1', along: 1.5, width: 1.0, height: 2.1 },
    { op: 'create_column', id: 'c1', storey: 's1', position: [5, 4, 0.2], width: 0.3, depth: 0.3, height: 3 },
    { op: 'create_beam', id: 'b1', storey: 's1', start: [2, 4, 2.8], end: [8, 4, 2.8], width: 0.3, height: 0.5 },
    { op: 'create_space', id: 'sp1', storey: 's1', name: 'Room', position: [1, 1, 0.2], width: 5, depth: 4, height: 2.8 },
    { op: 'set_property', target: 'w1', pset: 'Pset_WallCommon', name: 'FireRating', value: 'REI60' },
  ];
  const accepted = [];
  const stateRef = { state: newState() };
  const failure = await acceptOps(accepted, stateRef, program);
  if (failure) {
    log(`SELFTEST FAIL at op ${JSON.stringify(failure.op)}: ${failure.error}`);
    process.exit(1);
  }
  const { content } = compileProgram(accepted);
  const m = await measureModel(content);
  log('selftest measurements: ' + JSON.stringify({
    counts: m.counts,
    footprint: m.footprint,
    overall: m.overall,
    windowArea: Math.round(m.windowArea * 100) / 100,
    wallGrossArea: Math.round(m.wallGrossArea * 100) / 100,
    spaceArea: Math.round(m.spaceArea * 100) / 100,
    schema: m.schema,
    clash: m.clash,
    fireRatingFraction: m.propertyFraction('IFCWALL', 'Pset_WallCommon', 'FireRating', 'REI60'),
  }));
  // Negative checks: each must be rejected.
  const bad = [
    [{ op: 'create_wall', id: 'wx', storey: 'nope', start: [0, 0, 0], end: [5, 0, 0], thickness: 0.2, height: 3 }, 'unknown storey'],
    [{ op: 'add_window', id: 'wy', wall: 'w1', along: 9.9, sill: 0.9, width: 1.2, height: 1.4 }, 'does not fit along'],
    [{ op: 'add_window', id: 'wz', wall: 'w1', along: 5.3, sill: 1.0, width: 1.2, height: 1.4 }, 'overlap'],
    [{ op: 'create_slab', id: 'slab1', storey: 's1', position: [0, 0, 0], width: 5, depth: 5, thickness: 0.2 }, 'duplicate id'],
    [{ op: 'teleport', id: 'zz' }, 'unknown op'],
    [{ op: 'create_column', id: 'cz', storey: 's1', position: [1, 1, 0], width: -1, depth: 0.3, height: 3 }, 'negative dim'],
  ];
  for (const [op, why] of bad) {
    const v = validateOp(stateRef.state, op);
    if (v.ok) {
      log(`SELFTEST FAIL: op should have been rejected (${why}): ${JSON.stringify(op)}`);
      process.exit(1);
    }
  }
  log('selftest OK: 9-op program accepted, 6 invalid ops rejected');
}

async function main() {
  const args = process.argv.slice(2);
  if (args.includes('--selftest')) {
    fs.mkdirSync(path.join(SCRATCH, 'ifc'), { recursive: true });
    await selftest();
    return;
  }
  const taskFilter = args.includes('--tasks')
    ? new Set(args[args.indexOf('--tasks') + 1].split(','))
    : null;
  const tasks = taskFilter ? TASKS.filter((t) => taskFilter.has(t.id)) : TASKS;

  fs.mkdirSync(path.join(SCRATCH, 'ifc'), { recursive: true });
  initModel(path.join(SCRATCH, 'raw'));

  const records = [];
  const resultsPath = path.join(__dirname, 'results.json');
  const persist = () => {
    const constrained = records.filter((r) => r.arm === 'constrained');
    const baseline = records.filter((r) => r.arm === 'baseline');
    const mean = (xs) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);
    const summary = {
      generatedAt: new Date().toISOString(),
      model: MODEL,
      tasksRun: [...new Set(records.map((r) => r.task))],
      modelCalls: totalCalls(),
      constrained: {
        emitted: constrained.filter((r) => r.emitted).length,
        compileOk: constrained.filter((r) => r.compileOk).length,
        compileRate: constrained.length ? constrained.filter((r) => r.compileOk).length / constrained.length : null,
        exhausted: constrained.filter((r) => r.exhausted).length,
        totalRepairs: constrained.reduce((a, r) => a + (r.repairs ?? 0), 0),
        meanQuality: Math.round(mean(constrained.map((r) => r.quality)) * 1000) / 1000,
      },
      baseline: {
        strictCompileOk: baseline.filter((r) => r.strictCompileOk).length,
        strictCompileRate: baseline.length ? baseline.filter((r) => r.strictCompileOk).length / baseline.length : null,
        lenientCompileOk: baseline.filter((r) => r.compileOk).length,
        meanQuality: Math.round(mean(baseline.map((r) => r.quality)) * 1000) / 1000,
      },
    };
    summary.margin = Math.round((summary.constrained.meanQuality - summary.baseline.meanQuality) * 1000) / 1000;
    fs.writeFileSync(resultsPath, JSON.stringify({ summary, records }, null, 2));
    return summary;
  };

  for (const task of tasks) {
    log(`${task.id} (${task.difficulty}) constrained arm ...`);
    const callsBefore = totalCalls();
    const con = await runConstrained(task);
    const conRecord = await finishArm(task, 'constrained', con.accepted, {
      calls: totalCalls() - callsBefore,
      repairs: con.repairs,
      exhausted: con.exhausted,
      rejectionErrors: con.errors,
    });
    records.push(conRecord);
    log(`  ${task.id} constrained: ops=${conRecord.opsCount} compileOk=${conRecord.compileOk} quality=${conRecord.quality} repairs=${con.repairs}${con.exhausted ? ' EXHAUSTED' : ''}`);

    log(`${task.id} baseline arm ...`);
    const bCallsBefore = totalCalls();
    const res = await callModel(genPrompt(task), `${task.id}-base`);
    let baseRecord;
    if (!res.ok) {
      baseRecord = {
        task: task.id, difficulty: task.difficulty, arm: 'baseline',
        calls: totalCalls() - bCallsBefore, strictCompileOk: false, modelError: res.error,
        emitted: false, compileOk: false, quality: 0, opsCount: 0, criteria: [],
      };
    } else {
      const ext = extractJsonArray(res.text);
      if (!ext.ok) {
        baseRecord = {
          task: task.id, difficulty: task.difficulty, arm: 'baseline',
          calls: totalCalls() - bCallsBefore, strictCompileOk: false, extractError: ext.error,
          emitted: false, compileOk: false, quality: 0, opsCount: 0, criteria: [],
        };
      } else {
        const { kept, skipped } = lenientSalvage(ext.ops);
        baseRecord = await finishArm(task, 'baseline', kept, {
          calls: totalCalls() - bCallsBefore,
          proposedOps: ext.ops.length,
          skippedOps: skipped,
          strictCompileOk: skipped === 0 && ext.ops.length > 0,
        });
        baseRecord.strictCompileOk = baseRecord.strictCompileOk && baseRecord.compileOk;
      }
    }
    records.push(baseRecord);
    log(`  ${task.id} baseline: proposed=${baseRecord.proposedOps ?? 0} skipped=${baseRecord.skippedOps ?? '-'} strict=${baseRecord.strictCompileOk} quality=${baseRecord.quality}`);

    const s = persist();
    log(`progress: calls=${s.modelCalls} conQ=${s.constrained.meanQuality} baseQ=${s.baseline.meanQuality}`);
  }

  const summary = persist();
  log('DONE ' + JSON.stringify(summary));
}

// Only run the exam when this file is the CLI entry point; run-tier2.mjs
// imports the helpers above without triggering a tier-1 run.
const isCliEntry = process.argv[1]
  && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isCliEntry) {
  main().then(() => process.exit(0)).catch((e) => {
    log(`FATAL: ${e.stack}`);
    process.exit(1);
  });
}
