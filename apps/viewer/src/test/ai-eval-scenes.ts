/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Evaluation scenes (#6928): real committed models seeded into the singleton
 * store exactly as a coordinator would have them, so a recorded or live
 * provider answer is reviewed against native state. Each scene returns the
 * captured evidence the Assistant would send. Shared by the recorded-response
 * CI harness and the live-evaluation request exporter, so both see one
 * evidence contract.
 *
 * Scenes read committed samples under `apps/viewer/public/samples` and the
 * captured native clash result in `tests/ai-eval/native`. A fixture-mechanism
 * scene (`validation-fzk-haus`) reports `missing` when `pnpm fixtures` has not
 * been run, so callers can skip with the prescribed message.
 */

import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { summarizeClashes, type Clash, type ClashResult } from '@ifc-lite/clash';
import { parseIDS, validateIDS } from '@ifc-lite/ids';
import { useViewerStore } from '@/store';
import { createDataAccessor } from '@/hooks/ids/idsDataAccessor';
import { configureMutationView } from '@/utils/configureMutationView';
import { captureEvidence, type EvidenceSnapshot } from '@/lib/assistant/evidence';
import { newFlowDocument } from '@/lib/flow/persistence';
import { fixtureModel, fixtureModels } from '@/test/store-fixture';
import { SAMPLE_MODEL, parseIfc, seedAuthoringSample } from '@/test/authoring-sample-fixture';
import type { IfcDataStore } from '@ifc-lite/parser';

export const AI_EVAL_SCENES = ['clash-rev-b', 'validation-sample', 'validation-fzk-haus', 'authoring-sample', 'flow-empty'] as const;
export type AiEvalScene = typeof AI_EVAL_SCENES[number];
export const isAiEvalScene = (value: unknown): value is AiEvalScene =>
  typeof value === 'string' && AI_EVAL_SCENES.some(scene => scene === value);

export type SceneResult = { kind: 'ready'; evidence: EvidenceSnapshot } | { kind: 'missing'; message: string };

/** The store as first imported; every scene starts from it so scenes never leak into each other. */
const pristine = useViewerStore.getState();
const repo = (path: string) => new URL(`../../../../${path}`, import.meta.url);
const samples = (name: string) => repo(`apps/viewer/public/samples/${name}`);
const sha256 = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');

interface NativeClashFixture {
  provenance: { model: string; sha256: string; options: { mode: string; clearance?: number } };
  result: { clashes: Clash[]; ruleCoverage?: ClashResult['ruleCoverage']; truncated: unknown };
}

/** The CLI's clearance run on the committed rev-B sample, pinned to the sample bytes it came from. */
async function seedClashRevB(): Promise<EvidenceSnapshot> {
  const fixture = JSON.parse(await readFile(repo('tests/ai-eval/native/clash-rev-b-clearance.json'), 'utf8')) as NativeClashFixture;
  const bytes = new Uint8Array(await readFile(repo(fixture.provenance.model)));
  if (sha256(bytes) !== fixture.provenance.sha256) {
    throw new Error(`${fixture.provenance.model} changed since the native clash result was captured; regenerate tests/ai-eval/native`);
  }
  const store = await parseIfc(bytes);
  const modelId = fixture.result.clashes[0]?.a.model ?? 'building-architecture-rev-b.ifc';
  // Every recorded side must still name a real entity of the parsed model (no fabricated identities).
  for (const clash of fixture.result.clashes) {
    for (const side of [clash.a, clash.b]) {
      if (side.model !== modelId || store.entities.getGlobalId(side.ref) !== side.key || store.entities.getTypeName(side.ref) !== side.tag) {
        throw new Error(`Native clash side ${side.key} no longer resolves in ${modelId}`);
      }
    }
  }
  const clashes = fixture.result.clashes;
  const result: ClashResult = { clashes, summary: summarizeClashes(clashes), rulesRun: [], ruleCoverage: fixture.result.ruleCoverage,
    settings: { tolerance: 0.002, excludeVoidsAndHosts: true } };
  useViewerStore.setState({ ...fixtureModels({ ...fixtureModel(modelId), ifcDataStore: store, sourceFingerprint: fixture.provenance.sha256 }),
    clashResult: result, clashRawResult: result });
  return captureEvidence('clash');
}

/** Native IDS run of the committed sample IDS against a parsed model; evidence is the native report. */
async function validate(store: IfcDataStore, modelId: string): Promise<EvidenceSnapshot> {
  const document = parseIDS(await readFile(samples('building-architecture.ids'), 'utf8'));
  const report = await validateIDS(document, createDataAccessor(store, modelId),
    { modelId, schemaVersion: 'IFC4', entityCount: store.entities.count });
  // The run's wall-clock time is the only non-deterministic evidence field; freeze it so recordings can be compared byte for byte.
  useViewerStore.setState({ idsValidationReport: { ...report, timestamp: new Date(Date.UTC(2026, 9, 5)) } });
  return captureEvidence('validation');
}

export async function seedScene(scene: AiEvalScene): Promise<SceneResult> {
  useViewerStore.setState(pristine, true);
  if (scene === 'clash-rev-b') return { kind: 'ready', evidence: await seedClashRevB() };
  if (scene === 'validation-sample') {
    // The authoring seed: the same committed sample with Edit mode on, so corrections can be previewed.
    const { dataStore, view } = await seedAuthoringSample();
    configureMutationView(view, dataStore); // as the viewer does on load: base properties are read on demand
    return { kind: 'ready', evidence: await validate(dataStore, SAMPLE_MODEL) };
  }
  if (scene === 'validation-fzk-haus') {
    let bytes: Uint8Array;
    try { bytes = new Uint8Array(await readFile(repo('tests/models/ara3d/AC20-FZK-Haus.ifc'))); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { kind: 'missing', message: 'Run pnpm fixtures to fetch AC20-FZK-Haus.ifc' };
      throw error;
    }
    const store = await parseIfc(bytes);
    useViewerStore.setState(fixtureModels({ ...fixtureModel('AC20-FZK-Haus.ifc'), ifcDataStore: store, sourceFingerprint: sha256(bytes) }));
    return { kind: 'ready', evidence: await validate(store, 'AC20-FZK-Haus.ifc') };
  }
  if (scene === 'authoring-sample') {
    await seedAuthoringSample();
    return { kind: 'ready', evidence: captureEvidence('loadReport') };
  }
  // A fixed id keeps the frozen evidence reproducible (newFlowDocument mints a random UUID).
  const doc = { ...newFlowDocument('Coordinator workflow'), id: '00000000-0000-4000-8000-000000006928' };
  useViewerStore.setState({ flowDoc: doc, activeFlowId: doc.id, flowRunning: false });
  return { kind: 'ready', evidence: captureEvidence('flow') };
}

/** Evidence as recorded with a case: the outbound payload minus its capture time. */
export function comparableEvidence(evidence: EvidenceSnapshot): Record<string, unknown> {
  const payload = JSON.parse(evidence.payload) as Record<string, unknown>;
  delete payload.capturedAt;
  return payload;
}
