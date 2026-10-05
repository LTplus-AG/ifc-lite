/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * `rules.proposal` (viewer AI P07, #6915): native information-validation
 * rules (`.rules.json` `RuleSetFile`) proposed for review. The rule set is
 * read by the native `parseRuleSetFile`; anything that parser would ignore
 * (an unknown nested field) is refused here instead, so the reviewed rules
 * are exactly what the native engine runs.
 */

import { parseRuleSetFile, type RuleSetFile } from '@ifc-lite/rules';
import { isRecord, onlyKeys, optionalText, parseProposalEnvelope, parseUnsupported, requiredText, TEXT_LIMIT, unsupportedNote, type UnsupportedRequirement } from './proposal-json';

export const RULE_LIMIT = 100;

export interface RulesProposal {
  title: string;
  rationale?: string;
  ruleSet: RuleSetFile;
  unsupported: UnsupportedRequirement[];
}

/** JSON paths present in `input` but absent from what the native parser kept. */
function droppedPaths(input: unknown, kept: unknown, path: string, out: string[]): void {
  if (Array.isArray(input) && Array.isArray(kept)) {
    input.forEach((item, index) => droppedPaths(item, kept[index], `${path}[${index}]`, out));
  } else if (isRecord(input) && isRecord(kept)) {
    for (const [key, value] of Object.entries(input)) {
      if (!(key in kept)) out.push(`${path}.${key}`);
      else droppedPaths(value, kept[key], `${path}.${key}`, out);
    }
  }
}

/** Native parse plus the strictness the proposal contract adds. */
export function nativeRuleSet(value: unknown): RuleSetFile {
  if (!isRecord(value)) throw new Error('"ruleSet" must be a native rule set {version: 1, name, rules: [...]}');
  if (value.targets !== undefined) throw new Error('ruleSet.targets is chosen in the native editor, not proposed; remove it');
  if (!Array.isArray(value.rules) || value.rules.length === 0) throw new Error('ruleSet.rules must list at least one rule');
  if (value.rules.length > RULE_LIMIT) throw new Error(`At most ${RULE_LIMIT} rules may be proposed at once`);
  const parsed = parseRuleSetFile(value);
  if (!parsed.ok) throw new Error(`Native rule set refused it: ${parsed.error}`);
  const dropped: string[] = [];
  droppedPaths(value, parsed.file, 'ruleSet', dropped);
  if (dropped.length) throw new Error(`Unsupported rule field(s) ${dropped.slice(0, 8).join(', ')}; the native engine would ignore them, so remove or correct them`);
  const ids = parsed.file.rules.map(rule => rule.id);
  if (new Set(ids).size !== ids.length) throw new Error('Rule ids must be distinct');
  const names = parsed.file.rules.map(rule => rule.name);
  if (new Set(names).size !== names.length) throw new Error('Rule names must be distinct');
  return parsed.file;
}

export function parseRulesProposal(answer: string): RulesProposal {
  const value = parseProposalEnvelope(answer, 'rules.proposal');
  onlyKeys(value, ['version', 'kind', 'title', 'rationale', 'ruleSet', 'unsupported'], 'The proposal');
  const title = requiredText(value, 'title', 'The proposal');
  const rationale = optionalText(value, 'rationale', 'The proposal', TEXT_LIMIT);
  return { title, ...(rationale ? { rationale } : {}), ruleSet: nativeRuleSet(value.ruleSet), unsupported: parseUnsupported(value.unsupported) };
}

/** The saved rule set: unsupported requirements are kept in its description (rules about them in their own). */
export function ruleSetForSave(proposal: RulesProposal): RuleSetFile {
  const note = unsupportedNote(proposal.unsupported);
  const rules = proposal.ruleSet.rules.map(rule => {
    const own = proposal.unsupported.filter(item => item.relatesTo === rule.name);
    return own.length ? { ...rule, description: [rule.description, unsupportedNote(own)].filter(Boolean).join('\n') } : rule;
  });
  const file: RuleSetFile = { ...proposal.ruleSet, rules,
    ...(note ? { description: [proposal.ruleSet.description, note].filter(Boolean).join('\n\n') } : {}) };
  // Round-trip through the native parser: what is saved is what reopens.
  return nativeRuleSet(JSON.parse(JSON.stringify(file)));
}
