/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import type { MutablePropertyView } from '@ifc-lite/mutations';
import { useViewerStore } from '@/store';
import { appearanceRevision } from '../command.js';
import type { CapturedAssignment } from './capture.js';
import type { AppearanceAssignment } from './types.js';

// Weak view keys release their checkpoints when a loaded model disappears. These
// tickets retain no exported IFC bytes, renderer meshes, assets or native plans.
const tickets = new WeakMap<MutablePropertyView, Map<string, {
  row: string; source: CapturedAssignment['snapshot']['source']; data: WeakRef<object>;
}>>();
export function rememberAssignmentReview(captured: CapturedAssignment): void {
  const state = useViewerStore.getState(), row = captured.assignment;
  const view = state.mutationViews.get(row.model.modelId), data = state.models.get(row.model.modelId)?.ifcDataStore;
  if (!view || !data) return;
  const entries = tickets.get(view) ?? new Map();
  entries.set(row.id, { row: JSON.stringify(row), source: captured.snapshot.source, data: new WeakRef(data) });
  while (entries.size > 64) entries.delete(entries.keys().next().value!);
  tickets.set(view, entries);
}
export function forgetAssignmentReview(row: AppearanceAssignment): void {
  const view = useViewerStore.getState().mutationViews.get(row.model.modelId);
  if (view) tickets.get(view)?.delete(row.id);
}
export function canResumeAssignmentReview(row: AppearanceAssignment): boolean {
  const state = useViewerStore.getState(), view = state.mutationViews.get(row.model.modelId);
  const ticket = view && tickets.get(view)?.get(row.id);
  if (!ticket || ticket.row !== JSON.stringify(row) || row.model.revision !== appearanceRevision(row.model.modelId)
    || ticket.data.deref() !== state.models.get(row.model.modelId)?.ifcDataStore) return false;
  try { ticket.source.validate(view); return true; }
  catch {
    // An expected stale source removes the ticket; the visible binding controls
    // require explicit review before any new plan can be prepared.
    tickets.get(view!)?.delete(row.id); return false;
  }
}
