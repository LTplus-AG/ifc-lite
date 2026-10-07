/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/** Strict decoder for durable draft batches: invalid content is refused, never repaired silently. */

import type { BCFComponent, BCFPoint, BCFViewpoint } from '@ifc-lite/bcf';
import type { ClashSeverity } from '@ifc-lite/clash';
import {
  DRAFT_LIMITS, findingIdentity, type DraftBatch, type DraftComment, type DraftElement, type DraftFinding,
  type DraftOrigin, type DraftSource, type DraftTopic,
} from './draft-types.js';

type Raw = Record<string, unknown>;
const SEVERITIES: readonly ClashSeverity[] = ['critical', 'major', 'minor', 'info'];

export const isRecord = (value: unknown): value is Raw =>
  value !== null && typeof value === 'object' && !Array.isArray(value);
export const isText = (value: unknown, max: number, allowEmpty = false): value is string =>
  typeof value === 'string' && value.length <= max && (allowEmpty || value.trim().length > 0);
const finite = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value);
const optionalText = (value: unknown, max: number): value is string | undefined => value === undefined || isText(value, max);

function triple(value: unknown): [number, number, number] | null {
  return Array.isArray(value) && value.length === 3 && value.every(finite) ? [value[0], value[1], value[2]] : null;
}

function element(value: unknown): DraftElement | null {
  if (!isRecord(value) || !isText(value.key, 2_000) || !isText(value.model, 500) || !isText(value.tag, 200)
    || !optionalText(value.name, 500)) return null;
  return { key: value.key, model: value.model, tag: value.tag, ...(value.name !== undefined ? { name: value.name } : {}) };
}

export function decodeFinding(value: unknown): DraftFinding | null {
  if (!isRecord(value) || !isText(value.reviewKey, 10_000) || !isText(value.occurrenceKey, 10_000, true)
    || !isText(value.rule, 500) || !isText(value.status, 50) || !SEVERITIES.includes(value.severity as ClashSeverity)
    || !finite(value.distance)) return null;
  const a = element(value.a), b = element(value.b);
  if (!a || !b) return null;
  let bounds: DraftFinding['bounds'];
  if (value.bounds !== undefined) {
    const box = isRecord(value.bounds) ? { min: triple(value.bounds.min), max: triple(value.bounds.max) } : null;
    if (!box?.min || !box.max) return null;
    bounds = { min: box.min, max: box.max };
  }
  return { reviewKey: value.reviewKey, occurrenceKey: value.occurrenceKey, rule: value.rule, status: value.status,
    severity: value.severity as ClashSeverity, distance: value.distance, a, b, ...(bounds ? { bounds } : {}) };
}

function origin(value: unknown): DraftOrigin | null {
  if (!isRecord(value)) return null;
  if (value.kind === 'selection' || value.kind === 'archive') return { kind: value.kind };
  if (value.kind === 'group' && isText(value.workspaceId, 200) && isText(value.groupId, 200)) {
    return { kind: 'group', workspaceId: value.workspaceId, groupId: value.groupId };
  }
  if (value.kind === 'review' && isText(value.card, 100)) return { kind: 'review', card: value.card };
  return null;
}

function bcfPoint(value: unknown): BCFPoint | null {
  return isRecord(value) && finite(value.x) && finite(value.y) && finite(value.z) ? { x: value.x, y: value.y, z: value.z } : null;
}

function components(value: unknown): BCFComponent[] | null {
  if (!Array.isArray(value) || value.length > 20_000) return null;
  const out: BCFComponent[] = [];
  for (const item of value) {
    if (!isRecord(item) || !optionalText(item.ifcGuid, 200) || !optionalText(item.authoringToolId, 200)
      || !optionalText(item.originatingSystem, 200)) return null;
    out.push({ ...(item.ifcGuid ? { ifcGuid: item.ifcGuid } : {}), ...(item.authoringToolId ? { authoringToolId: item.authoringToolId } : {}),
      ...(item.originatingSystem ? { originatingSystem: item.originatingSystem } : {}) });
  }
  return out;
}

/** The portable subset of a BCF viewpoint a draft keeps: cameras, planes and components. */
export function decodeViewpoint(value: unknown): BCFViewpoint | null {
  if (!isRecord(value) || !isText(value.guid, 100)) return null;
  const viewpoint: BCFViewpoint = { guid: value.guid };
  for (const key of ['perspectiveCamera', 'orthogonalCamera'] as const) {
    const camera = value[key];
    if (camera === undefined) continue;
    if (!isRecord(camera)) return null;
    const viewPoint = bcfPoint(camera.cameraViewPoint), direction = bcfPoint(camera.cameraDirection), up = bcfPoint(camera.cameraUpVector);
    if (!viewPoint || !direction || !up) return null;
    if (key === 'perspectiveCamera') {
      if (!finite(camera.fieldOfView)) return null;
      viewpoint.perspectiveCamera = { cameraViewPoint: viewPoint, cameraDirection: direction, cameraUpVector: up, fieldOfView: camera.fieldOfView,
        ...(finite(camera.aspectRatio) ? { aspectRatio: camera.aspectRatio } : {}) };
    } else {
      if (!finite(camera.viewToWorldScale)) return null;
      viewpoint.orthogonalCamera = { cameraViewPoint: viewPoint, cameraDirection: direction, cameraUpVector: up, viewToWorldScale: camera.viewToWorldScale,
        ...(finite(camera.aspectRatio) ? { aspectRatio: camera.aspectRatio } : {}) };
    }
  }
  if (value.clippingPlanes !== undefined) {
    if (!Array.isArray(value.clippingPlanes)) return null;
    const planes = value.clippingPlanes.map(plane => isRecord(plane) ? { location: bcfPoint(plane.location), direction: bcfPoint(plane.direction) } : null);
    if (planes.some(plane => !plane?.location || !plane.direction)) return null;
    viewpoint.clippingPlanes = planes.flatMap(plane => plane?.location && plane.direction ? [{ location: plane.location, direction: plane.direction }] : []);
  }
  if (value.components !== undefined) {
    const raw = value.components;
    if (!isRecord(raw)) return null;
    const selection = raw.selection === undefined ? undefined : components(raw.selection);
    if (selection === null) return null;
    const coloring = raw.coloring === undefined ? undefined : Array.isArray(raw.coloring) ? raw.coloring.map(entry =>
      isRecord(entry) && isText(entry.color, 9) ? { color: entry.color, components: components(entry.components) } : null) : null;
    if (coloring === null || coloring?.some(entry => !entry?.components)) return null;
    let visibility: NonNullable<BCFViewpoint['components']>['visibility'];
    if (raw.visibility !== undefined) {
      if (!isRecord(raw.visibility) || typeof raw.visibility.defaultVisibility !== 'boolean') return null;
      const exceptions = raw.visibility.exceptions === undefined ? undefined : components(raw.visibility.exceptions);
      if (exceptions === null) return null;
      visibility = { defaultVisibility: raw.visibility.defaultVisibility, ...(exceptions ? { exceptions } : {}) };
    }
    viewpoint.components = {
      ...(selection ? { selection } : {}),
      ...(coloring ? { coloring: coloring.flatMap(entry => entry?.components ? [{ color: entry.color, components: entry.components }] : []) } : {}),
      ...(visibility ? { visibility } : {}),
    };
  }
  return viewpoint;
}

function comment(value: unknown): DraftComment | null {
  return isRecord(value) && isText(value.id, 100) && isText(value.text, DRAFT_LIMITS.comment) ? { id: value.id, text: value.text } : null;
}

export function decodeTopic(value: unknown): DraftTopic | null {
  if (!isRecord(value) || !isText(value.guid, 100) || !isText(value.title, DRAFT_LIMITS.title)
    || !isText(value.description, DRAFT_LIMITS.description, true) || !isText(value.topicType, 100) || !isText(value.topicStatus, 100)
    || !optionalText(value.priority, 100) || !optionalText(value.assignedTo, 500) || !Array.isArray(value.labels)
    || value.labels.length > DRAFT_LIMITS.labels || !value.labels.every(label => isText(label, 100))
    || !Array.isArray(value.members) || value.members.length > DRAFT_LIMITS.members
    || !Array.isArray(value.comments) || value.comments.length > 100) return null;
  const source = origin(value.origin);
  const members = value.members.map(decodeFinding);
  const comments = value.comments.map(comment);
  const viewpoint = value.viewpoint === undefined ? undefined : decodeViewpoint(value.viewpoint);
  if (!source || viewpoint === null || members.some(member => !member) || comments.some(item => !item)) return null;
  return { guid: value.guid, title: value.title, description: value.description, topicType: value.topicType,
    topicStatus: value.topicStatus, ...(value.priority !== undefined ? { priority: value.priority } : {}), labels: [...value.labels as string[]],
    ...(value.assignedTo !== undefined ? { assignedTo: value.assignedTo } : {}), origin: source,
    members: members.flatMap(member => member ? [member] : []), ...(viewpoint ? { viewpoint } : {}),
    comments: comments.flatMap(item => item ? [item] : []) };
}

function decodeSource(value: unknown): DraftSource | null {
  if (!isRecord(value) || (value.kind !== 'clash' && value.kind !== 'archive' && value.kind !== 'review') || !isText(value.runDigest, 100)
    || !Array.isArray(value.rules) || !value.rules.every(rule => isText(rule, 500)) || !Number.isSafeInteger(value.findingCount)
    || !isText(value.capturedAt, 40)) return null;
  const offset = value.worldOffset === undefined ? undefined : bcfPoint(value.worldOffset);
  if (offset === null) return null;
  return { kind: value.kind, runDigest: value.runDigest, rules: [...value.rules as string[]], findingCount: value.findingCount as number,
    capturedAt: value.capturedAt, ...(offset ? { worldOffset: offset } : {}) };
}

/**
 * A batch is a partition: no finding is claimed by two topics and topic GUIDs
 * are unique. Anything else is refused so an edit can never silently
 * duplicate or drop a finding.
 */
export function decodeDraftBatch(value: unknown): DraftBatch | null {
  if (!isRecord(value) || value.version !== 1 || !isText(value.id, 200) || !isText(value.name, 200)
    || !isText(value.createdAt, 40) || !isText(value.modifiedAt, 40) || !Array.isArray(value.topics)
    || value.topics.length > DRAFT_LIMITS.topics) return null;
  const source = decodeSource(value.source);
  const topics = value.topics.map(decodeTopic);
  if (!source || topics.some(topic => !topic)) return null;
  const guids = new Set<string>(), claims = new Set<string>();
  for (const topic of topics) {
    if (!topic || guids.has(topic.guid)) return null;
    guids.add(topic.guid);
    for (const member of topic.members) {
      const identity = findingIdentity(member);
      if (claims.has(identity)) return null;
      claims.add(identity);
    }
  }
  return { version: 1, id: value.id, name: value.name, createdAt: value.createdAt, modifiedAt: value.modifiedAt, source,
    topics: topics.flatMap(topic => topic ? [topic] : []) };
}
