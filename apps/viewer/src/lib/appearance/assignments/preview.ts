/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import { expandAppearanceCorners, type Renderer } from '@ifc-lite/renderer';
import { useViewerStore } from '@/store';
import { AppearancePreviewSession, bindAppearancePreview, type AppearancePreviewParts } from '../preview.js';
import { prepareAppearanceAssignments } from './prepare.js';
import type { CapturedAssignment } from './capture.js';

/** Bind every prepared row before the first scene change. One session owns all
 * tokens, so Compare, cancellation and commit cannot leave a partial model set. */
export function stageAppearanceAssignments(preparation: Awaited<ReturnType<typeof prepareAppearanceAssignments>>,
  captured: readonly CapturedAssignment[], renderer: Renderer) {
  preparation.validate();
  const groups = new Map<string, AppearancePreviewParts[]>(), state = useViewerStore.getState();
  for (const step of preparation.steps) {
    const row = captured.find(item => item.assignment.id === step.assignmentId);
    if (!row) throw new Error('An assignment was removed before preview.');
    const { repeatS, repeatT } = row.assignment.settings;
    const parts = bindAppearancePreview(state, renderer, step.modelId, step.plan, step.bitmap,
      step.imageUri, repeatS, repeatT, expandAppearanceCorners, step.itemImages);
    const modelParts = groups.get(step.modelId) ?? [];
    for (const part of parts) modelParts.push(part);
    groups.set(step.modelId, modelParts);
  }
  preparation.validate();
  const session = new AppearancePreviewSession(renderer);
  session.stage([...groups.values()].flat());
  return { session, groups };
}
