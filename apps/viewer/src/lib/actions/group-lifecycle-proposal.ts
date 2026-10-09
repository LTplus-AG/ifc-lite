/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import { isValidIfcGuid } from '@ifc-lite/encoding';
import type { GroupInStoreParams, GroupInStorePatch, GroupRootIdentity, GroupNativeEvidence } from '@ifc-lite/create';
import { isRecord, onlyKeys, requiredText } from '@/lib/check-authoring/proposal-json';

export const GROUP_OPS = ['group.create', 'group.update', 'group.remove'] as const;
export type GroupOperation = { op: 'group.create'; params: GroupInStoreParams }
  | { op: 'group.update'; target: GroupRootIdentity; params: GroupInStorePatch }
  | { op: 'group.remove'; target: GroupRootIdentity };
export interface GroupProposal {
  version: 1; kind: 'group.lifecycle'; title: string; modelId: string;
  expected: GroupNativeEvidence; operations: GroupOperation[];
}
function identity(value: unknown): GroupRootIdentity {
  if (!isRecord(value)) throw new Error('Group requires a captured native Root identity');
  onlyKeys(value, ['expressId', 'GlobalId'], 'Group identity');
  if (typeof value.expressId !== 'number' || !Number.isSafeInteger(value.expressId) || value.expressId < 1
    || typeof value.GlobalId !== 'string' || !isValidIfcGuid(value.GlobalId)) throw new Error('Group identity must pin current expressId and GlobalId');
  return { expressId: value.expressId, GlobalId: value.GlobalId };
}
function params(value: unknown, creating: boolean): GroupInStorePatch {
  if (!isRecord(value)) throw new Error('Group requires explicit complete parameters');
  onlyKeys(value, creating ? ['Name', 'Description', 'ObjectType', 'GlobalId', 'RelatedObjects'] : ['Name', 'Description', 'ObjectType', 'RelatedObjects'], 'Group params');
  if (!Array.isArray(value.RelatedObjects) || value.RelatedObjects.length > 100) throw new Error('Group review requires a complete list of at most 100 captured members');
  const parsed: GroupInStorePatch = { RelatedObjects: value.RelatedObjects.map(identity) };
  for (const key of ['Name', 'Description', 'ObjectType'] as const) {
    const text = value[key];
    if (text !== undefined) {
      if (text !== null && (typeof text !== 'string' || text.length > 2000 || Array.from(text).some(char => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127))) throw new Error(`Group ${key} requires bounded text or null`);
      parsed[key] = text;
    }
  }
  if (creating && (typeof parsed.Name !== 'string' || !parsed.Name.length)) throw new Error('New group requires an explicit Name');
  return parsed;
}
function boundedJson(value: unknown): void {
  const pending = [{ value, depth: 0 }]; let work = 0;
  while (pending.length) {
    const item = pending.pop()!;
    if (++work > 12000 || item.depth > 20) throw new Error('Complete Group evidence exceeds the review budget');
    const children = Array.isArray(item.value) ? item.value : isRecord(item.value) ? Object.values(item.value) : null;
    if (children) { if (children.length > 1000) throw new Error('Group evidence population exceeds its budget'); for (const value of children) pending.push({ value, depth: item.depth + 1 }); }
    else if (typeof item.value === 'number' && !Number.isFinite(item.value)) throw new Error('Group evidence numbers must be finite');
    else if (item.value !== null && !['number', 'string', 'boolean'].includes(typeof item.value)) throw new Error('Supply complete native JSON evidence');
  }
}
export function declaresGroupLifecycle(content: string): boolean { return /"kind"\s*:\s*"group\.lifecycle"/.test(content); }
export function parseGroupProposal(content: string): GroupProposal {
  if (content.length > 100_000) throw new Error('Group proposal exceeds its transport budget');
  const fenced = /^```(?:json)?\s*\n([\s\S]*?)\n```$/.exec(content.trim());
  const value: unknown = JSON.parse(fenced ? fenced[1] : content);
  if (!isRecord(value) || value.version !== 1 || value.kind !== 'group.lifecycle') throw new Error('Expected version 1 Group lifecycle');
  onlyKeys(value, ['version', 'kind', 'title', 'modelId', 'expected', 'operations'], 'Group proposal');
  if (!isRecord(value.expected)) throw new Error('Attach the complete current native Group evidence');
  boundedJson(value.expected);
  if (!Array.isArray(value.operations) || !value.operations.length || value.operations.length > 20) throw new Error('Supply 1–20 explicit Group operations');
  const targets = new Set<number>();
  const operations = value.operations.map((row): GroupOperation => {
    if (!isRecord(row)) throw new Error('Invalid Group operation');
    if (row.op === 'group.create') {
      onlyKeys(row, ['op', 'params'], 'Group create');
      const parsed = params(row.params, true);
      const raw = row.params as Record<string, unknown>;
      const GlobalId = raw.GlobalId;
      if (GlobalId !== undefined && (typeof GlobalId !== 'string' || !isValidIfcGuid(GlobalId))) throw new Error('New Group GlobalId is invalid');
      if (typeof parsed.Name !== 'string') throw new Error('New group requires Name');
      return { op: row.op, params: { ...parsed, Name: parsed.Name, ...(typeof GlobalId === 'string' ? { GlobalId } : {}) } };
    }
    if (row.op !== 'group.update' && row.op !== 'group.remove') throw new Error('Unsupported Group lifecycle operation');
    onlyKeys(row, row.op === 'group.update' ? ['op', 'target', 'params'] : ['op', 'target'], 'Group lifecycle');
    const target = identity(row.target);
    if (targets.has(target.expressId)) throw new Error('Supply one complete lifecycle change per current group');
    targets.add(target.expressId);
    return row.op === 'group.update' ? { op: row.op, target, params: params(row.params, false) } : { op: row.op, target };
  });
  return { version: 1, kind: 'group.lifecycle', title: requiredText(value, 'title', 'Group proposal'), modelId: requiredText(value, 'modelId', 'Group proposal'), expected: value.expected as unknown as GroupNativeEvidence, operations };
}
export const GROUP_LIFECYCLE_GUIDANCE = `Exact generic IfcGroup lifecycle uses kind:"group.lifecycle", version:1, title, modelId, expected equal to the complete available nativeGroup.snapshot (or JSON parsed from the matching summary.nativeGroups entry's expectedJsonParts.join('')), and operations group.create/group.update/group.remove. RelatedObjects is the entire intended membership, including an explicit [] to clear it, with captured {expressId,GlobalId} identities. Create requires Name; update/remove require the captured exact IfcGroup target. Preserve all unrelated memberships and members. Protected dependencies, unavailable or truncated evidence require asking for a fresh attachment. Specialized Structural groups are outside this generic lifecycle. Output a proposal for explicit native review; never raw STEP patches or an automatic edit.`;
