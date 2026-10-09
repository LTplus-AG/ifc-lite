/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * `lens.proposal`: a Lens (`@ifc-lite/lens`) without the library identity:
 * either first-match rules (Rules groups, an action and a colour each) or an
 * auto-colour spec whose legend the engine builds from the data. Rule ids are
 * assigned here so the review can report each rule's matched count.
 */

import { ENTITY_ATTRIBUTE_NAMES, LENS_PALETTE, type AutoColorSpec, type Lens, type LensRule } from '@ifc-lite/lens';
import { onlyKeys, parseEnvelope, parseNativeArtifactScope, parseHexColor, record, requiredText, type ArtifactEnvelope } from './artifact-json';
import { parseProposalGroups } from './artifact-rules';

export type LensDraft = Pick<Lens, 'name' | 'rules' | 'autoColor'>;

export interface LensProposal extends ArtifactEnvelope {
  scope?: import('./artifact-json').NativeArtifactScope;
  kind: 'lens.proposal';
  lens: LensDraft;
}

export const LENS_RULE_LIMIT = 12;
const ACTIONS = ['colorize', 'transparent', 'hide'] as const;
const AUTO_SOURCES = ['ifcType', 'attribute', 'property', 'quantity', 'classification', 'material'] as const;

function parseRule(value: unknown, index: number): LensRule {
  const at = `Lens rule ${index + 1}`;
  if (!record(value)) throw new Error(`${at} is not an object`);
  onlyKeys(value, ['name', 'groups', 'action', 'color'], at);
  if (!ACTIONS.includes(value.action as typeof ACTIONS[number])) throw new Error(`${at} "action" must be one of ${ACTIONS.join(', ')}`);
  const action = value.action as LensRule['action'];
  const color = action === 'hide' && value.color === undefined ? LENS_PALETTE[index % LENS_PALETTE.length] : parseHexColor(value.color, `${at} "color"`);
  return { id: `rule-${index + 1}`, name: requiredText(value.name, `${at} "name"`), enabled: true,
    groups: parseProposalGroups(value.groups, at), action, color };
}

function parseAutoColor(value: unknown): AutoColorSpec {
  if (!record(value)) throw new Error('"autoColor" is not an object');
  onlyKeys(value, ['source', 'psetName', 'propertyName'], 'The autoColor');
  const source = value.source;
  if (!AUTO_SOURCES.includes(source as typeof AUTO_SOURCES[number])) throw new Error(`The autoColor "source" must be one of ${AUTO_SOURCES.join(', ')}`);
  if (source === 'property' || source === 'quantity') {
    return { source, psetName: requiredText(value.psetName, 'The autoColor "psetName"'), propertyName: requiredText(value.propertyName, 'The autoColor "propertyName"') };
  }
  if (source === 'attribute') {
    if (!ENTITY_ATTRIBUTE_NAMES.includes(value.propertyName as typeof ENTITY_ATTRIBUTE_NAMES[number])) throw new Error(`The autoColor attribute must be one of ${ENTITY_ATTRIBUTE_NAMES.join(', ')}`);
    return { source, propertyName: value.propertyName as string };
  }
  if (source === 'classification') {
    if (value.psetName !== undefined) requiredText(value.psetName, 'The autoColor classification system ("psetName")');
    return { source, ...(typeof value.psetName === 'string' ? { psetName: value.psetName } : {}), includeUnclassified: true };
  }
  if (value.psetName !== undefined || value.propertyName !== undefined) throw new Error(`The autoColor source ${String(source)} takes no psetName or propertyName`);
  return { source: source as 'ifcType' | 'material' };
}

export function parseLensProposal(answer: string): LensProposal {
  const { value, envelope } = parseEnvelope(answer, 'lens.proposal', ['lens', 'scope']);
  if (!record(value.lens)) throw new Error('A lens.proposal needs a "lens" object');
  const lens = value.lens;
  onlyKeys(lens, ['name', 'rules', 'autoColor'], 'The lens');
  const name = requiredText(lens.name, 'The lens "name"');
  if ((lens.rules === undefined) === (lens.autoColor === undefined)) throw new Error('A lens has either "rules" or "autoColor", not both and not neither');
  if (lens.autoColor !== undefined) return { ...envelope, scope: parseNativeArtifactScope(value.scope), kind: 'lens.proposal', lens: { name, rules: [], autoColor: parseAutoColor(lens.autoColor) } };
  if (!Array.isArray(lens.rules) || lens.rules.length === 0 || lens.rules.length > LENS_RULE_LIMIT) throw new Error(`A lens needs 1 to ${LENS_RULE_LIMIT} rules`);
  return { ...envelope, scope: parseNativeArtifactScope(value.scope), kind: 'lens.proposal', lens: { name, rules: lens.rules.map(parseRule) } };
}
