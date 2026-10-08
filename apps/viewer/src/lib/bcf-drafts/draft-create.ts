/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/** Draft batches from reviewed clash groups or selected findings (#6896). */

import type { BCFPoint } from '@ifc-lite/bcf';
import { clashReviewKey, type Clash, type ClashGroup, type ClashResult, type ClashSeverity } from '@ifc-lite/clash';
import { createBCFFromClashResult } from '@ifc-lite/clash/bcf';
import { manualClashOccurrenceKey, type ResolvedManualClashGroup } from '../clash/manual-groups.js';
import { decodeViewpoint } from './draft-codec.js';
import { digestStrings } from './draft-footer.js';
import type { DraftBatch, DraftFinding, DraftOrigin, DraftSource, DraftTopic } from './draft-types.js';

/** The run a draft is made from. Viewpoints are framed in the render frame and moved by `worldOffset`. */
export interface DraftRun {
  clashes: readonly Clash[];
  rules: readonly string[];
  worldOffset?: BCFPoint;
  now?: () => Date;
}

const SEVERITY_RANK: Record<ClashSeverity, number> = { critical: 0, major: 1, minor: 2, info: 3 };
/** Same severity -> priority table as the clash BCF export; preflight checks it against the server. */
const SEVERITY_PRIORITY: Record<ClashSeverity, string> = { critical: 'High', major: 'Normal', minor: 'Low', info: 'Low' };

export function findingFromClash(clash: Clash): DraftFinding {
  const element = (ref: Clash['a']) => ({ key: ref.key, model: ref.model, tag: ref.tag, ...(ref.name ? { name: ref.name } : {}) });
  return {
    reviewKey: clashReviewKey(clash), occurrenceKey: manualClashOccurrenceKey(clash), rule: clash.rule, status: clash.status,
    severity: clash.severity, distance: clash.distance, a: element(clash.a), b: element(clash.b),
    bounds: { min: [...clash.bounds.min], max: [...clash.bounds.max] },
  };
}

/** Identity of a whole run: every finding and the rules that produced it, order-independent. */
export function runDigest(clashes: readonly Clash[], rules: readonly string[]): string {
  return digestStrings([...clashes.map(clash => `f:${manualClashOccurrenceKey(clash)}`), ...rules.map(rule => `r:${rule}`)]);
}

export function draftSource(run: DraftRun): DraftSource {
  return { kind: 'clash', runDigest: runDigest(run.clashes, run.rules), rules: [...run.rules], findingCount: run.clashes.length,
    capturedAt: (run.now?.() ?? new Date()).toISOString(), ...(run.worldOffset ? { worldOffset: { ...run.worldOffset } } : {}) };
}

function worstSeverity(members: readonly DraftFinding[]): ClashSeverity {
  return members.reduce<ClashSeverity>((worst, member) =>
    SEVERITY_RANK[member.severity] < SEVERITY_RANK[worst] ? member.severity : worst, 'info');
}

function asClash(finding: DraftFinding): Clash | null {
  if (!finding.bounds) return null;
  const ref = (element: DraftFinding['a']) => ({ key: element.key, ref: 0, model: element.model, tag: element.tag, name: element.name });
  const { min, max } = finding.bounds;
  return { id: finding.occurrenceKey || finding.reviewKey, a: ref(finding.a), b: ref(finding.b), rule: finding.rule,
    status: finding.status as Clash['status'], distance: finding.distance, severity: finding.severity, bounds: { min, max },
    point: [(min[0] + max[0]) / 2, (min[1] + max[1]) / 2, (min[2] + max[2]) / 2] };
}

/**
 * Frame the members through the clash BCF bridge (the same camera, selection
 * and A/B colouring as the clash export) and keep only its viewpoint. Members
 * without stored bounds (a plain archive import) cannot be framed; the topic
 * then keeps no viewpoint rather than a fabricated one.
 */
export async function frameDraftMembers(members: readonly DraftFinding[], worldOffset?: BCFPoint) {
  const clashes = members.map(asClash);
  if (clashes.length === 0 || clashes.some(clash => !clash)) return undefined;
  const framed = clashes.flatMap(clash => clash ? [clash] : []);
  const min: [number, number, number] = [Infinity, Infinity, Infinity], max: [number, number, number] = [-Infinity, -Infinity, -Infinity];
  for (const clash of framed) for (let axis = 0; axis < 3; axis++) {
    min[axis] = Math.min(min[axis], clash.bounds.min[axis]);
    max[axis] = Math.max(max[axis], clash.bounds.max[axis]);
  }
  const group: ClashGroup = { id: 'draft', title: 'draft', members: framed, bounds: { min, max },
    representativePoint: [(min[0] + max[0]) / 2, (min[1] + max[1]) / 2, (min[2] + max[2]) / 2], severity: worstSeverity(members) };
  const result: ClashResult = { clashes: framed, rulesRun: [], settings: { tolerance: 0, excludeVoidsAndHosts: true },
    summary: { total: framed.length, byRule: {}, byTypePair: {}, bySeverity: { critical: 0, major: 0, minor: 0, info: 0 } } };
  const project = await createBCFFromClashResult(result, [group], { author: 'draft', ...(worldOffset ? { worldOffset } : {}) });
  const viewpoint = [...project.topics.values()][0]?.viewpoints[0];
  // Store the portable form only, so a reload decodes to exactly what was framed.
  return viewpoint ? decodeViewpoint(JSON.parse(JSON.stringify(viewpoint))) ?? undefined : undefined;
}

export function memberSummary(members: readonly DraftFinding[]): string {
  const pairs = new Map<string, number>();
  for (const member of members) {
    const pair = [member.a.tag, member.b.tag].sort().join(' × ');
    pairs.set(pair, (pairs.get(pair) ?? 0) + 1);
  }
  const lines = [`${members.length} clash finding${members.length === 1 ? '' : 's'}; worst severity ${worstSeverity(members)}.`];
  for (const [pair, count] of [...pairs].sort((left, right) => right[1] - left[1]).slice(0, 10)) lines.push(`- ${pair}: ${count}`);
  return lines.join('\n');
}

export async function draftTopic(title: string, members: DraftFinding[], origin: DraftOrigin, worldOffset?: BCFPoint): Promise<DraftTopic> {
  const viewpoint = await frameDraftMembers(members, worldOffset);
  return { guid: crypto.randomUUID(), title: title.trim().slice(0, 200) || 'Clash topic', description: memberSummary(members),
    topicType: 'Clash', topicStatus: 'Open', priority: SEVERITY_PRIORITY[worstSeverity(members)], labels: [], origin, members,
    ...(viewpoint ? { viewpoint } : {}), comments: [] };
}

function batch(name: string, run: DraftRun, topics: DraftTopic[]): DraftBatch {
  const at = (run.now?.() ?? new Date()).toISOString();
  return { version: 1, id: crypto.randomUUID(), name: name.trim().slice(0, 200) || 'BCF drafts', createdAt: at, modifiedAt: at,
    source: draftSource(run), topics };
}

/** One topic per reviewed group; members are the group's findings resolved in this run. */
export async function draftBatchFromGroups(name: string, workspaceId: string, groups: readonly ResolvedManualClashGroup[],
  run: DraftRun): Promise<DraftBatch> {
  const topics: DraftTopic[] = [];
  for (const group of groups) {
    if (group.members.length === 0) continue;
    topics.push(await draftTopic(group.definition.name, group.members.map(findingFromClash),
      { kind: 'group', workspaceId, groupId: group.definition.id }, run.worldOffset));
  }
  return batch(name, run, topics);
}

/** One topic holding exactly the selected findings. */
export async function draftBatchFromSelection(name: string, title: string, selected: readonly Clash[], run: DraftRun): Promise<DraftBatch> {
  const topic = await draftTopic(title, selected.map(findingFromClash), { kind: 'selection' }, run.worldOffset);
  return batch(name, run, selected.length ? [topic] : []);
}
