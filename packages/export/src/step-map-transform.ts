/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { assembleStepBytes } from './step-file-assembly.js';
import { readStepSlots } from './step-argument-parser.js';
import type { ExportPass } from './step-export-types.js';

interface EntityPatch { expressId: number; line: string }
interface NormalizationPlan { replacements: EntityPatch[]; newEntities: EntityPatch[]; warnings: string[] }

/** Mutation-resolved final-pass seam. Rust owns all coordinate math and IFC
 * semantic preflight; TypeScript applies complete patches and settles the same
 * per-entity ledger as the other export phases (#6587).
 */
export async function normalizeMapGeometry(pass: ExportPass, reserveId: (id: number) => void): Promise<void> {
  // Ordinary STEP export remains usable without a WASM runtime installed.
  const { GeometryProcessor } = await import('@ifc-lite/geometry');
  const processor = new GeometryProcessor();
  let plan: NormalizationPlan;
  try {
    await processor.init();
    const content = assembleStepBytes(pass.buildHeader(0), pass.entities);
    plan = readPlan(processor.planMapConversionNormalization(content));
  } finally {
    processor.dispose();
  }
  if (plan.warnings.length) {
    if (plan.replacements.length || plan.newEntities.length) throw new Error('Non-atomic map normalization plan.');
    pass.warnings.push(...plan.warnings);
    return;
  }
  // Validate the entire patch set before changing an output line. A binding
  // mismatch must not produce a partly normalized model or overwrite an ID.
  const indexes = new Map<number, number>();
  for (let index = 0; index < pass.entities.length; index++) {
    const id = entityId(pass.entities[index]);
    if (id !== undefined) {
      if (indexes.has(id)) throw new Error('Duplicate entity in normalization input.');
      indexes.set(id, index);
    }
  }
  const used = new Set<number>();
  for (const patch of [...plan.replacements, ...plan.newEntities]) {
    if (used.has(patch.expressId)) throw new Error('Duplicate map normalization patch.');
    used.add(patch.expressId);
  }
  if (plan.replacements.some(patch => !indexes.has(patch.expressId))
    || plan.newEntities.some(patch => indexes.has(patch.expressId))) {
    throw new Error('Map normalization patch IDs do not match the completed export pass.');
  }
  for (const patch of plan.replacements) {
    // All IDs were validated above; preserve full lines/edits from this pass.
    const index = indexes.get(patch.expressId);
    if (index === undefined) throw new Error('Map normalization replacement is absent.');
    pass.entities[index] = patch.line;
    if (!pass.effective.isOverlayCreated(patch.expressId) && pass.effective.has(patch.expressId)) {
      pass.modifications.nominate(patch.expressId, 'positional');
      pass.modifications.recordEmitted(patch.expressId, 'positional');
    }
  }
  for (const patch of plan.newEntities) {
    pass.entities.push(patch.line);
    reserveId(patch.expressId);
  }
  pass.newEntityCount += plan.newEntities.length;
}

function entityId(line: string): number | undefined {
  const token = /^\s*#([0-9]+)/.exec(line)?.[1];
  return token === undefined ? undefined : Number(token);
}

function readPlan(serialized: string): NormalizationPlan {
  const value: unknown = JSON.parse(serialized);
  if (typeof value !== 'object' || value === null || !('replacements' in value) || !('newEntities' in value)
    || !('warnings' in value) || !isPatches(value.replacements) || !isPatches(value.newEntities)
    || !Array.isArray(value.warnings) || !value.warnings.every((warning: unknown) => typeof warning === 'string')) {
    throw new Error('Invalid canonical map normalization plan.');
  }
  return { replacements: value.replacements, newEntities: value.newEntities, warnings: value.warnings };
}

function isPatches(value: unknown): value is EntityPatch[] {
  return Array.isArray(value) && value.every((patch: unknown) => {
    if (typeof patch !== 'object' || patch === null || !('expressId' in patch) || !('line' in patch)
      || typeof patch.expressId !== 'number' || !Number.isSafeInteger(patch.expressId)
      || patch.expressId <= 0 || patch.expressId > 0xffff_ffff || typeof patch.line !== 'string') return false;
    return entityId(patch.line) === patch.expressId && readStepSlots(patch.line) !== null;
  });
}
