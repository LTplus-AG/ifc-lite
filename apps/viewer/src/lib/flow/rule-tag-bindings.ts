/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { normalizeModelTagName, type ModelTag, type RuleBlock, type RuleSetFile } from '@ifc-lite/rules';

/** Visit the native AST locations that hold model tags. Subject names,
 * property values and model fingerprints are never candidates for remapping. */
function visitTagLists(file: RuleSetFile, visit: (ids: string[]) => void): void {
  const block = (value: RuleBlock) => {
    for (const group of value.groups) {
      for (const rule of group.rules) {
        if (rule.kind === 'modelTag') visit(rule.tagIds);
      }
    }
  };
  if (file.targets?.modelTagIds) visit(file.targets.modelTagIds);
  for (const rule of file.rules) {
    block(rule.applicability);
    const requirement = rule.requirement;
    switch (requirement.kind) {
      case 'element': block(requirement.block); break;
      case 'aggregate':
        if (requirement.groupBy?.universe) block(requirement.groupBy.universe);
        break;
      case 'unique': case 'compare': case 'unit': break;
      default: {
        const unknown: never = requirement;
        throw new Error(`Unsupported requirement: ${String(unknown)}`);
      }
    }
  }
}

/** Unique native tag references, preserving source appearance order. */
export function collectRuleTagIds(file: RuleSetFile): string[] {
  const ids = new Set<string>();
  visitTagLists(file, (list) => { for (const id of list) ids.add(id); });
  return [...ids];
}

/** Resolve imported tag identities by explicitly supplied names. Defined local
 * IDs remain valid without a mapping. Unknown references fail closed, including
 * negative tag predicates that would otherwise silently broaden applicability. */
export function remapRuleTags(
  ruleSet: RuleSetFile,
  bindings: Readonly<Record<string, string>>,
  vocabulary: ReadonlyMap<string, ModelTag>,
): RuleSetFile {
  const replacements = new Map<string, string>();
  for (const oldId of collectRuleTagIds(ruleSet)) {
    if (!Object.hasOwn(bindings, oldId)) {
      if (!vocabulary.has(oldId)) throw new Error(`Model tag "${oldId}" requires a name mapping`);
      replacements.set(oldId, oldId);
      continue;
    }
    const name = bindings[oldId];
    const normalized = normalizeModelTagName(name);
    const matches = [...vocabulary].filter(([, tag]) => normalizeModelTagName(tag.name) === normalized);
    if (!normalized || matches.length === 0) throw new Error(`Mapped model tag "${name}" does not exist`);
    if (matches.length > 1) throw new Error(`Mapped model tag "${name}" is ambiguous`);
    replacements.set(oldId, matches[0][0]);
  }
  const cloned = structuredClone(ruleSet);
  visitTagLists(cloned, (ids) => {
    for (let index = 0; index < ids.length; index++) {
      const mapped = replacements.get(ids[index]);
      if (mapped === undefined) throw new Error(`Model tag "${ids[index]}" requires a name mapping`);
      ids[index] = mapped;
    }
  });
  return cloned;
}
