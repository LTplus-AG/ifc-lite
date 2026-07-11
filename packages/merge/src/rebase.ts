/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Rebase: state-based ops make this cheap — re-run the three-way plan
 * against the new base. Prior resolutions replay automatically because
 * resolution ops shadow. No operational transform, ever (05 §5.4).
 */

import type { IfcxFile } from '@ifc-lite/ifcx';
import type { MergePlan, ResolutionInput } from './types.js';
import { planThreeWayMerge } from './three-way.js';
import { applyResolutions, type AppliedResolutions } from './merge-layer.js';

export interface RebaseInputs {
  /** The candidate layer being rebased. */
  candidate: IfcxFile;
  /** The candidate's original base, ordered weakest first. */
  oldBase: readonly IfcxFile[];
  /** The new base to plan against, ordered weakest first. */
  newBase: readonly IfcxFile[];
  /** Resolutions from earlier merge attempts, replayed onto the new plan. */
  priorResolutions?: readonly ResolutionInput[];
}

export interface RebaseResult {
  plan: MergePlan;
  /** Prior resolutions applied to the new plan (replayed automatically). */
  applied: AppliedResolutions;
}

export function planRebase(inputs: RebaseInputs): RebaseResult {
  const plan = planThreeWayMerge({
    ancestor: inputs.oldBase,
    ours: inputs.newBase,
    theirs: [...inputs.oldBase, inputs.candidate],
  });
  const applied = applyResolutions(plan, inputs.priorResolutions ?? []);
  return { plan, applied };
}
