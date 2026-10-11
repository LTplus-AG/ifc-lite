/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * `filter.proposal`: a named Rules filter (`FilterGroup[]`, the shape the
 * search Filter tab and saved filters carry). It runs over every loaded model;
 * nothing is selected, isolated or saved until the user asks.
 */

import type { FilterGroup } from '@ifc-lite/rules';
import { parseEnvelope, parseNativeArtifactScope, requiredText, type ArtifactEnvelope, type NativeArtifactScope } from './artifact-json';
import { parseProposalGroups } from './artifact-rules';

export interface FilterProposal extends ArtifactEnvelope {
  kind: 'filter.proposal';
  /** Saved-filter name. */
  name: string;
  groups: FilterGroup[];
  scope?: NativeArtifactScope;
}

export function parseFilterProposal(answer: string): FilterProposal {
  const { value, envelope } = parseEnvelope(answer, 'filter.proposal', ['name', 'groups', 'scope']);
  return { ...envelope, scope: parseNativeArtifactScope(value.scope), kind: 'filter.proposal', name: requiredText(value.name ?? value.title, 'The filter "name"'),
    groups: parseProposalGroups(value.groups, 'The filter') };
}
