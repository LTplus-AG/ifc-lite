/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import type { AppearancePlanner } from '../planner-worker-client.js';
import { captureAppearanceAssignment, assignmentProductGlobalId, type CapturedAssignment } from './capture.js';
import type { AppearanceAssignment } from './types.js';
import { compareAssignmentMembership } from './resolve.js';
import { ownAssignmentSource } from './source.js';

function sourceIdentity(source: AppearanceAssignment['source']): string {
  source = ownAssignmentSource(source);
  return JSON.stringify({ assetId: source.assetId ?? source.id, width: source.width, height: source.height,
    pdf: source.pdf ? { document: source.pdf.documentSha256 ?? source.pdf.documentKey, recipe: source.pdf.recipe } : undefined, calibration: source.calibration, calibrationFrame: source.calibrationFrame });
}

/** A saved slot is rebound only to the model explicitly selected by the user.
 * This returns a proposed recipe and membership report, never an applied edit. */
export async function reviewRestoredAssignment(options: {
  saved: AppearanceAssignment; modelId: string; sourceId: string;
  planner: AppearancePlanner; signal: AbortSignal;
}) {
  const { saved } = options;
  const captured = await captureAppearanceAssignment({ modelId: options.modelId, slotId: saved.model.slotId,
    sourceId: options.sourceId, scope: { kind: 'model' }, settings: saved.settings,
    planner: options.planner, signal: options.signal });
  if (sourceIdentity(captured.assignment.source) !== sourceIdentity(saved.source)) {
    throw new Error('Choose the original image derivative and PDF page/calibration before restoring this assignment.');
  }
  const catalog = captured.snapshot.catalog, query = saved.query;
  const current = captured.assignment.members;
  const localIds = new Set<number>();
  if (query.kind === 'class') {
    for (const product of catalog.products) if (product.ifcClass === query.ifcClass) localIds.add(product.productId);
  } else if (query.kind === 'type') {
    const type = catalog.types.find(item => assignmentProductGlobalId(captured.snapshot, item.typeId) === query.GlobalId);
    if (type) for (const product of catalog.products) if (product.typeIds.includes(type.typeId)) localIds.add(product.productId);
  }
  const selected = new Set(query.kind === 'selection' ? query.GlobalIds : []);
  const members = current.filter(product => query.kind === 'model'
    || (query.kind === 'selection' ? selected.has(product.GlobalId) : localIds.has(product.expressId)));
  const available = new Set(members.map(product => product.GlobalId));
  const removedExclusions = saved.excludedGlobalIds.filter(guid => !available.has(guid));
  const assignment: AppearanceAssignment = { ...captured.assignment, id: saved.id,
    query: structuredClone(query), members, excludedGlobalIds: saved.excludedGlobalIds.filter(guid => available.has(guid)) };
  const proposed: CapturedAssignment = { ...captured, assignment };
  return { proposed, changes: compareAssignmentMembership(saved.members, members), removedExclusions,
    sourceModelChanged: saved.model.sourceSha256 !== assignment.model.sourceSha256 };
}
