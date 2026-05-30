/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Clash <-> BCF bridge.
 *
 * Turns grouped clash results into a BCF 2.1 project (one topic per clash
 * group, with a framing viewpoint, selection and coloring) and reads such a
 * project back into a map of clash-id -> { topicGuid, status } for status
 * round-tripping. Topic GUIDs are a deterministic function of the group id, so
 * topic identity is stable across re-exports (timestamps and viewpoint guids
 * come from @ifc-lite/bcf and are not deterministic, so the archive bytes are
 * not identical — but the clash<->topic anchoring is).
 *
 * Transparency is a first-class concern: when the group count exceeds the cap,
 * we never silently drop the overflow. We emit the top topics and one extra
 * marker topic that records exactly how many groups were not exported.
 */

import {
  createBCFProject,
  createBCFTopic,
  createViewpoint,
  addViewpointToTopic,
  addTopicToProject,
  toARGBColor,
  type BCFProject,
  type BCFTopic,
  type ViewerCameraState,
  type ViewerBounds,
} from '@ifc-lite/bcf';
import type { AABB, Clash, ClashGroup, ClashResult, ClashSeverity, Vec3 } from './types.js';
import { uuidFromSeed } from './deterministic-uuid.js';

export interface ClashBcfOptions {
  author: string;
  status?: string;
  projectName?: string;
  maxTopics?: number;
  maxMembersPerTopic?: number;
  cameraDistanceFactor?: number;
  snapshotProvider?: (group: ClashGroup) => Promise<Uint8Array | undefined>;
}

const DEFAULT_MAX_TOPICS = 1000;
const DEFAULT_MAX_MEMBERS = 50;
const DEFAULT_CAMERA_DISTANCE_FACTOR = 2.5;
/** Minimum eye-to-target standoff (m) so the camera is never coincident with the target. */
const STANDOFF_FLOOR = 1e-3;
const CLASH_IDS_PREFIX = 'clash-ids: ';

const SEVERITY_RANK: Record<ClashSeverity, number> = {
  critical: 0,
  major: 1,
  minor: 2,
  info: 3,
};

const SEVERITY_PRIORITY: Record<ClashSeverity, string> = {
  critical: 'High',
  major: 'Normal',
  minor: 'Low',
  info: 'Low',
};

/** Deterministic sort: severity (critical first), then member count desc, then id. */
function sortGroups(groups: ClashGroup[]): ClashGroup[] {
  return [...groups].sort((a, b) => {
    const sevDiff = SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity];
    if (sevDiff !== 0) return sevDiff;
    const countDiff = b.members.length - a.members.length;
    if (countDiff !== 0) return countDiff;
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  });
}

/** Unique, insertion-ordered list of values. */
function unique(values: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const v of values) {
    if (!seen.has(v)) {
      seen.add(v);
      out.push(v);
    }
  }
  return out;
}

function midpoint(b: AABB): Vec3 {
  return [
    (b.min[0] + b.max[0]) / 2,
    (b.min[1] + b.max[1]) / 2,
    (b.min[2] + b.max[2]) / 2,
  ];
}

function diagonalLength(b: AABB): number {
  const dx = b.max[0] - b.min[0];
  const dy = b.max[1] - b.min[1];
  const dz = b.max[2] - b.min[2];
  return Math.sqrt(dx * dx + dy * dy + dz * dz);
}

function toViewerBounds(b: AABB): ViewerBounds {
  return {
    min: { x: b.min[0], y: b.min[1], z: b.min[2] },
    max: { x: b.max[0], y: b.max[1], z: b.max[2] },
  };
}

/** Frame `bounds` from a fixed oblique direction so the group is fully in view. */
function cameraForBounds(bounds: AABB, distanceFactor: number): ViewerCameraState {
  const centerPt = midpoint(bounds);
  const radius = 0.5 * diagonalLength(bounds);

  // normalize([1, 0.7, 1])
  const dirLen = Math.sqrt(1 * 1 + 0.7 * 0.7 + 1 * 1);
  const dir: Vec3 = [1 / dirLen, 0.7 / dirLen, 1 / dirLen];

  // Degenerate bounds (single point) -> use a fixed standoff so the camera is
  // never coincident with the target.
  const standoff = Math.max(radius > 0 ? radius * distanceFactor : distanceFactor, STANDOFF_FLOOR);

  const position: Vec3 = [
    centerPt[0] + dir[0] * standoff,
    centerPt[1] + dir[1] * standoff,
    centerPt[2] + dir[2] * standoff,
  ];

  return {
    position: { x: position[0], y: position[1], z: position[2] },
    target: { x: centerPt[0], y: centerPt[1], z: centerPt[2] },
    up: { x: 0, y: 1, z: 0 },
    fov: 0.9,
  };
}

/** Count members by a string-valued key. */
function tally(members: Clash[], pick: (c: Clash) => string): Record<string, number> {
  const out: Record<string, number> = {};
  for (const m of members) {
    const k = pick(m);
    out[k] = (out[k] ?? 0) + 1;
  }
  return out;
}

function formatCounts(counts: Record<string, number>): string {
  const keys = Object.keys(counts).sort();
  return keys.map((k) => `${k}: ${counts[k]}`).join(', ');
}

/** A readable, human-facing summary plus the machine-readable clash-ids line. */
function buildDescription(group: ClashGroup, maxMembers: number): string {
  const lines: string[] = [];
  lines.push(`Clash group "${group.title}" with ${group.members.length} member(s).`);
  if (group.discipline) lines.push(`Discipline: ${group.discipline}`);
  if (group.storey) lines.push(`Storey: ${group.storey}`);
  lines.push(`Severity: ${group.severity}`);

  lines.push(`By status: ${formatCounts(tally(group.members, (c) => c.status))}`);
  lines.push(`By severity: ${formatCounts(tally(group.members, (c) => c.severity))}`);

  const typePairs = tally(group.members, (c) => {
    const ta = c.a.tag;
    const tb = c.b.tag;
    return ta < tb ? `${ta} x ${tb}` : `${tb} x ${ta}`;
  });
  lines.push(`Type pairs: ${formatCounts(typePairs)}`);

  lines.push('');
  lines.push('Members:');
  const shown = group.members.slice(0, maxMembers);
  for (const m of shown) {
    const nameA = m.a.name ? ` (${m.a.name})` : '';
    const nameB = m.b.name ? ` (${m.b.name})` : '';
    lines.push(
      `- [${m.rule}/${m.status}] ${m.a.tag}${nameA} ${m.a.key} <-> ${m.b.tag}${nameB} ${m.b.key} | gap ${m.distance.toFixed(4)}`,
    );
  }
  const remaining = group.members.length - shown.length;
  if (remaining > 0) {
    lines.push(`...and ${remaining} more`);
  }

  lines.push('');
  // Machine-readable, uncapped: every member id so the round-trip recovers all.
  // Ids are percent-encoded so commas inside a model name / rule id cannot break
  // the comma-delimited list (clash ids are otherwise free-form strings).
  lines.push(`${CLASH_IDS_PREFIX}${group.members.map((m) => encodeURIComponent(m.id)).join(',')}`);

  return lines.join('\n');
}

/** Build the topic + framing viewpoint for one group. */
async function buildTopicForGroup(
  project: BCFProject,
  group: ClashGroup,
  opts: ClashBcfOptions,
  maxMembers: number,
  cameraDistanceFactor: number,
): Promise<void> {
  const description = buildDescription(group, maxMembers);
  const priority = SEVERITY_PRIORITY[group.severity];
  const labels = [group.discipline, 'Clash'].filter((l): l is string => Boolean(l));

  const topic = createBCFTopic({
    title: group.title,
    description,
    author: opts.author,
    topicType: 'Clash',
    topicStatus: opts.status ?? 'Open',
    priority,
    labels,
  });
  // Deterministic guid: stable function of the group id (input-only).
  topic.guid = uuidFromSeed(group.id);

  const selectedGuids = unique(group.members.flatMap((m) => [m.a.key, m.b.key]));
  const coloredGuids = [
    { color: toARGBColor(255, 51, 51), guids: unique(group.members.map((m) => m.a.key)) },
    { color: toARGBColor(255, 165, 0), guids: unique(group.members.map((m) => m.b.key)) },
  ];

  const camera = cameraForBounds(group.bounds, cameraDistanceFactor);
  const bounds = toViewerBounds(group.bounds);
  const snapshotData = opts.snapshotProvider ? await opts.snapshotProvider(group) : undefined;

  const viewpoint = createViewpoint({
    camera,
    bounds,
    selectedGuids,
    coloredGuids,
    snapshotData,
  });

  addViewpointToTopic(topic, viewpoint);
  addTopicToProject(project, topic);
}

/**
 * Build a BCF 2.1 project from a clash result and its precomputed groups.
 *
 * Groups are sorted (critical first, then larger groups), capped at
 * `maxTopics`, and any overflow is recorded in one transparency topic.
 */
export async function createBCFFromClashResult(
  result: ClashResult,
  groups: ClashGroup[],
  opts: ClashBcfOptions,
): Promise<BCFProject> {
  // `result` carries run-level settings; reference it so the summary in the
  // overflow topic can quote the real total even when groups are partial.
  const totalClashes = result.summary.total;

  const project = createBCFProject({
    name: opts.projectName ?? 'Clash report',
    version: '2.1',
  });

  const maxTopics = opts.maxTopics ?? DEFAULT_MAX_TOPICS;
  const maxMembers = opts.maxMembersPerTopic ?? DEFAULT_MAX_MEMBERS;
  const cameraDistanceFactor = opts.cameraDistanceFactor ?? DEFAULT_CAMERA_DISTANCE_FACTOR;

  const sorted = sortGroups(groups);
  const exported = sorted.slice(0, maxTopics);
  const droppedCount = sorted.length - exported.length;

  for (const group of exported) {
    await buildTopicForGroup(project, group, opts, maxMembers, cameraDistanceFactor);
  }

  if (droppedCount > 0) {
    // Transparency: never silently drop. One marker topic records the overflow.
    const overflowTitle = `... ${droppedCount} more clash groups not exported`;
    const overflowDescription = [
      `${droppedCount} clash group(s) exceeded the maxTopics cap of ${maxTopics} and were not exported.`,
      `Total clash groups: ${sorted.length}. Exported: ${exported.length}.`,
      `Total clashes in result: ${totalClashes}.`,
      'Increase maxTopics to export the remaining groups.',
    ].join('\n');

    const overflowTopic = createBCFTopic({
      title: overflowTitle,
      description: overflowDescription,
      author: opts.author,
      topicType: 'Clash',
      topicStatus: opts.status ?? 'Open',
      priority: 'Low',
      labels: ['Clash'],
    });
    // Stable guid for the overflow marker too, keyed off the project name and
    // count so a re-run with the same overflow is idempotent.
    overflowTopic.guid = uuidFromSeed(
      `overflow:${opts.projectName ?? 'Clash report'}:${maxTopics}:${droppedCount}`,
    );
    addTopicToProject(project, overflowTopic);
  }

  return project;
}

/**
 * Read a BCF project back into a map of clash-id -> { topicGuid, status }.
 *
 * Parses the machine-readable `clash-ids:` line that `createBCFFromClashResult`
 * embeds in each topic description. Topics without that line (e.g. the overflow
 * marker, or unrelated topics) are skipped.
 */
export function mapBcfToClashes(
  project: BCFProject,
): Map<string, { topicGuid: string; status: string }> {
  const map = new Map<string, { topicGuid: string; status: string }>();

  for (const topic of project.topics.values()) {
    const ids = extractClashIds(topic);
    if (ids.length === 0) continue;
    const status = topic.topicStatus ?? 'Open';
    for (const id of ids) {
      map.set(id, { topicGuid: topic.guid, status });
    }
  }

  return map;
}

/** Pull the comma-separated ids out of a topic's `clash-ids:` line. */
function extractClashIds(topic: BCFTopic): string[] {
  const description = topic.description;
  if (!description) return [];
  for (const line of description.split('\n')) {
    const trimmed = line.trim();
    if (trimmed.startsWith(CLASH_IDS_PREFIX.trim())) {
      const payload = trimmed.slice(CLASH_IDS_PREFIX.trim().length).trim();
      if (payload.length === 0) return [];
      return payload
        .split(',')
        .map((s) => s.trim())
        .filter((s) => s.length > 0)
        .map((s) => decodeURIComponent(s));
    }
  }
  return [];
}
