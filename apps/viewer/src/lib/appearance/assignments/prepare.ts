/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import { StepExporter } from '@ifc-lite/export';
import { StoreEditor, type MutablePropertyView } from '@ifc-lite/mutations';
import { useViewerStore } from '@/store';
import type { AppearancePlanner } from '../planner-worker-client.js';
import type { AppearanceAssetOwner } from '../assets.js';
import type { AppearancePreviewImage } from '../preview.js';
import type { AppearancePlan } from '../planner-types.js';
import type { AppearanceSnapshot } from '../snapshot.js';
import { appearanceAssets, modelAppearanceAssets } from '../model-assets.js';
import { appearanceMapping } from '../settings.js';
import { preparePdfPagePreview } from '../pdf/page-preview.js';
import { prepareAppearanceEntities } from '../prepare-plan.js';
import type { CapturedAssignment } from './capture.js';
import { resolveAppearanceAssignments } from './resolve.js';

export interface PreparedAssignmentStep {
  assignmentId: string;
  modelId: string;
  plan: AppearancePlan;
  assetIds: string[];
  imageUri: string;
  bitmap: ImageBitmap;
  itemImages?: Map<number, AppearancePreviewImage>;
}

/** Plan rows against successive detached effective IFC states. The native planner
 * sees prior allocations/shared-style edits; plans from the same base are never
 * blindly concatenated. Source products are disjoint after ordered resolution. */
interface PrepareAssignmentsOptions {
  captured: readonly CapturedAssignment[];
  planner: AppearancePlanner;
  owner: AppearanceAssetOwner;
  signal: AbortSignal;
  onProgress?(finished: number, total: number): void;
}
export async function prepareAppearanceAssignments(options: PrepareAssignmentsOptions) {
  try { return await prepareAssignments(options); }
  catch (error) {
    try { appearanceAssets.releaseOwner(options.owner); }
    catch (cleanup) { throw new AggregateError([error, cleanup], 'Assignment preparation failed and image cleanup could not complete.'); }
    throw error;
  }
}
async function prepareAssignments(options: PrepareAssignmentsOptions) {
  const { captured, planner, owner, signal } = options;
  const identities = captured.map(row => JSON.stringify(row.assignment));
  const rows = resolveAppearanceAssignments(structuredClone(captured.map(row => row.assignment)));
  const validate = () => {
    signal.throwIfAborted();
    if (captured.length !== identities.length) throw new Error('The assignment list changed during preparation.');
    for (const [index, row] of captured.entries()) {
      if (JSON.stringify(row.assignment) !== identities[index]) throw new Error('An assignment changed during preparation. Review the scope again.');
      if (row.assignment.model.modelId !== row.snapshot.modelId || row.assignment.model.revision !== row.snapshot.revision) {
        throw new Error('An assignment no longer matches its reviewed model snapshot.');
      }
      row.validate();
    }
  };
  validate();
  const snapshots = new Map<string, AppearanceSnapshot>();
  const shadows = new Map<string, MutablePropertyView>();
  const steps: PreparedAssignmentStep[] = [];
  let retainedSourceBytes = 0;
  for (const [index, row] of rows.entries()) {
    if (!row.productIds.length) continue;
    validate();
    const saved = captured[index], assignment = row.assignment, modelId = assignment.model.modelId;
    const model = useViewerStore.getState().models.get(modelId)!, view = useViewerStore.getState().mutationViews.get(modelId)!;
    if (!model.ifcDataStore || !view) throw new Error('An assignment model is no longer editable.');
    let shadow = shadows.get(modelId), snapshot = snapshots.get(modelId);
    if (!shadow || !snapshot) {
      snapshot = saved.snapshot;
      retainedSourceBytes += snapshot.bytes.byteLength;
      if (retainedSourceBytes > 256 * 1024 * 1024) throw new Error('Combined appearance snapshots exceed 256 MiB. Choose fewer or smaller models.');
      shadow = view.prepareAtomic(draft => draft).result;
      shadows.set(modelId, shadow); snapshots.set(modelId, snapshot);
    } else {
      const exported = await new StepExporter(model.ifcDataStore, shadow).exportAsync({ schema: snapshot.schema,
        applyMutations: true, includeGeometry: true, visibleOnly: false, onProgress: validate });
      validate();
      const bytes = typeof exported.content === 'string' ? new TextEncoder().encode(exported.content) : exported.content;
      if (bytes.byteLength > 128 * 1024 * 1024) throw new Error('A staged appearance model exceeds the 128 MiB planner limit.');
      snapshot = { ...snapshot, bytes, nextExpressId: shadow.peekNextExpressId(), validate };
    }
    const source = assignment.source, settings = assignment.settings, assetId = source.assetId ?? source.id;
    const page = source.pdf ? await preparePdfPagePreview({ snapshot, productIds: row.productIds,
      source, settings, planner, owner, signal }) : undefined;
    validate();
    const first = page?.itemImages.values().next().value;
    const imageUri = page ? first?.imageUri ?? '' : modelAppearanceAssets.getAuthoredUri(modelId, assetId);
    if (!page) appearanceAssets.retain(assetId, owner);
    const bitmap = page ? first?.bitmap : await appearanceAssets.decode(assetId, owner, signal);
    const plan = page?.plan ?? await planner.plan(snapshot.bytes, { schema: snapshot.schema, sourceRevision: snapshot.revision,
      nextExpressId: snapshot.nextExpressId, productIds: row.productIds, imageUri,
      repeatS: settings.repeatS, repeatT: settings.repeatT, representationPolicy: settings.representationPolicy ?? 'preserve', mapping: appearanceMapping(settings) }, { signal });
    validate();
    if (!plan.items.length || plan.exclusions.length || !bitmap) {
      throw new Error(`${assignment.model.name}: ${plan.exclusions[0]?.reason ?? 'Some assigned objects cannot receive this appearance. Review the scope and explicit exclusions.'}`);
    }
    const prepared = await prepareAppearanceEntities(new StoreEditor(model.ifcDataStore, shadow), shadow, plan, snapshot.revision, { signal });
    try { validate(); prepared.prepared.commit(); } finally { prepared.prepared.dispose(); }
    steps.push({ assignmentId: assignment.id, modelId, plan, bitmap, imageUri,
      assetIds: page ? page.assetIds : [assetId], ...(page ? { itemImages: page.itemImages } : {}) });
    options.onProgress?.(steps.length, rows.filter(row => row.productIds.length).length);
  }
  validate();
  if (!steps.length) throw new Error('All assigned objects are excluded or replaced. Include objects before previewing.');
  return { steps, snapshots, validate };
}
