/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Annotation slice — pins anchored to world points on the 3D scene.
 *
 * Each pin holds a short note and persists across reloads via
 * localStorage (scoped per browser, no server). Pins are NOT IFC
 * entities — they live alongside the model as an authoring overlay.
 * Future PRs will add BCF round-trip and IfcAnnotation export.
 *
 * Coordinate frame: world positions are stored in the renderer's
 * local Y-up coordinate space (the same one the camera projects
 * from). Pins are placed by raycasting the scene under the cursor;
 * the raycast intersection is already in this frame so no conversion
 * is needed at write time.
 */

import { type StateCreator } from 'zustand';

const STORAGE_KEY = 'ifc-lite:annotations:v1';
const MAX_NOTE_LEN = 2000;

export interface AnnotationPosition {
  x: number;
  y: number;
  z: number;
}

export interface Annotation {
  id: string;
  /** World-space position in the renderer's local Y-up frame. */
  position: AnnotationPosition;
  /** Plain-text body (Markdown rendering deliberately punted to v2). */
  note: string;
  /** Express id of the entity the user clicked, when one was hit. */
  entityExpressId: number | null;
  /** Federated model id when the click landed on a model mesh; null for empty-space clicks. */
  modelId: string | null;
  createdAt: number;
  updatedAt: number;
}

export interface AnnotationDraft {
  /** Floating ID used by the inline input UI before the annotation is committed. */
  draftId: string;
  position: AnnotationPosition;
  entityExpressId: number | null;
  modelId: string | null;
}

export interface AnnotationsSlice {
  // State
  annotations: Map<string, Annotation>;
  /** Pending pin awaiting a note — drives the inline drop input. */
  draft: AnnotationDraft | null;
  /** Currently expanded pin (popover open). */
  selectedAnnotationId: string | null;

  // Actions
  /** Open the inline drop input at a world position. */
  beginDraft: (position: AnnotationPosition, entityExpressId: number | null, modelId: string | null) => void;
  /** Commit the draft into a new annotation. Empty notes drop the draft silently. */
  commitDraft: (note: string) => string | null;
  /** Cancel the draft. */
  cancelDraft: () => void;
  /** Update an existing annotation's note. */
  updateAnnotation: (id: string, note: string) => void;
  /** Delete an annotation. */
  removeAnnotation: (id: string) => void;
  /** Open the popover for an existing pin. */
  selectAnnotation: (id: string | null) => void;
  /** Wipe all annotations across all models. Used by tests / "reset". */
  clearAllAnnotations: () => void;
}

function generateId(prefix: 'ann' | 'draft'): string {
  const rnd = Math.random().toString(36).slice(2, 9);
  return `${prefix}_${Date.now().toString(36)}_${rnd}`;
}

function clampNote(note: string): string {
  const trimmed = note.trim();
  return trimmed.length > MAX_NOTE_LEN ? trimmed.slice(0, MAX_NOTE_LEN) : trimmed;
}

// ── Persistence ──────────────────────────────────────────────────────

function isFiniteNumber(v: unknown): v is number {
  return typeof v === 'number' && Number.isFinite(v);
}

function isValidPosition(v: unknown): v is AnnotationPosition {
  if (!v || typeof v !== 'object') return false;
  const p = v as Record<string, unknown>;
  return isFiniteNumber(p.x) && isFiniteNumber(p.y) && isFiniteNumber(p.z);
}

function isValidAnnotation(v: unknown): v is Annotation {
  if (!v || typeof v !== 'object') return false;
  const a = v as Record<string, unknown>;
  if (typeof a.id !== 'string' || a.id.length === 0) return false;
  if (typeof a.note !== 'string') return false;
  if (!isValidPosition(a.position)) return false;
  if (a.entityExpressId !== null && !isFiniteNumber(a.entityExpressId)) return false;
  if (a.modelId !== null && typeof a.modelId !== 'string') return false;
  if (!isFiniteNumber(a.createdAt) || !isFiniteNumber(a.updatedAt)) return false;
  return true;
}

function loadFromStorage(): Map<string, Annotation> {
  try {
    if (typeof localStorage === 'undefined') return new Map();
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return new Map();
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return new Map();
    const map = new Map<string, Annotation>();
    for (const item of parsed) {
      if (!isValidAnnotation(item)) {
        // eslint-disable-next-line no-console
        console.warn(`[annotations] skipping malformed entry from ${STORAGE_KEY}`, item);
        continue;
      }
      map.set(item.id, item);
    }
    return map;
  } catch (err) {
    // eslint-disable-next-line no-console
    console.warn(`[annotations] failed to load from ${STORAGE_KEY}`, err);
    return new Map();
  }
}

function saveToStorage(annotations: Map<string, Annotation>): void {
  try {
    if (typeof localStorage === 'undefined') return;
    const arr = Array.from(annotations.values());
    localStorage.setItem(STORAGE_KEY, JSON.stringify(arr));
  } catch (err) {
    // Quota exceeded / private mode — annotations stay in memory but
    // the warning makes the failure debuggable.
    // eslint-disable-next-line no-console
    console.warn(`[annotations] failed to persist to ${STORAGE_KEY}`, err);
  }
}

// ── Slice ────────────────────────────────────────────────────────────

export const createAnnotationsSlice: StateCreator<AnnotationsSlice, [], [], AnnotationsSlice> = (
  set,
  get,
) => ({
  annotations: loadFromStorage(),
  draft: null,
  selectedAnnotationId: null,

  beginDraft: (position, entityExpressId, modelId) => {
    set({
      draft: {
        draftId: generateId('draft'),
        position,
        entityExpressId,
        modelId,
      },
      // Drafting opens its own input — close any open popover first
      // so the two pieces of UI don't fight for focus.
      selectedAnnotationId: null,
    });
  },

  commitDraft: (note) => {
    const draft = get().draft;
    if (!draft) return null;
    const clamped = clampNote(note);
    if (clamped.length === 0) {
      set({ draft: null });
      return null;
    }
    const id = generateId('ann');
    const now = Date.now();
    const annotation: Annotation = {
      id,
      position: draft.position,
      note: clamped,
      entityExpressId: draft.entityExpressId,
      modelId: draft.modelId,
      createdAt: now,
      updatedAt: now,
    };
    set((state) => {
      const next = new Map(state.annotations);
      next.set(id, annotation);
      saveToStorage(next);
      return {
        annotations: next,
        draft: null,
        selectedAnnotationId: null,
      };
    });
    return id;
  },

  cancelDraft: () => {
    set({ draft: null });
  },

  updateAnnotation: (id, note) => {
    set((state) => {
      const existing = state.annotations.get(id);
      if (!existing) return {};
      const clamped = clampNote(note);
      if (clamped.length === 0) {
        // Deleting via empty note feels surprising — keep the
        // annotation but with an empty body so the user can choose
        // to delete via the trash icon explicitly.
        const next = new Map(state.annotations);
        next.set(id, { ...existing, note: '', updatedAt: Date.now() });
        saveToStorage(next);
        return { annotations: next };
      }
      const next = new Map(state.annotations);
      next.set(id, { ...existing, note: clamped, updatedAt: Date.now() });
      saveToStorage(next);
      return { annotations: next };
    });
  },

  removeAnnotation: (id) => {
    set((state) => {
      if (!state.annotations.has(id)) return {};
      const next = new Map(state.annotations);
      next.delete(id);
      saveToStorage(next);
      return {
        annotations: next,
        selectedAnnotationId: state.selectedAnnotationId === id ? null : state.selectedAnnotationId,
      };
    });
  },

  selectAnnotation: (id) => {
    set({ selectedAnnotationId: id });
  },

  clearAllAnnotations: () => {
    saveToStorage(new Map());
    set({ annotations: new Map(), draft: null, selectedAnnotationId: null });
  },
});
