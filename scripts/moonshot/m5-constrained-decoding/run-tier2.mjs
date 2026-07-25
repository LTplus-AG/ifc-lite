/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * M5 tier-2 exam runner (B2.3 follow-up, restructured after the hostile G2
 * review of tier-1). Three arms on identical briefs; ALL arms see exactly
 * the same prompt spec (DSL_SPEC_TIER2), which withholds the validator's
 * semantic rules (HELD_OUT_RULES in tasks-tier2.mjs):
 *
 * a) constrained - per-op grammar + kernel gate with bounded repair
 *    re-prompts carrying the exact rejection message (cap 2 repairs, so at
 *    most 3 calls per task). Only this arm ever receives rule information
 *    beyond the prompt - through kernel feedback.
 * b) filtered   - best-of-k one-shots with the validator used as a
 *    POST-HOC filter/selector only (lenient salvage; selection by strict
 *    validity, schema-valid compile, fewest skipped ops - never the task
 *    rubric). No error-message feedback ever reaches the model.
 * c) unfiltered - the SAME k samples with no validator at all: ops are
 *    kept if the compiler physically accepts them, selection by parse
 *    success and fewest compiler-dropped ops.
 *
 * Arms b and c share the same k samples (the treatment is post-hoc, so a
 * paired evaluation on common samples is strictly better statistically and
 * halves the call cost). k = 3 = the constrained arm's call CAP, so the
 * baselines never get less budget than arm (a) actually used.
 *
 * (a)-(b) isolates the value of error-message feedback over
 * validator-as-filter; (b)-(c) isolates the value of the validator itself.
 * The paired (a)-(b) mean-quality difference is reported with a bootstrap
 * 95 percent CI. Rubric-oracle best-of-k (peeks at task criteria) is
 * reported as a clearly-labelled diagnostic upper bound only.
 *
 * Scoring: rubric quality (tasks.mjs scoreTask over kernel measurements)
 * times an intent-fidelity factor (fraction of emitted ops honoring
 * explicitly stated brief values - anti constraint-laundering). Infeasible
 * briefs score 1 for a declared infeasibility, 0 otherwise, and are
 * excluded from the main quality aggregates.
 *
 * Usage:
 *   node run-tier2.mjs --selftest   # golden programs, zero model calls
 *   node run-tier2.mjs --headroom   # truncated-spec probe (8 calls),
 *                                   # proves the rubric has headroom
 *   node run-tier2.mjs              # full exam, three arms, 23 tasks
 *   node run-tier2.mjs --tasks T2-01,T2-F1
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { newState, describeState } from './dsl.mjs';
import { compileProgram } from './compile.mjs';
import { measureModel } from './kernel.mjs';
import { scoreTask } from './tasks.mjs';
import {
  TASKS_TIER2, FEASIBLE_TIER2, GOLDEN_TIER2, DSL_SPEC_TIER2, TRUNCATED_SPEC,
  HELD_OUT_RULES, intentFactor,
} from './tasks-tier2.mjs';
import { acceptOps, lenientSalvage, finishArm } from './run-exam.mjs';
import { initModel, callModel, extractJsonArray, totalCalls, MODEL } from './model.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SCRATCH = process.env.M5_SCRATCH
  ?? '/private/tmp/claude-501/-Users-louistrue-Development-ifc-lite/2ec75938-454c-46d9-8819-e37d26fe15fe/scratchpad/m5-tier2';
const MAX_REPAIRS_T2 = 2; // arm (a) uses at most 3 calls per task
const K_SAMPLES = 3; // arms (b)/(c) budget = arm (a)'s cap
const HEADROOM_TASKS = ['T2-01', 'T2-02', 'T2-04', 'T2-05', 'T2-06', 'T2-07', 'T2-09', 'T2-10'];

const log = (...a) => process.stderr.write(`[m5t2] ${a.join(' ')}\n`);
const r3 = (x) => Math.round(x * 1000) / 1000;
const mean = (xs) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);

function genPrompt2(task, spec = DSL_SPEC_TIER2) {
  return [
    'You translate natural-language building briefs into IFC-OPS programs.',
    '',
    spec,
    '',
    `BRIEF: ${task.brief}`,
    '',
    'Output ONLY the complete op program as a raw JSON array of op objects (or the infeasibility object if the brief cannot be satisfied as stated). No prose, no markdown fences.',
  ].join('\n');
}

function repairPrompt2(task, accepted, state, failure) {
  const parts = [
    'You are completing an IFC-OPS program that is being validated op by op.',
    '',
    DSL_SPEC_TIER2,
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
    'If, given the rule you just learned, the brief cannot be satisfied without changing an explicitly stated value, output ONLY {"infeasible": true, "reason": "..."}.',
    accepted.length > 0
      ? 'Otherwise output ONLY a raw JSON array with the corrected REMAINING ops that complete the brief (do not repeat accepted ops). No prose, no fences.'
      : 'Otherwise output ONLY the complete corrected op program as a raw JSON array. No prose, no fences.',
  );
  return parts.join('\n');
}

function detectInfeasible(text) {
  if (!/"infeasible"\s*:\s*true/.test(text)) return null;
  const reason = text.match(/"reason"\s*:\s*"((?:[^"\\]|\\.)*)"/);
  return { reason: reason ? reason[1] : '' };
}

/**
 * Tier-2 scoring wrapper over a finishArm record: intent-fidelity factor
 * for feasible tasks, declaration scoring for infeasible ones.
 */
function applyTier2(task, rec, ops, declared) {
  rec.declaredInfeasible = !!declared;
  if (declared) rec.infeasibleReason = (declared.reason ?? '').slice(0, 300);
  rec.qualityRubric = rec.quality;
  if (task.infeasible) {
    rec.intentFactor = intentFactor(task, ops ?? []);
    rec.laundered = !declared && (ops?.length ?? 0) > 0 && rec.intentFactor < 1;
    rec.infeasibleOutcome = declared
      ? 'declared'
      : ((ops?.length ?? 0) > 0 ? (rec.laundered ? 'laundered' : 'emitted-partial') : 'nothing');
    rec.quality = declared ? 1 : 0;
  } else if (declared) {
    rec.infeasibleOutcome = 'false-declaration';
    rec.intentFactor = 1;
    rec.quality = 0;
  } else {
    rec.intentFactor = intentFactor(task, ops ?? []);
    rec.quality = r3(rec.quality * rec.intentFactor);
  }
  return rec;
}

/** Arm (a): the B2.3 constrained loop with tier-2 prompts + infeasibility. */
async function runConstrained2(task) {
  const accepted = [];
  const stateRef = { state: newState() };
  let repairs = 0;
  let exhausted = false;
  let declared = null;
  const errors = [];

  let res = await callModel(genPrompt2(task), `${task.id}-con-r0`);
  for (;;) {
    let failure = null;
    if (!res.ok) {
      failure = { error: `model call failed: ${res.error}` };
    } else {
      const inf = detectInfeasible(res.text);
      if (inf) { declared = inf; break; }
      const ext = extractJsonArray(res.text);
      failure = ext.ok ? await acceptOps(accepted, stateRef, ext.ops) : { error: ext.error };
    }
    if (!failure) break;
    errors.push(failure.error);
    if (repairs >= MAX_REPAIRS_T2) { exhausted = true; break; }
    repairs += 1;
    log(`  ${task.id} constrained repair ${repairs}: ${failure.error.slice(0, 140)}`);
    res = await callModel(repairPrompt2(task, accepted, stateRef.state, failure), `${task.id}-con-r${repairs}`);
  }
  return { accepted, repairs, exhausted, errors, declared };
}

/** Keep every op the compiler physically accepts; no validator involved. */
function compilerSalvage(ops) {
  const kept = [];
  let dropped = 0;
  for (const op of ops) {
    if (!op || typeof op !== 'object' || Array.isArray(op)) { dropped += 1; continue; }
    try {
      compileProgram([...kept, op]);
      kept.push(op);
    } catch {
      dropped += 1;
    }
  }
  return { kept, dropped };
}

function failedSampleRec(task, armName, error, declared) {
  const rec = {
    task: task.id, difficulty: task.difficulty, arm: armName,
    strictCompileOk: false, emitted: false, compileOk: false,
    quality: 0, opsCount: 0, criteria: [], ...(declared ? {} : { sampleError: error }),
  };
  return applyTier2(task, rec, null, declared);
}

/** Validator-as-filter treatment of one raw sample (arm b). */
async function evalFiltered(task, res, armName) {
  if (!res.ok) return failedSampleRec(task, armName, `model call failed: ${res.error}`, null);
  const declared = detectInfeasible(res.text);
  if (declared) return failedSampleRec(task, armName, null, declared);
  const ext = extractJsonArray(res.text);
  if (!ext.ok) return failedSampleRec(task, armName, ext.error, null);
  const { kept, skipped } = lenientSalvage(ext.ops);
  const rec = await finishArm(task, armName, kept, {
    proposedOps: ext.ops.length,
    skippedOps: skipped,
    strictCompileOk: skipped === 0 && ext.ops.length > 0,
  });
  rec.strictCompileOk = rec.strictCompileOk && rec.compileOk;
  return applyTier2(task, rec, kept, null);
}

/** No-validator treatment of the same raw sample (arm c). */
async function evalUnfiltered(task, res, armName) {
  if (!res.ok) return failedSampleRec(task, armName, `model call failed: ${res.error}`, null);
  const declared = detectInfeasible(res.text);
  if (declared) return failedSampleRec(task, armName, null, declared);
  const ext = extractJsonArray(res.text);
  if (!ext.ok) return failedSampleRec(task, armName, ext.error, null);
  const { kept, dropped } = compilerSalvage(ext.ops);
  const rec = await finishArm(task, armName, kept, {
    proposedOps: ext.ops.length,
    droppedHard: dropped,
  });
  return applyTier2(task, rec, kept, null);
}

// Selection keys use only signals available WITHOUT the task rubric.
function keyFiltered(r) {
  return [r.strictCompileOk ? 1 : 0, r.compileOk ? 1 : 0, -(r.skippedOps ?? 999), r.opsCount ?? 0];
}

function keyUnfiltered(r) {
  return [r.emitted ? 1 : 0, -(r.droppedHard ?? 999), r.opsCount ?? 0];
}

function argBest(recs, key) {
  let best = 0;
  for (let i = 1; i < recs.length; i++) {
    const a = key(recs[i]);
    const b = key(recs[best]);
    for (let k = 0; k < a.length; k++) {
      if (a[k] !== b[k]) { if (a[k] > b[k]) best = i; break; }
    }
  }
  return best;
}

function argMaxQuality(recs) {
  let best = 0;
  for (let i = 1; i < recs.length; i++) if (recs[i].quality > recs[best].quality) best = i;
  return best;
}

function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function bootstrapCI(diffs, iters = 10000, seed = 42) {
  if (diffs.length === 0) return null;
  const rand = mulberry32(seed);
  const means = new Array(iters);
  for (let i = 0; i < iters; i++) {
    let s = 0;
    for (let j = 0; j < diffs.length; j++) s += diffs[(rand() * diffs.length) | 0];
    means[i] = s / diffs.length;
  }
  means.sort((a, b) => a - b);
  return {
    mean: r3(mean(diffs)),
    lo95: r3(means[Math.floor(0.025 * iters)]),
    hi95: r3(means[Math.ceil(0.975 * iters) - 1]),
    n: diffs.length,
  };
}

async function selftest() {
  let failed = 0;
  for (const task of FEASIBLE_TIER2) {
    const golden = GOLDEN_TIER2[task.id];
    if (!golden) { log(`SELFTEST FAIL ${task.id}: no golden program`); failed += 1; continue; }
    const accepted = [];
    const stateRef = { state: newState() };
    const failure = await acceptOps(accepted, stateRef, golden);
    if (failure) {
      log(`SELFTEST FAIL ${task.id}: golden op rejected: ${failure.error}`);
      log(`  op: ${JSON.stringify(failure.op)}`);
      failed += 1;
      continue;
    }
    const { content } = compileProgram(accepted);
    fs.writeFileSync(path.join(SCRATCH, 'ifc', `${task.id}-golden.ifc`), content);
    const m = await measureModel(content);
    const score = scoreTask(task, m);
    const intent = intentFactor(task, golden);
    const quality = r3(score.quality * intent);
    if (quality < 1) {
      log(`SELFTEST FAIL ${task.id}: golden quality ${quality} < 1 (rubric ${score.quality}, intent ${intent})`);
      for (const c of score.criteria) {
        if (c.score < 1) log(`  criterion "${c.name}": measured ${JSON.stringify(c.measured)} score ${c.score}`);
      }
      if (score.schemaFactor !== 1) log(`  schemaFactor ${score.schemaFactor}`);
      if (score.clashFactor !== 1) log(`  clashFactor ${score.clashFactor} (clashes ${m.clash.total})`);
      failed += 1;
    } else {
      log(`selftest ${task.id} OK: ${golden.length} ops, quality 1.0`);
    }
  }
  if (failed > 0) {
    log(`SELFTEST: ${failed} task(s) failed`);
    process.exit(1);
  }
  log('selftest OK: all 20 feasible golden programs score quality 1.0, zero model calls');
}

function loadResults(resultsPath) {
  try {
    return JSON.parse(fs.readFileSync(resultsPath, 'utf8'));
  } catch {
    return {};
  }
}

/**
 * Rubric-headroom probe (review finding 1): a deliberately mediocre
 * proposer (TRUNCATED_SPEC: op names + fields only, no conventions, no
 * example), unfiltered treatment. The rubric has headroom iff this lands
 * mid-scale rather than saturating at 1.0.
 */
async function headroomProbe(offline) {
  const rawDir = path.join(SCRATCH, 'raw-headroom');
  initModel(rawDir);
  const rows = [];
  for (const id of HEADROOM_TASKS) {
    const task = TASKS_TIER2.find((t) => t.id === id);
    let res;
    if (offline) {
      // Re-score saved transcripts after a rubric change: zero model calls.
      const file = fs.readdirSync(rawDir).find((f) => f.endsWith(`-${task.id}-headroom-response.txt`));
      res = file
        ? { ok: true, text: fs.readFileSync(path.join(rawDir, file), 'utf8') }
        : { ok: false, error: 'no saved transcript' };
    } else {
      res = await callModel(
        [
          'You translate natural-language building briefs into IFC-OPS programs.',
          '', TRUNCATED_SPEC, '', `BRIEF: ${task.brief}`, '',
          'Output ONLY the op program as a raw JSON array of op objects. No prose, no markdown fences.',
        ].join('\n'),
        `${task.id}-headroom`,
      );
    }
    const rec = await evalUnfiltered(task, res, `headroom-${task.id}`);
    rows.push({
      task: task.id, quality: rec.quality, qualityRubric: rec.qualityRubric,
      intentFactor: rec.intentFactor, opsCount: rec.opsCount,
      droppedHard: rec.droppedHard ?? null, compileOk: rec.compileOk,
      criteria: rec.criteria?.map((c) => ({ name: c.name, measured: c.measured, score: c.score })),
    });
    log(`headroom ${task.id}: quality=${rec.quality} (rubric ${rec.qualityRubric}, intent ${rec.intentFactor})`);
  }
  const summary = {
    generatedAt: new Date().toISOString(),
    model: MODEL,
    spec: 'TRUNCATED_SPEC (op names + fields only)',
    treatment: 'unfiltered compilerSalvage',
    offlineRescore: !!offline,
    calls: totalCalls(),
    meanQuality: r3(mean(rows.map((r) => r.quality))),
    perTask: rows,
  };
  summary.verdict = summary.meanQuality >= 0.95
    ? 'NO HEADROOM - rubric saturates even for a truncated-spec proposer; redesign criteria before trusting the arm comparison'
    : summary.meanQuality <= 0.1
      ? 'CLIFF - truncated proposer scores near zero; headroom exists but the rubric may be all-or-nothing'
      : 'HEADROOM OK - mediocre proposer lands mid-scale';
  const resultsPath = path.join(__dirname, 'results-tier2.json');
  const data = loadResults(resultsPath);
  data.headroom = summary;
  fs.writeFileSync(resultsPath, JSON.stringify(data, null, 2));
  log(`headroom DONE: mean=${summary.meanQuality} -> ${summary.verdict}`);
}

async function main() {
  const args = process.argv.slice(2);
  fs.mkdirSync(path.join(SCRATCH, 'ifc'), { recursive: true });
  if (args.includes('--selftest')) { await selftest(); return; }
  if (args.includes('--headroom')) { await headroomProbe(args.includes('--offline')); return; }

  const taskFilter = args.includes('--tasks')
    ? new Set(args[args.indexOf('--tasks') + 1].split(','))
    : null;
  const tasks = taskFilter ? TASKS_TIER2.filter((t) => taskFilter.has(t.id)) : TASKS_TIER2;

  initModel(path.join(SCRATCH, 'raw'));

  const resultsPath = path.join(__dirname, 'results-tier2.json');
  const prior = loadResults(resultsPath);
  // --resume continues an interrupted run: prior per-task records are kept,
  // completed tasks are skipped, and the call count accumulates across
  // processes (each process has its own MAX_CALLS budget guard).
  const resume = args.includes('--resume');
  const records = resume && Array.isArray(prior.records) ? [...prior.records] : [];
  const samplesByTask = resume && prior.samplesByTask ? { ...prior.samplesByTask } : {};
  const priorCalls = resume ? (prior.summary?.modelCalls ?? 0) : 0;

  const persist = () => {
    const feas = (arm) => records.filter((r) => r.arm === arm && !TASKS_TIER2.find((t) => t.id === r.task)?.infeasible);
    const infeas = (arm) => records.filter((r) => r.arm === arm && TASKS_TIER2.find((t) => t.id === r.task)?.infeasible);
    const armStats = (arm) => {
      const rs = feas(arm);
      return {
        tasks: rs.length,
        compileOk: rs.filter((r) => r.compileOk).length,
        strictCompileOk: rs.filter((r) => r.strictCompileOk).length,
        meanQuality: r3(mean(rs.map((r) => r.quality))),
        meanQualityRubric: r3(mean(rs.map((r) => r.qualityRubric ?? r.quality))),
        meanIntentFactor: r3(mean(rs.map((r) => r.intentFactor ?? 1))),
        falseDeclarations: rs.filter((r) => r.infeasibleOutcome === 'false-declaration').length,
      };
    };
    const infeasStats = (arm) => {
      const rs = infeas(arm);
      return {
        tasks: rs.length,
        declared: rs.filter((r) => r.infeasibleOutcome === 'declared').length,
        laundered: rs.filter((r) => r.infeasibleOutcome === 'laundered').length,
        emittedPartial: rs.filter((r) => r.infeasibleOutcome === 'emitted-partial').length,
        nothing: rs.filter((r) => r.infeasibleOutcome === 'nothing').length,
      };
    };
    const con = feas('constrained');
    const conAll = records.filter((r) => r.arm === 'constrained');
    const pairedDiff = (armB) => con
      .map((r) => {
        const other = records.find((o) => o.arm === armB && o.task === r.task);
        return other ? r.quality - other.quality : null;
      })
      .filter((d) => d !== null);

    const summary = {
      generatedAt: new Date().toISOString(),
      model: MODEL,
      tier: 2,
      design: {
        heldOutRules: HELD_OUT_RULES,
        repairCap: MAX_REPAIRS_T2,
        kSamples: K_SAMPLES,
        sharedSamples: 'arms filtered/unfiltered evaluate the same k raw samples (paired post-hoc treatments)',
        selection: 'kernel/validator-as-judge only; rubric-oracle reported separately as diagnostic',
      },
      tasksRun: [...new Set(records.map((r) => r.task))],
      modelCalls: priorCalls + totalCalls(),
      constrained: {
        ...armStats('constrained'),
        totalRepairs: conAll.reduce((a, r) => a + (r.repairs ?? 0), 0),
        tasksWithRepairs: conAll.filter((r) => (r.repairs ?? 0) > 0).length,
        feasibleTasksWithRepairs: con.filter((r) => (r.repairs ?? 0) > 0).length,
        feasibleRepairedAndRecovered: con.filter((r) => (r.repairs ?? 0) > 0 && r.compileOk && !r.exhausted).length,
        exhausted: conAll.filter((r) => r.exhausted).length,
        meanCalls: r3(mean(conAll.map((r) => r.calls ?? 0))),
      },
      filtered: {
        ...armStats('filtered'),
        oracleMeanQuality: r3(mean(Object.entries(samplesByTask)
          .filter(([id]) => !TASKS_TIER2.find((t) => t.id === id)?.infeasible)
          .map(([, v]) => v.oracleFilteredQuality ?? 0))),
      },
      unfiltered: {
        ...armStats('unfiltered'),
        oracleMeanQuality: r3(mean(Object.entries(samplesByTask)
          .filter(([id]) => !TASKS_TIER2.find((t) => t.id === id)?.infeasible)
          .map(([, v]) => v.oracleUnfilteredQuality ?? 0))),
      },
      infeasibleHandling: {
        constrained: infeasStats('constrained'),
        filtered: infeasStats('filtered'),
        unfiltered: infeasStats('unfiltered'),
        note: 'declared = correct; laundered = stated values mutated until the kernel accepted (scored 0); selection keys cannot prefer declarations, which is itself a finding',
      },
      margins: {
        constrainedVsFiltered: bootstrapCI(pairedDiff('filtered')),
        constrainedVsUnfiltered: bootstrapCI(pairedDiff('unfiltered')),
      },
    };
    const data = { summary, records, samplesByTask };
    if (prior.headroom) data.headroom = prior.headroom;
    fs.writeFileSync(resultsPath, JSON.stringify(data, null, 2));
    return summary;
  };

  for (const task of tasks) {
    if (records.some((r) => r.task === task.id && r.arm === 'constrained')) {
      log(`${task.id} already complete (resume), skipping`);
      continue;
    }
    // Arm (a): constrained decoding with kernel feedback.
    log(`${task.id} (${task.difficulty}) constrained arm ...`);
    const callsBefore = totalCalls();
    const con = await runConstrained2(task);
    const conCalls = totalCalls() - callsBefore;
    let conRecord;
    if (con.declared) {
      conRecord = applyTier2(task, {
        task: task.id, difficulty: task.difficulty, arm: 'constrained',
        calls: conCalls, repairs: con.repairs, exhausted: false,
        rejectionErrors: con.errors, emitted: false, compileOk: false,
        strictCompileOk: false, quality: 0, opsCount: 0, criteria: [],
      }, null, con.declared);
    } else {
      conRecord = await finishArm(task, 'constrained', con.accepted, {
        calls: conCalls,
        repairs: con.repairs,
        exhausted: con.exhausted,
        rejectionErrors: con.errors,
      });
      conRecord = applyTier2(task, conRecord, con.accepted, null);
    }
    records.push(conRecord);
    log(`  ${task.id} constrained: ops=${conRecord.opsCount} quality=${conRecord.quality} repairs=${con.repairs}${con.exhausted ? ' EXHAUSTED' : ''}${con.declared ? ' DECLARED-INFEASIBLE' : ''}`);

    // Arms (b)/(c): k shared one-shot samples, two post-hoc treatments.
    log(`${task.id} sampling k=${K_SAMPLES} one-shots for filtered/unfiltered arms ...`);
    const rawSamples = [];
    for (let i = 0; i < K_SAMPLES; i++) {
      rawSamples.push(await callModel(genPrompt2(task), `${task.id}-bof-s${i}`));
    }
    const filteredRecs = [];
    const unfilteredRecs = [];
    for (let i = 0; i < rawSamples.length; i++) {
      filteredRecs.push(await evalFiltered(task, rawSamples[i], `bof-s${i}-filt`));
      unfilteredRecs.push(await evalUnfiltered(task, rawSamples[i], `bof-s${i}-raw`));
    }
    const selF = argBest(filteredRecs, keyFiltered);
    const selU = argBest(unfilteredRecs, keyUnfiltered);
    const fRec = { ...filteredRecs[selF], arm: 'filtered', selectedSample: selF, k: K_SAMPLES };
    const uRec = { ...unfilteredRecs[selU], arm: 'unfiltered', selectedSample: selU, k: K_SAMPLES };
    records.push(fRec, uRec);
    samplesByTask[task.id] = {
      k: K_SAMPLES,
      selectedFiltered: selF,
      selectedUnfiltered: selU,
      oracleFilteredQuality: filteredRecs[argMaxQuality(filteredRecs)].quality,
      oracleUnfilteredQuality: unfilteredRecs[argMaxQuality(unfilteredRecs)].quality,
      filtered: filteredRecs.map((s) => ({
        strictCompileOk: s.strictCompileOk, compileOk: s.compileOk,
        skippedOps: s.skippedOps ?? null, opsCount: s.opsCount,
        quality: s.quality, intentFactor: s.intentFactor ?? null,
        declaredInfeasible: s.declaredInfeasible ?? false,
      })),
      unfiltered: unfilteredRecs.map((s) => ({
        compileOk: s.compileOk, droppedHard: s.droppedHard ?? null,
        opsCount: s.opsCount, quality: s.quality,
        intentFactor: s.intentFactor ?? null,
        declaredInfeasible: s.declaredInfeasible ?? false,
      })),
    };
    log(`  ${task.id} filtered: sel=${selF} quality=${fRec.quality} | unfiltered: sel=${selU} quality=${uRec.quality}`);

    const s = persist();
    log(`progress: calls=${s.modelCalls} conQ=${s.constrained.meanQuality} filtQ=${s.filtered.meanQuality} unfQ=${s.unfiltered.meanQuality}`);
  }

  const summary = persist();
  log('DONE ' + JSON.stringify(summary.margins));
}

main().then(() => process.exit(0)).catch((e) => {
  log(`FATAL: ${e.stack}`);
  process.exit(1);
});
