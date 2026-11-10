/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/** #8947 source-accounting tool, not a behavior or completeness gate.
 * Usage: node tests/ui-scenes/command-palette-access/update-inventory.mjs REPORT_DIRECTORY
 * Preserve the immutable report inputs in coordinator evidence; new reviews replace
 * specific records. Never promote source tracing to executed behavior here.
 */
import { readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = process.argv[2];
if (!root) throw new Error('Provide the directory containing the original review JSON reports.');
const output = fileURLToPath(new URL('./inventory/', import.meta.url));
const reportRefs = [];
async function report(name) {
  const filename = `palette-${name}-fd0b1714.json`;
  const bytes = await readFile(join(root, filename));
  const value = JSON.parse(bytes);
  reportRefs.push({ filename, sha256: createHash('sha256').update(bytes).digest('hex'),
    source: value.sourceCommit ?? value.sourceRevision ?? value.reviewCommit ?? value.pinnedSourceCommit ?? value.researchHead ?? null });
  return value;
}
const original = await report('feature-access-reconciled');
const inventory = new Map([...original.census, ...original.noLexicalCallback].map(row => [row.id, {
  id: row.id, originalSource: row.source, originalSites: row.sites ?? [],
  review: null, reviewKind: 'unresolved', behavior: 'UNRUN',
}]));
// Ordered from preliminary family tracing to focused manual review. Later rows
// replace earlier routes for the same immutable identity, never the census anchors.
const sources = [
  ['access-semantic-part1-resolved', 'partial-family-trace'],
  ['access-semantic-part2-resolved', 'partial-family-trace'],
  ['access-workflow-paths', 'workflow-source-trace'],
  ['access-properties-routes', 'focused-source-trace'],
  ['access-model-tools-routes', 'focused-source-trace'],
  ['access-file-extension-routes', 'focused-source-trace'],
  ['access-unassigned-routes', 'focused-source-trace'],
  ['access-assistant-routes', 'focused-source-trace'],
  ['access-appearance-routes', 'focused-source-trace'],
  ['access-drawing-hierarchy-routes', 'focused-source-trace'],
  ['access-indirect-resolved', 'indirect-source-classification'],
];
const omitted = new Set(['rawCensusRow', 'pinnedAnchorExcerpt', 'evidence', 'ownerEvidence',
  'childBranchEvidence', 'sourceGates', 'sourceMountEdges', 'sourceSha256']);
function compact(value) {
  if (Array.isArray(value)) return value.map(compact);
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value)
    .filter(([key]) => !omitted.has(key)).map(([key, item]) => [key, compact(item)]));
  if (typeof value === 'string') return value.replaceAll('/home/louistrue/.t3/worktrees/ifc-lite/t3-fd0b1714/', '');
  return value;
}
function summarize(row) {
  const { controls, sites, originalInventorySites, source, originalInventorySource,
    sourceRefs, original, originalSites, ...route } = row;
  const reviewedControls = controls ?? ((row.terminalSemantics || row.assistantReport) ? sites : undefined);
  // Originals are stored once above. Keep semantic paths and terminal boundaries;
  // source excerpts/call-graph dumps remain in hash-identified immutable reports.
  return compact({ ...route, controls: reviewedControls?.map((control, index) => ({
    id: control.id ?? control.branchId ?? `${row.id}.${index + 1}`,
    path: control.orderedUserControlPath ?? control.orderedRoute ?? control.route ?? control.orderedChildControls
      ?? control.orderedTail ?? control.orderedChildControl ?? control.sequenceRef
      ?? control.bindings?.map(binding => binding.orderedControlTail) ?? null,
    terminal: control.terminalCanonicalPublicAction ?? control.canonicalHandlerBoundary
      ?? control.operationTargets ?? control.canonicalAction ?? control.semanticAction
      ?? control.bindings?.map(binding => binding.handler) ?? control.binding ?? null,
    qualification: control.classification ?? control.disposition ?? control.sequenceStatus ?? null,
    unresolved: control.unresolved ?? control.uncertainty ?? null,
    oracle: control.finiteOracle ?? control.oracleRef ?? control.scenarioOracleRef ?? control.scenarioRef ?? control.scenario ?? null,
    ...(control.publicHandler ? { publicHandler: control.publicHandler } : {}),
    ...(control.resolvedSource ? { resolvedSource: control.resolvedSource } : {}),
    ...(control.prerequisitesRef ? { prerequisitesRef: control.prerequisitesRef } : {}),
  })) });
}
for (const [name, kind] of sources) {
  const data = await report(name);
  for (const row of data.rows ?? data.records) {
    const target = inventory.get(row.id);
    if (!target) throw new Error(`Unknown census identity ${row.id} in ${name}`);
    target.review = summarize(row);
    target.reviewKind = kind;
    target.reviewReport = reportRefs.at(-1).filename;
  }
}
const records = [...inventory.values()].map(compact);
const sites = records.reduce((count, row) => count + row.originalSites.length, 0);
if (records.length !== 813 || sites !== 3994) throw new Error(`Census changed: ${records.length} records / ${sites} sites`);
await writeFile(join(output, 'source-controls.jsonl'), records.map(row => JSON.stringify(row)).join('\n') + '\n');
await writeFile(join(output, 'provenance.json'), JSON.stringify({ issue: 8947,
  acceptedUx: original.acceptedUX, acceptedUxTree: original.acceptedTree,
  originalCensus: { controls: 624, indirect: 189, sourceSites: sites }, reports: reportRefs,
  qualification: 'Counts are source accounting, not distinct capabilities or coverage. Every runtime verdict remains UNRUN. Review commits differ; reconcile changed routes against the final candidate before acceptance.',
}, null, 2) + '\n');
console.log(`Preserved ${records.length} identities and ${sites} original source anchors; no behavior promoted.`);
