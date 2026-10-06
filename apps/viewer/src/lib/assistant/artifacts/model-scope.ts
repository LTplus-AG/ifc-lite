/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * "This model" in an artifact proposal: a native Rules `model` rule. The
 * answer names loaded models as the schema digest lists them; the native rule
 * matches a model's durable source fingerprint (so a saved filter survives the
 * fresh runtime ids minted on reload, and the Filter editor shows it as a model
 * chip). Every name is resolved here, before any engine runs. A name that is not
 * exactly one loaded model is refused with the loaded names, never left to
 * match nothing (`in`) or everything (`notIn`).
 */

import type { FilterGroup, FilterRule } from '@ifc-lite/rules';
import type { FederatedModel } from '@/store';
import type { ArtifactProposal } from './proposal-kinds';

/** Apply `map` to every Rules group list a proposal carries: filter, list scope, each lens rule, chart source filter. */
export function mapProposalGroups(proposal: ArtifactProposal, map: (groups: FilterGroup[]) => FilterGroup[]): ArtifactProposal {
  switch (proposal.kind) {
    case 'filter.proposal': return { ...proposal, groups: map(proposal.groups) };
    case 'list.proposal': return { ...proposal, list: { ...proposal.list, groups: map(proposal.list.groups) } };
    case 'lens.proposal': return { ...proposal, lens: { ...proposal.lens, rules: proposal.lens.rules.map((rule) => ({ ...rule, groups: map(rule.groups) })) } };
    case 'chart.proposal': return proposal.chart.filter ? { ...proposal, chart: { ...proposal.chart, filter: { groups: map(proposal.chart.filter.groups) } } } : proposal;
  }
}

type NamedModel = Pick<FederatedModel, 'name' | 'sourceFingerprint'>;

/** `proposal` with every `model` rule naming fingerprints instead of model names. Throws a reason when a name is not one loaded model. */
export function resolveModelNames(proposal: ArtifactProposal, models: ReadonlyMap<string, NamedModel>): ArtifactProposal {
  const loaded = [...models.values()];
  const fingerprint = (name: string): string => {
    const named = loaded.filter((model) => model.name === name);
    if (named.length === 0) throw new Error(`"${name}" is not a loaded model; loaded: ${loaded.map((model) => model.name).join(', ')}`);
    if (named.length > 1) throw new Error(`"${name}" names ${named.length} loaded models; narrow the filter in the Filter tab's model chips instead`);
    if (!named[0].sourceFingerprint) throw new Error(`"${name}" has no durable identity to filter by; filter every loaded model instead`);
    return named[0].sourceFingerprint;
  };
  const rule = (each: FilterRule): FilterRule => each.kind === 'model' ? { ...each, values: each.values.map(fingerprint) } : each;
  return mapProposalGroups(proposal, (groups) => groups.map((group) => ({ ...group, rules: group.rules.map(rule) })));
}
