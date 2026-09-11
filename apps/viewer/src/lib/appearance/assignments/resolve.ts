/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import type { AppearanceAssignment, AssignmentProduct, ResolvedAssignment } from './types.js';

export const ASSIGNMENT_LIMITS = { rows: 64, models: 8, members: 10_000 } as const;

function membership(products: readonly AssignmentProduct[]): Map<string, number> {
  const byGuid = new Map<string, number>(), ids = new Set<number>();
  for (const product of products) {
    if (!Number.isSafeInteger(product.expressId) || product.expressId <= 0 || !product.GlobalId
      || byGuid.has(product.GlobalId) || ids.has(product.expressId)) {
      throw new Error('Assignment membership needs unique IFC GlobalIds and positive object IDs. Review the model scope.');
    }
    byGuid.set(product.GlobalId, product.expressId); ids.add(product.expressId);
  }
  return byGuid;
}

/** Last included row wins. Excluding a row member exposes any earlier assignment;
 * it does not remove the object from unrelated rows or another model. */
export function resolveAppearanceAssignments(assignments: readonly AppearanceAssignment[]): ResolvedAssignment[] {
  if (!assignments.length || assignments.length > ASSIGNMENT_LIMITS.rows) {
    throw new Error(`Choose between 1 and ${ASSIGNMENT_LIMITS.rows} appearance assignments.`);
  }
  const rowIds = new Set<string>();
  const models = new Map<string, AppearanceAssignment['model']>();
  const slotModels = new Map<string, string>();
  const modelMembers = new Map<string, Map<number, string>>();
  const modelGuids = new Map<string, Map<string, number>>();
  const candidates = assignments.map(assignment => {
    if (!assignment.id || rowIds.has(assignment.id)) throw new Error('Appearance assignment IDs must be unique.');
    rowIds.add(assignment.id);
    const model = assignment.model, previous = models.get(model.modelId);
    if (!model.modelId || !model.slotId || !model.revision || !/^[a-f0-9]{64}$/.test(model.sourceSha256)) {
      throw new Error('Pin each assignment to a loaded model and its source identity.');
    }
    if (previous && (previous.slotId !== model.slotId || previous.sourceSha256 !== model.sourceSha256 || previous.revision !== model.revision)
      || slotModels.has(model.slotId) && slotModels.get(model.slotId) !== model.modelId) {
      throw new Error('Assignments refer to different versions of a model. Review their scope together.');
    }
    models.set(model.modelId, model); slotModels.set(model.slotId, model.modelId);
    if (models.size > ASSIGNMENT_LIMITS.models || assignment.members.length > ASSIGNMENT_LIMITS.members) {
      throw new Error('The assignment scope exceeds the model or object preparation limit.');
    }
    const source = assignment.source;
    if (!source.id || !/^[a-f0-9]{64}$/.test(source.assetId ?? source.id)
      || !Number.isSafeInteger(source.width) || source.width <= 0
      || !Number.isSafeInteger(source.height) || source.height <= 0) {
      throw new Error('Retain an exact image derivative before adding an assignment.');
    }
    const known = modelMembers.get(model.modelId) ?? new Map<number, string>();
    const knownGuids = modelGuids.get(model.modelId) ?? new Map<string, number>();
    for (const product of assignment.members) {
      if ((known.has(product.expressId) && known.get(product.expressId) !== product.GlobalId)
        || (knownGuids.has(product.GlobalId) && knownGuids.get(product.GlobalId) !== product.expressId)) {
        throw new Error('Assignment object identity changed between rows. Review the model scope.');
      }
      known.set(product.expressId, product.GlobalId);
      knownGuids.set(product.GlobalId, product.expressId);
    }
    modelMembers.set(model.modelId, known); modelGuids.set(model.modelId, knownGuids);
    const members = membership(assignment.members), exclusions = new Set(assignment.excludedGlobalIds);
    if (exclusions.size !== assignment.excludedGlobalIds.length || [...exclusions].some(guid => !members.has(guid))) {
      throw new Error('An excluded object is no longer in the reviewed assignment scope.');
    }
    return { assignment, excluded: exclusions.size, overridden: 0,
      productIds: assignment.members.filter(product => !exclusions.has(product.GlobalId)).map(product => product.expressId) };
  });
  const winners = new Map<string, Set<number>>();
  for (const row of [...candidates].reverse()) {
    const claimed = winners.get(row.assignment.model.modelId) ?? new Set<number>();
    const before = row.productIds.length;
    row.productIds = row.productIds.filter(id => !claimed.has(id)).sort((a, b) => a - b);
    row.overridden = before - row.productIds.length;
    for (const id of row.productIds) claimed.add(id);
    winners.set(row.assignment.model.modelId, claimed);
  }
  for (const members of winners.values()) if (members.size > ASSIGNMENT_LIMITS.members) {
    throw new Error('The combined assignments exceed the per-model object preparation limit.');
  }
  return candidates;
}

/** IDs may be renumbered on reload; membership is compared by IFC GlobalId.
 * The caller must explicitly bind the model slot and approve changes before
 * constructing a fresh assignment. This function never silently updates a recipe. */
export function compareAssignmentMembership(previous: readonly AssignmentProduct[], current: readonly AssignmentProduct[]) {
  const old = membership(previous), next = membership(current);
  return {
    added: [...next.keys()].filter(guid => !old.has(guid)).sort(),
    removed: [...old.keys()].filter(guid => !next.has(guid)).sort(),
    renumbered: [...next].filter(([guid, id]) => old.has(guid) && old.get(guid) !== id)
      .map(([GlobalId, expressId]) => ({ GlobalId, expressId })).sort((a, b) => a.GlobalId.localeCompare(b.GlobalId)),
  };
}
