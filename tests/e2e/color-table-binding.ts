/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Group 1 for witness pipelines that compile the production main shader with
 * their own layouts. Its vertex stages read the entity colour table (group 1,
 * binding 5) for the painted depth nudge (#11411). An empty table paints
 * nothing, so every depth these witnesses measure is the unpainted one.
 */
import { MaskTableGroup, maskTableLayout } from '../../packages/renderer/src/mask-color-table.js';

const groups = new WeakMap<GPUDevice, MaskTableGroup>();

/** The group-1 layout (colour table, vertex-visible) to put at index 1 of a witness pipeline layout. */
export function colorTableLayout(device: GPUDevice): GPUBindGroupLayout {
  return maskTableLayout(device, false);
}

/** The matching bind group over an empty table: bind it at group 1 after `setPipeline`. */
export function emptyColorTableGroup(device: GPUDevice): GPUBindGroup {
  let group = groups.get(device);
  if (!group) { group = new MaskTableGroup(device); groups.set(device, group); }
  return group.get(null);
}
