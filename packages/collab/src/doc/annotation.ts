/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Collaboration annotation pins (markup) — shared room overlay data.
 *
 * Each annotation is a flat `Y.Map` under the top-level `annotations` map,
 * keyed by annotation id. Values are scalars / small plain objects (position),
 * replaced atomically — annotations are simple records, not the nested
 * sub-map structure entities use. Synced by Yjs across peers and persisted by
 * the server, but deliberately ignored by `snapshotToIfcx` (markup ≠ BIM).
 *
 * The viewer's local annotation slice mirrors create/update/delete into here
 * (and observes inbound changes back) via `lib/collab/annotation-sync`.
 */

import * as Y from 'yjs';
import { TOP } from './schema.js';

export interface AnnotationPosition {
  x: number;
  y: number;
  z: number;
}

/** Mutable fields of a shared annotation. */
export interface AnnotationFields {
  /** World-space pin position in the renderer's local frame. */
  position: AnnotationPosition;
  /** Plain-text note body. */
  note: string;
  /** `/<guid>` of the anchored entity, or null for an empty-space pin. */
  entityPath?: string | null;
  /** Author identity (ephemeral collab identity), for attribution. */
  authorId: string;
  authorName: string;
  authorColor: string;
  /** Wall-clock ms (caller-supplied so the helper stays pure/deterministic). */
  createdAt: number;
  updatedAt: number;
}

export interface AnnotationRecord extends AnnotationFields {
  id: string;
}

/** Top-level accessor for the annotations collection. */
export function annotationsMap(doc: Y.Doc): Y.Map<Y.Map<unknown>> {
  return doc.getMap(TOP.ANNOTATIONS) as Y.Map<Y.Map<unknown>>;
}

/** Create or replace an annotation by id (idempotent on the same id). */
export function createAnnotation(doc: Y.Doc, id: string, fields: AnnotationFields): Y.Map<unknown> {
  const map = annotationsMap(doc);
  const existing = map.get(id);
  const ann = existing ?? new Y.Map<unknown>();
  ann.set('position', { x: fields.position.x, y: fields.position.y, z: fields.position.z });
  ann.set('note', fields.note);
  ann.set('entityPath', fields.entityPath ?? null);
  ann.set('authorId', fields.authorId);
  ann.set('authorName', fields.authorName);
  ann.set('authorColor', fields.authorColor);
  ann.set('createdAt', fields.createdAt);
  ann.set('updatedAt', fields.updatedAt);
  if (!existing) map.set(id, ann);
  return ann;
}

/** Patch an existing annotation's note/position. Returns false if it's gone. */
export function updateAnnotation(
  doc: Y.Doc,
  id: string,
  patch: { note?: string; position?: AnnotationPosition; updatedAt: number },
): boolean {
  const ann = annotationsMap(doc).get(id);
  if (!ann) return false;
  if (patch.note !== undefined) ann.set('note', patch.note);
  if (patch.position !== undefined) {
    ann.set('position', { x: patch.position.x, y: patch.position.y, z: patch.position.z });
  }
  ann.set('updatedAt', patch.updatedAt);
  return true;
}

/** Remove an annotation. Returns false if it didn't exist. */
export function deleteAnnotation(doc: Y.Doc, id: string): boolean {
  const map = annotationsMap(doc);
  if (!map.has(id)) return false;
  map.delete(id);
  return true;
}

export function getAnnotation(doc: Y.Doc, id: string): AnnotationRecord | null {
  const ann = annotationsMap(doc).get(id);
  return ann ? annotationToJSON(id, ann) : null;
}

export function* iterAnnotations(doc: Y.Doc): IterableIterator<AnnotationRecord> {
  for (const [id, ann] of annotationsMap(doc).entries()) {
    yield annotationToJSON(id, ann);
  }
}

/** Plain-object view of a stored annotation Y.Map. */
export function annotationToJSON(id: string, ann: Y.Map<unknown>): AnnotationRecord {
  const pos = (ann.get('position') as AnnotationPosition | undefined) ?? { x: 0, y: 0, z: 0 };
  return {
    id,
    position: { x: pos.x ?? 0, y: pos.y ?? 0, z: pos.z ?? 0 },
    note: (ann.get('note') as string) ?? '',
    entityPath: (ann.get('entityPath') as string | null) ?? null,
    authorId: (ann.get('authorId') as string) ?? '',
    authorName: (ann.get('authorName') as string) ?? '',
    authorColor: (ann.get('authorColor') as string) ?? '',
    createdAt: (ann.get('createdAt') as number) ?? 0,
    updatedAt: (ann.get('updatedAt') as number) ?? 0,
  };
}
