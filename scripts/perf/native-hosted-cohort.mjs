/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import { readFileSync, writeFileSync, appendFileSync } from 'node:fs';
import { join } from 'node:path';
import { setTimeout as pause } from 'node:timers/promises';
import { root, output, verify } from './native-hosted-prepare.mjs';
import { prebuiltCommand, prebuiltWitness } from './native-prebuilt.mjs';
import { execute } from './native-hosted-process.mjs';
import { schedule, limits, probeResult, requirePair, phases, median, requireCompletion } from './native-hosted-plan.mjs';
import { available, quiet } from './sdk-resources.mjs';
import { probeSummary, requireSummaryDiagnostics } from './native-probe-summary.mjs';
const provenance = JSON.parse(readFileSync(join(output, 'provenance.json'), 'utf8'));
const report = { status: 'pending', scope: 'native phase attribution; not browser worker-pool or full-output identity', pairs: [] };
let refusal; const started = Date.now(), controls = new Map(), diagnosticControls = new Map();
const handlers = new Map(['SIGINT', 'SIGTERM'].map(signal => [signal, () => { refusal ??= `received ${signal}`; }]));
for (const [signal, handler] of handlers) process.on(signal, handler);
try {
  if (provenance.status !== 'qualified-native-builds-not-timing' || provenance.runtimeProtocol !== 'native-fd-prebuilt-v1'
    || available() < limits.initialBytes) throw new Error('native qualification/initial reserve refused');
  for (const [index, item] of schedule().entries()) {
    const pair = { ...item, index, status: 'pending', runs: [] }; report.pairs.push(pair);
    try {
      if (refusal || Date.now() - started > 45 * 60000) throw new Error(refusal ?? 'native cohort45-minute wall bound');
      await verify(provenance); await pause(limits.drainMs); pair.before = await quiet();
      const fixture = provenance.fixtures.find(row => row.family === item.family);
      for (const [slot, arm] of item.order.entries()) {
        if (refusal) throw new Error(refusal);
        const prefix = join(output, `${index}-${slot}-${arm}`), witness = `${prefix}.fd-intent.json`;
        const row = await execute(prebuiltCommand(root, provenance, arm, fixture.file, witness),
          provenance.directories[arm], prefix, { sample: true, prebuilt: true,
            tools: { ...provenance.tools, nativeBinary: provenance.builds[arm].binary } });
        pair.runs.push({ arm, ...row });
        if (row.status !== 'complete') throw new Error(row.reason);
        row.result = probeResult(readFileSync(row.paths.stdout, 'utf8'), fixture.file);
        Object.assign(pair.runs.at(-1), { result: row.result });
        row.summary = probeSummary(readFileSync(row.paths.stderr, 'utf8'), row.result, fixture);
        Object.assign(pair.runs.at(-1), { summary: row.summary });
        row.fdIntent = await prebuiltWitness(root, provenance, arm, fixture.file, witness, row);
        provenance.files[witness] = row.fdIntent.sha256;
        row.fdIntent.path = witness;
        Object.assign(pair.runs.at(-1), { result: row.result, fdIntent: row.fdIntent });
        await verify(provenance);
      }
      await pause(limits.drainMs); pair.after = await quiet();
      const [left, right] = pair.runs.map(row => row.result);
      pair.comparison = requirePair(left, right, item.kind, controls.get(item.family));
      requireSummaryDiagnostics(pair.runs[0].summary, pair.runs[1].summary, diagnosticControls.get(item.family));
      if (item.kind === 'AB') {
        const base = pair.runs.find(row => row.arm === 'base').result, candidate = pair.runs.find(row => row.arm === 'candidate').result;
        pair.deltasPercent = Object.fromEntries([...phases.map(key => [key, base[key] > 0 ? 100 * (candidate[key] / base[key] - 1) : null]),
          ...['allTotalsMs', 'allWallMs'].map(key => [key, 100 * (median(candidate[key]) / median(base[key]) - 1)])]);
      }
      if (!controls.has(item.family)) controls.set(item.family, left);
      if (!diagnosticControls.has(item.family)) diagnosticControls.set(item.family, pair.runs[0].summary);
      await verify(provenance); if (refusal) throw new Error(refusal); pair.status = 'complete';
    } catch (error) {
      pair.status = 'refused'; pair.reason = String(error);
      if (error.receipt) pair.cpuRefusal = error.receipt;
      if (error.summaryReceipt) pair.runs.at(-1).summary = error.summaryReceipt;
      throw error;
    }
    finally {
      writeFileSync(join(output, `pair-${index}.json`), JSON.stringify(pair, null, 2));
      appendFileSync(join(output, 'pairs.jsonl'), JSON.stringify(pair) + '\n');
    }
  }
} catch (error) { refusal ??= String(error); }
finally {
  try { await verify(provenance); report.finalFrozenVerification = 'complete'; } catch (error) { refusal ??= String(error); }
  try { requireCompletion(refusal, report.pairs, report.finalFrozenVerification); report.status = 'complete-native-attribution'; }
  catch (error) { report.status = 'refused'; refusal ??= String(error); }
  report.reason = refusal; report.endedUTC = new Date().toISOString();
  writeFileSync(join(output, 'report.json'), JSON.stringify(report, null, 2));
  writeFileSync(join(output, 'report.md'), `Native attribution: ${report.status}. ${report.reason ?? ''}\n\nExplicit compile-once/held-FD protocol: original arm probes qualified separately. Canonical phases remain the best-total iteration with five raw totals/walls and ordered mesh FNVs. No Cargo in timed processes; FD intent alone is not execution proof. No browser or full-output identity claim.\n`);
  for (const [signal, handler] of handlers) process.off(signal, handler);
  if (report.status !== 'complete-native-attribution') process.exitCode = 1;
}
