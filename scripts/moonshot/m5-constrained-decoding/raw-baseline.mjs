/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Second baseline arm (sanctioned by the B2.3 brief: "asked to emit the
 * full op program OR RAW IFC DIRECTLY"): the same model, the same briefs,
 * but no DSL and no compiler - it must emit an IFC4 STEP file verbatim.
 * Lenient compilation = extract the ISO-10303-21 block, parse it with the
 * same kernel loader, and score it on the identical rubric. This isolates
 * the value of "programs over the kernel" (the M5 thesis) as opposed to
 * direct geometry emission.
 *
 * Appends `baseline-raw` records to results.json and recomputes the
 * summary. Run after run-exam.mjs.
 */

import fs from 'node:fs';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { measureModel } from './kernel.mjs';
import { TASKS, scoreTask } from './tasks.mjs';
import { initModel, callModel, totalCalls } from './model.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SCRATCH = process.env.M5_SCRATCH
  ?? path.join(tmpdir(), 'ifc-lite-m5');
const resultsPath = path.join(__dirname, 'results.json');

const log = (...a) => process.stderr.write(`[m5-raw] ${a.join(' ')}\n`);

function rawPrompt(task) {
  return [
    'You translate natural-language building briefs into IFC building models.',
    '',
    `BRIEF: ${task.brief}`,
    '',
    'Output ONLY a complete, valid IFC4 STEP file (ISO-10303-21) implementing the brief:',
    'project, site, building, storeys, and all elements with real geometry',
    '(extruded solids), spatial containment, and property sets where asked.',
    'Units metres. Start with ISO-10303-21; and end with END-ISO-10303-21;.',
    'No prose, no markdown fences.',
  ].join('\n');
}

function extractStep(text) {
  let t = text.trim();
  const fence = t.match(/```(?:step|ifc)?\s*([\s\S]*?)```/);
  if (fence) t = fence[1].trim();
  const lo = t.indexOf('ISO-10303-21;');
  const hi = t.lastIndexOf('END-ISO-10303-21;');
  if (lo === -1 || hi === -1 || hi <= lo) {
    return { ok: false, error: 'no ISO-10303-21 ... END-ISO-10303-21 block found' };
  }
  return { ok: true, content: t.slice(lo, hi + 'END-ISO-10303-21;'.length) };
}

async function main() {
  const data = JSON.parse(fs.readFileSync(resultsPath, 'utf8'));
  // Fail BEFORE spending model calls: the margin computation at the end
  // needs the constrained-arm summary from a completed exam run.
  if (!data.summary?.constrained) {
    throw new Error(`${resultsPath} has no summary.constrained; run the exam first (the raw baseline is a comparison arm)`);
  }
  data.records = data.records.filter((r) => r.arm !== 'baseline-raw');
  // Standalone runs must not depend on run-exam.mjs having created the tree.
  fs.mkdirSync(path.join(SCRATCH, 'ifc'), { recursive: true });
  initModel(path.join(SCRATCH, 'raw'));

  for (const task of TASKS) {
    log(`${task.id} raw-IFC baseline ...`);
    const res = await callModel(rawPrompt(task), `${task.id}-raw`);
    let record = { task: task.id, difficulty: task.difficulty, arm: 'baseline-raw', calls: 1 };
    if (!res.ok) {
      record = { ...record, emitted: false, compileOk: false, modelError: res.error, quality: 0, criteria: [] };
    } else {
      const ext = extractStep(res.text);
      if (!ext.ok) {
        record = { ...record, emitted: false, compileOk: false, extractError: ext.error, quality: 0, criteria: [] };
      } else {
        const ifcPath = path.join(SCRATCH, 'ifc', `${task.id}-baseline-raw.ifc`);
        const ifcPathRel = path.join('ifc', `${task.id}-baseline-raw.ifc`);
        fs.writeFileSync(ifcPath, ext.content);
        try {
          const m = await measureModel(ext.content);
          const score = scoreTask(task, m);
          record = {
            ...record,
            emitted: true,
            compileOk: m.schema.errors === 0 && m.meshedElements > 0,
            bytes: ext.content.length,
            quality: score.quality,
            schemaFactor: score.schemaFactor,
            clashFactor: score.clashFactor,
            criteria: score.criteria,
            schema: m.schema,
            clash: m.clash,
            counts: m.counts,
            meshedElements: m.meshedElements,
            ifcPath: ifcPathRel,
          };
        } catch (e) {
          record = { ...record, emitted: true, compileOk: false, compileError: `kernel parse/measure failed: ${e.message}`, quality: 0, criteria: [], ifcPath: ifcPathRel };
        }
      }
    }
    data.records.push(record);
    log(`  ${task.id} raw: emitted=${record.emitted} compileOk=${record.compileOk} quality=${record.quality} ${record.compileError ?? record.extractError ?? ''}`);
  }

  const raws = data.records.filter((r) => r.arm === 'baseline-raw');
  const mean = (xs) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);
  data.summary.baselineRaw = {
    emitted: raws.filter((r) => r.emitted).length,
    compileOk: raws.filter((r) => r.compileOk).length,
    compileRate: raws.length ? raws.filter((r) => r.compileOk).length / raws.length : null,
    meanQuality: Math.round(mean(raws.map((r) => r.quality)) * 1000) / 1000,
  };
  data.summary.marginVsRaw = Math.round((data.summary.constrained.meanQuality - data.summary.baselineRaw.meanQuality) * 1000) / 1000;
  data.summary.rawArmModelCalls = totalCalls();
  fs.writeFileSync(resultsPath, JSON.stringify(data, null, 2));
  log('DONE ' + JSON.stringify(data.summary));
}

main().then(() => process.exit(0)).catch((e) => {
  log(`FATAL: ${e.stack}`);
  process.exit(1);
});
