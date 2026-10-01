/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { parseCheckJobs, type CheckJob } from '@ifc-lite/flow-nodes';
import { parseRuleSetFile, type RuleSetFile } from '@ifc-lite/rules';
import { parseIDS, type IDSDocument } from '@ifc-lite/ids';
import { validateComparisonRecipe } from '@/lib/compare/comparison-recipe-io';
import type { ComparisonRecipe } from '@/lib/compare/comparison-recipe';
import { isSavedComparison, type SavedComparison } from '@/lib/compare/savedComparisonSchema';
import { computeFullSourceHash } from '@/utils/sourceContentHash';
import type { WorkflowRun } from './run-session';

const MAX_RESOURCE_BYTES = 10 * 1024 * 1024;
export type PreparedCheck = { job: CheckJob; name: string; fingerprint: string } & (
  | { kind: 'rules'; value: RuleSetFile }
  | { kind: 'ids'; value: IDSDocument }
  | { kind: 'comparison'; value: ComparisonRecipe });

export function filesResource(run: WorkflowRun, token: unknown): Readonly<Record<string, readonly File[]>> {
  if (token === undefined || (typeof token === 'object' && token !== null && Object.keys(token).length === 0)) return {};
  return run.get(token, 'files');
}
async function resourceText(run: WorkflowRun, file: File): Promise<string> {
  run.check();
  if (file.size > MAX_RESOURCE_BYTES) throw new Error(`Resource exceeds 10 MiB: ${file.name}`);
  let text = run.text.get(file);
  if (text === undefined) { text = await file.text(); run.check(); run.text.set(file, text); }
  return text;
}
function json(text: string, name: string): unknown {
  try { return JSON.parse(text); } catch (error) { throw new Error(`Invalid JSON in ${name}`, { cause: error }); }
}
export function jobsWithFiles(run: WorkflowRun, value: unknown, token: unknown): readonly CheckJob[] {
  const jobs = parseCheckJobs(value);
  if (jobs.length) return jobs;
  return Object.entries(filesResource(run, token)).flatMap(([slotId, files]) => files.map((file, index) => ({
    id: `${slotId}:${index}:${file.name}`, enabled: true,
    source: { kind: 'slot' as const, slotId, filename: file.name },
  })));
}
/** Object key order does not change the identity of an embedded configuration. */
function canonicalJson(value: unknown): string {
  const path = new WeakSet<object>();
  let remaining = 100_000;
  const ordered = (entry: unknown, depth: number): unknown => {
    if (--remaining < 0 || depth > 64) throw new Error('Embedded resource exceeds supported nesting or work budget');
    if (typeof entry !== 'object' || entry === null) return entry;
    if (path.has(entry)) throw new Error('Embedded resource contains a cycle');
    path.add(entry);
    try {
      if (Array.isArray(entry)) return entry.map((item) => ordered(item, depth + 1));
      return Object.fromEntries(Object.entries(entry).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([key, item]) => [key, ordered(item, depth + 1)]));
    } finally { path.delete(entry); }
  };
  const text = JSON.stringify(ordered(value, 0));
  if (text === undefined) throw new Error('Embedded resource is not JSON');
  return text;
}

export async function prepareCheck(run: WorkflowRun, job: CheckJob, kind: 'validation' | 'comparison'): Promise<PreparedCheck> {
  let value: unknown;
  let name: string;
  let sourceText: string;
  if (job.source.kind === 'embedded') {
    value = job.source.value; name = job.source.name ?? job.id;
    sourceText = canonicalJson(value);
    if (new TextEncoder().encode(sourceText).byteLength > MAX_RESOURCE_BYTES) throw new Error(`Embedded resource too large: ${name}`);
  } else {
    const selected = run.files.get(job.source.slotId) ?? [];
    const matches = selected.filter((f) => job.source.kind === 'slot' && (!job.source.filename || f.name === job.source.filename));
    if (matches.length !== 1) throw new Error(`Choose exactly one resource for ${job.id}`);
    name = matches[0].name;
    sourceText = await resourceText(run, matches[0]);
    value = name.toLowerCase().endsWith('.ids') ? sourceText : json(sourceText, name);
  }
  const fingerprint = await computeFullSourceHash(new TextEncoder().encode(sourceText));
  run.check();
  if (!fingerprint) throw new Error('Web Crypto SHA-256 is required to identify workflow check resources');
  if (kind === 'comparison') return { job, name, fingerprint, kind: 'comparison', value: validateComparisonRecipe(value) };
  if (typeof value === 'string') return { job, name, fingerprint, kind: 'ids', value: parseIDS(value) };
  const parsed = parseRuleSetFile(value);
  if (!parsed.ok) throw new Error(`${name}: ${parsed.error}`);
  return { job, name, fingerprint, kind: 'rules', value: parsed.file };
}
export function historicalJobId(slotId: string, index: number, filename: string): string {
  return `historical:${JSON.stringify([slotId, index, filename])}`;
}

export async function readHistorical(run: WorkflowRun, file: File): Promise<SavedComparison> {
  const value = json(await resourceText(run, file), file.name);
  if (!isSavedComparison(value)) throw new Error(`${file.name}: expected Saved comparisons JSON (version 1). Export from Saved comparisons; live Compare report JSON is not a saved report.`);
  return structuredClone(value);
}
