/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { BimBackend, EntityRef, CameraState, ProjectionMode, RGBAColor } from '../types.js';
import type { SectionPlane } from '../section-plane.js';
import { hexToRgba } from '@ifc-lite/lens';

/** bim.viewer — Renderer control, camera, section planes */
export class ViewerNamespace {
  constructor(private backend: BimBackend) {}

  // ── Color overlays ─────────────────────────────────────────

  /** Colorize entities with a hex color string */
  colorize(refs: EntityRef[], color: string): void {
    const rgba = hexToRgba(color, 1.0);
    this.backend.viewer.colorize(refs, rgba);
  }

  /** Colorize with RGBA tuple [0-1] */
  colorizeRgba(refs: EntityRef[], color: RGBAColor): void {
    this.backend.viewer.colorize(refs, color);
  }

  /** Batch colorize: apply multiple entity-color pairs in a single call */
  colorizeAll(batches: Array<{ refs: EntityRef[]; color: string }>): void {
    const resolved = batches.map(b => ({ refs: b.refs, color: hexToRgba(b.color, 1.0) }));
    this.backend.viewer.colorizeAll(resolved);
  }

  /** Reset color overrides. Omit refs for all; an explicit empty list is a no-op. */
  resetColors(refs?: EntityRef[]): void {
    if (refs?.length === 0) return;
    this.backend.viewer.resetColors(refs);
  }

  // ── Visibility ─────────────────────────────────────────────

  /** Hide entities */
  hide(refs: EntityRef[]): void {
    this.backend.visibility.hide(refs);
  }

  /** Show previously hidden entities */
  show(refs: EntityRef[]): void {
    this.backend.visibility.show(refs);
  }

  /** Isolate entities (hide everything else) */
  isolate(refs: EntityRef[]): void {
    this.backend.visibility.isolate(refs);
  }

  /** Reset all visibility to default */
  resetVisibility(): void {
    this.backend.visibility.reset();
  }

  // ── Selection ──────────────────────────────────────────────

  /** Set the selection to given entities */
  select(refs: EntityRef[]): void {
    this.backend.selection.set(refs);
  }

  /** Clear selection */
  deselect(): void {
    this.backend.selection.set([]);
  }

  /** Get current selection */
  getSelection(): EntityRef[] {
    return this.backend.selection.get();
  }

  // ── Camera ─────────────────────────────────────────────────

  /** Fly camera to frame the given entities */
  flyTo(refs: EntityRef[]): void {
    this.backend.viewer.flyTo(refs);
  }

  /** Set camera state */
  setCamera(state: Partial<CameraState>): void {
    this.backend.viewer.setCamera(state);
  }

  /** Get current camera state */
  getCamera(): CameraState {
    return this.backend.viewer.getCamera();
  }

  /** Switch projection mode */
  setProjection(mode: ProjectionMode): void {
    this.backend.viewer.setCamera({ mode });
  }

  // ── Section planes ─────────────────────────────────────────

  /** Set a section plane */
  setSection(section: SectionPlane): void {
    this.backend.viewer.setSection(section);
  }

  /** Get current section plane */
  getSection(): SectionPlane | null {
    return this.backend.viewer.getSection();
  }

  /** Remove section plane */
  clearSection(): void {
    this.backend.viewer.setSection(null);
  }

  // ── Several section planes ─────────────────────────────────

  /**
   * Every cutting plane on screen. What is kept is what ALL of them keep. A backend that clips
   * with one plane reports it (or none).
   */
  getSections(): SectionPlane[] {
    const viewer = this.backend.viewer;
    if (viewer.getSections) return viewer.getSections();
    const one = viewer.getSection();
    return one ? [one] : [];
  }

  /**
   * Replace every cutting plane with `sections`, in order (the first becomes the active one).
   * An empty list clears them all. A single-plane backend applies the first plane that is enabled.
   */
  setSections(sections: SectionPlane[]): void {
    const viewer = this.backend.viewer;
    if (viewer.setSections) viewer.setSections(sections);
    else viewer.setSection(sections.find((section) => section.enabled) ?? sections[0] ?? null);
  }

  /**
   * Add one more cutting plane beside the others and return its id, or `null` when it was not added: the
   * viewer is at its limit (eight planes), or the plane is not `enabled`. A single-plane backend replaces
   * its plane and returns `null`.
   */
  addSection(section: SectionPlane): string | null {
    const viewer = this.backend.viewer;
    if (viewer.addSection) return viewer.addSection(section);
    viewer.setSection(section);
    return null;
  }

  /** Remove the plane with this id (from `getSections()` or `addSection()`); false when there is none. */
  removeSection(id: string): boolean {
    const viewer = this.backend.viewer;
    return viewer.removeSection ? viewer.removeSection(id) : false;
  }
}
