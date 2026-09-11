/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * User-facing MODEL tags (issue #4215): free-form labels a coordinator puts on
 * the models of a federation ("Building A", "Structure", "Tender") so the same
 * set of models can be picked out again in the hierarchy, the advanced filter,
 * clash set filters and list scope.
 *
 * Not to be confused with:
 *  - the IFC `Tag` attribute on an element (`IfcElement.Tag`, and
 *    `ClashElement.tag` which is the element's IFC class) — these labels never
 *    touch IFC data and manufacture no property set;
 *  - the plugin API's `SourceTag`, which is cloud-source PROVENANCE
 *    (provider / project / file / revision), written by the loader and never
 *    by the user.
 *
 * Identity is the `id`, never the name: a saved rule stores tag ids, so
 * renaming a tag changes what the chip says and nothing about what matches.
 * Assignments are keyed by the runtime model id in the store and by the
 * model's content fingerprint in the portable federation setup file.
 */

export interface ModelTag {
  /** Stable identity (UUID). Saved rules and setup files reference this. */
  id: string;
  /** Display name. Unique per federation, compared case-insensitively. */
  name: string;
  /** Optional CSS colour for the chip. */
  color?: string;
}

/**
 * The four membership predicates every consumer (search, clash, lists) reads
 * the same way:
 *  - `hasAny`  — the model carries at least one of `tagIds`
 *  - `hasAll`  — the model carries every one of `tagIds`
 *  - `hasNone` — the model carries none of `tagIds`
 *  - `untagged` — the model carries no tag at all (`tagIds` is ignored)
 */
export type ModelTagOp = 'hasAny' | 'hasAll' | 'hasNone' | 'untagged';

export const MODEL_TAG_OPS: readonly ModelTagOp[] = ['hasAny', 'hasAll', 'hasNone', 'untagged'];

export function isModelTagOp(value: unknown): value is ModelTagOp {
  return typeof value === 'string' && (MODEL_TAG_OPS as readonly string[]).includes(value);
}

/** The name key two tags are compared by: trimmed, case-folded. */
export function normalizeModelTagName(name: string): string {
  return name.trim().toLocaleLowerCase();
}

/**
 * Does a model carrying `memberTagIds` satisfy `op` over `ruleTagIds`?
 *
 * `definedTagIds` is the set of tags that currently EXIST. A rule naming a tag
 * that no longer exists is UNRESOLVED and matches nothing, whatever the op:
 * `hasNone [deleted]` would otherwise be true of every model — the silent
 * broadening the issue forbids — and `hasAny [deleted]` false of every model,
 * which happens to be the same answer but for the wrong reason. Callers
 * surface the unresolved ids through {@link unresolvedModelTagIds} rather than
 * inferring them from an empty result.
 *
 * `untagged` names no tag and so can never be unresolved.
 */
export function modelTagRuleMatches(
  op: ModelTagOp,
  ruleTagIds: readonly string[],
  memberTagIds: ReadonlySet<string> | undefined,
  definedTagIds: ReadonlySet<string>,
): boolean {
  const members = memberTagIds ?? EMPTY;
  if (op === 'untagged') return members.size === 0;
  if (ruleTagIds.length === 0) return false;
  for (const id of ruleTagIds) if (!definedTagIds.has(id)) return false;
  switch (op) {
    case 'hasAny': return ruleTagIds.some((id) => members.has(id));
    case 'hasAll': return ruleTagIds.every((id) => members.has(id));
    case 'hasNone': return !ruleTagIds.some((id) => members.has(id));
  }
}

/** The tag ids `rule` names that are not in `definedTagIds`, in rule order, deduped. */
export function unresolvedModelTagIds(
  rule: { op: ModelTagOp; tagIds: readonly string[] },
  definedTagIds: ReadonlySet<string>,
): string[] {
  if (rule.op === 'untagged') return [];
  const out: string[] = [];
  for (const id of rule.tagIds) {
    if (!definedTagIds.has(id) && !out.includes(id)) out.push(id);
  }
  return out;
}

const EMPTY: ReadonlySet<string> = new Set();
