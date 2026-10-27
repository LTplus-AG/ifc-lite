// SPDX-License-Identifier: MPL-2.0
import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import type { IfcDataStore } from '@ifc-lite/parser';
import { getFlag, writeOutput } from '../output.js';
import { validateEngine, type RetainedEngine } from '../retained/engine.js';
import { runRetained } from '../retained/run.js';
import { retainedObj } from '../retained/obj.js';
import { retainedReport, reportJson } from '../retained/report.js';
import type { RetainedProductOutcome } from '../../../wasm/pkg-retained/ifc-lite.js';

export async function exportKernel(args: string[], format: string): Promise<RetainedEngine | undefined> {
  const option = (name: string) => {
    if (!args.includes(name)) return undefined;
    const value = getFlag(args, name);
    if (!value || value.startsWith('--')) throw new Error(`${name} requires a value`);
    return value;
  };
  const kernel = option('--kernel') ?? 'exact';
  const directory = option('--retained-engine'), report = option('--retained-report');
  if (kernel !== 'exact' && kernel !== 'retained') throw new Error('--kernel must be exact or retained');
  if (kernel === 'exact') {
    if (directory || report) throw new Error('--retained-engine and --retained-report require --kernel retained');
    return undefined;
  }
  if (format !== 'obj') throw new Error('--kernel retained requires --format obj');
  const out = getFlag(args, '--out');
  if (out && report && resolve(out) === resolve(report)) throw new Error('OBJ and retained report must have different paths');
  return validateEngine(directory ?? process.env.IFCLITE_RETAINED_ENGINE);
}

/** Prepare both artifacts before any write: zero publication and invalid products
 * are fatal and never leave a misleading OBJ or successful-looking report. */
export function retainedArtifacts(engine: RetainedEngine, outcomes: RetainedProductOutcome[], globalId: (id: number) => string | null, ids?: Uint32Array) {
  const published = outcomes.filter(p => p.status === 'published');
  if (!published.length) throw new Error('Retained export published 0 products; nothing written');
  const obj = retainedObj(published);
  const report = retainedReport(engine, outcomes, globalId, ids);
  return { obj, report, json: reportJson(report) };
}

export async function exportRetained(args: string[], engine: RetainedEngine, store: IfcDataStore, filePath: string,
  refs: Array<{ expressId: number }>, filtered: boolean): Promise<void> {
  const ids = filtered ? Uint32Array.from(refs, r => r.expressId) : undefined;
  const bytes = store.source.byteLength ? store.source.materialize() : await readFile(filePath);
  const outcomes = await runRetained(engine, bytes, ids);
  const { obj, report, json } = retainedArtifacts(engine, outcomes, id => store.entities.getGlobalId(id) || null, ids);
  const reportPath = getFlag(args, '--retained-report');
  if (reportPath) await writeFile(reportPath, json);
  await writeOutput(obj, getFlag(args, '--out'));
  process.stderr.write(`Retained shape-only: ${report.summary.published}/${report.summary.candidates} products published; refusals ${JSON.stringify(report.summary.byCode)}; PresentationObligationsUnmet\n`);
}
