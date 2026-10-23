/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { MAX_NAME_LENGTH } from '../clash/manual-groups';

export { clashDisciplineCandidates } from '@ifc-lite/sdk/review';

export const CLASH_TAXONOMY_LIMITATIONS =
  'Default taxonomy: native status (detection type) and severity plus discipline pairs. ' +
  'disciplineCandidates are native IFC-type selector hints for each side, not verified project mappings. ' +
  'Multiple candidates are ambiguous; an empty list is unknown. Preserve all alternatives and side/model identities. ' +
  'Detection status is not human review status. Never change native severity or infer resolved/accepted from grouping. ' +
  'Omitted findings remain unclassified. BCF assignees stay empty until a verified project mapping is chosen.';

/** Per-group text caps enforced by the clash group parsers and stated in the prompt (#7651).
 *  Proposed groups become manual groups, so the name cap is the manual-group cap. */
export const CLASH_GROUP_NAME_MAX = MAX_NAME_LENGTH;
export const CLASH_GROUP_EXPLANATION_MAX = 1200;

export const CLASH_GROUP_OUTPUT_GUIDANCE =
  'When asked for a grouping proposal, return only JSON {"version":1,"kind":"clash.groups",' +
  '"groups":[{"name":"Group name","explanation":"Inference and rationale","citations":["E1"]}]}. ' +
  'Use only supplied complete finding citations, each once, at most 30 groups and 100 findings. ' +
  `Each group name must be at most ${CLASH_GROUP_NAME_MAX} characters and each explanation at most ` +
  `${CLASH_GROUP_EXPLANATION_MAX} characters; one over-long group rejects the whole proposal. ` +
  'Group by native type/severity and discipline pair candidates, preserving ambiguity. ' +
  'Never output status changes, severity changes, assignees or executable actions. Unmentioned findings remain unclassified.';
