/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import { expandAppearanceCorners, type Renderer } from '@ifc-lite/renderer';
import { useViewerStore } from '@/store';
import { AppearancePreviewSession, bindAppearancePreview, type AppearancePreviewParts } from '../preview.js';
import { prepareAppearanceAssignments } from './prepare.js';
import type { CapturedAssignment } from './capture.js';
import type { AppearancePlan } from '../planner-types.js';

/** One virtual, contiguous ownership range per model until coordinated Apply. */
export function assignmentPreviewCreatedByModel(steps: readonly { modelId: string; plan: Pick<AppearancePlan, 'created'> }[]) {
  const result = new Map<string, { expressId: number }[]>();
  for (const step of steps) {
    const created = result.get(step.modelId) ?? [];
    created.push(...step.plan.created);
    result.set(step.modelId, created);
  }
  for (const [modelId, created] of result) for (let index = 1; index < created.length; index++) {
    if (created[index]!.expressId !== created[index - 1]!.expressId + 1) {
      throw new Error(`Detached assignment IDs for ${modelId} must be contiguous and source ordered.`);
    }
  }
  return result;
}

/** Bind every prepared row before the first scene change. One session owns all
 * tokens, so Compare, cancellation and commit cannot leave a partial model set. */
export function stageAppearanceAssignments(preparation: Awaited<ReturnType<typeof prepareAppearanceAssignments>>,
  captured: readonly CapturedAssignment[], renderer: Renderer) {
  preparation.validate();
  const groups = new Map<string, AppearancePreviewParts[]>(), state = useViewerStore.getState();
  // Successive plans for one model are prepared against a detached shadow
  // overlay. Their IDs form one virtual range until the coordinated commit;
  // binding each step against only its own tail would incorrectly require the
  // preceding detached step to have been published already.
  const detachedCreated = assignmentPreviewCreatedByModel(preparation.steps);
  for (const step of preparation.steps) {
    const row = captured.find(item => item.assignment.id === step.assignmentId);
    if (!row) throw new Error('An assignment was removed before preview.');
    const { repeatS, repeatT } = row.assignment.settings;
    const parts = bindAppearancePreview(state, renderer, step.modelId, step.plan, step.bitmap,
      step.imageUri, repeatS, repeatT, expandAppearanceCorners, step.itemImages, detachedCreated.get(step.modelId));
    const modelParts = groups.get(step.modelId) ?? [];
    for (const part of parts) modelParts.push(part);
    groups.set(step.modelId, modelParts);
  }
  preparation.validate();
  const session = new AppearancePreviewSession(renderer);
  session.stage([...groups.values()].flat());
  return { session, groups };
}
