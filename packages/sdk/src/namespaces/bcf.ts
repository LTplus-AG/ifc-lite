/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * bim.bcf — BCF collaboration (topics, viewpoints, comments)
 *
 * Full access to @ifc-lite/bcf for reading/writing BCF files,
 * managing collaboration data, creating viewpoints, and
 * converting between IDS reports and BCF topics.
 */

import type { AABB } from '../types.js';
import {
  type ViewpointOptions,
  type ExtractedViewpointState,
  type BcfViewerCameraState,
  type BcfViewerSectionPlane,
  IncompleteCameraStateError,
  MissingSectionBoundsError,
  DEFAULT_VIEWPOINT_FOV,
  toVec3,
  toTuple,
  toLibraryBounds,
  type BcfViewerBounds,
  collectMissingCameraFields,
  SDK_AXIS_TO_BCF_AXIS,
  BCF_AXIS_TO_SDK_AXIS,
} from './bcf-viewpoint.js';
import { loadBCF, type AnyFn } from './bcf-load.js';
import { BCFGuidColorBase } from './bcf-guid-color.js';

export type { ViewpointOptions, ExtractedViewpointState };
export { IncompleteCameraStateError, MissingSectionBoundsError };

// ============================================================================
// Option types for the namespace API
// ============================================================================

export interface TopicOptions {
  title: string;
  description?: string;
  author: string;
  topicType?: string;
  status?: string;
  priority?: string;
  assignedTo?: string;
  dueDate?: string;
  labels?: string[];
}

export interface CommentOptions {
  author: string;
  comment: string;
  viewpointGuid?: string;
}

export interface IDSBCFOptions {
  /** BCF project name */
  projectName?: string;
  /** Author for generated topics */
  author?: string;
  /** BCF version */
  version?: '2.1' | '3.0';
  /** Bounding boxes per entity for viewpoint generation */
  entityBounds?: Map<string, { min: [number, number, number]; max: [number, number, number] }>;
}

// ============================================================================
// BCFNamespace
// ============================================================================

/** bim.bcf — BIM Collaboration Format (topics, viewpoints, comments, I/O).
 * The GUID and color utility methods live in `bcf-guid-color.ts`'s base
 * class (module-size split, #4294). */
export class BCFNamespace extends BCFGuidColorBase {

  // --------------------------------------------------------------------------
  // Project management
  // --------------------------------------------------------------------------

  /** Create a new BCF project. */
  async createProject(options?: { name?: string; version?: '2.1' | '3.0' }): Promise<unknown> {
    const mod = await loadBCF();
    return (mod.createBCFProject as AnyFn)(options);
  }

  // --------------------------------------------------------------------------
  // Topic management
  // --------------------------------------------------------------------------

  /** Create a new topic. */
  async createTopic(options: TopicOptions): Promise<unknown> {
    const mod = await loadBCF();
    return (mod.createBCFTopic as AnyFn)({
      title: options.title,
      description: options.description,
      author: options.author,
      topicType: options.topicType,
      topicStatus: options.status,
      priority: options.priority,
      assignedTo: options.assignedTo,
      dueDate: options.dueDate,
      labels: options.labels,
    });
  }

  /** Add a topic to a project. */
  async addTopic(project: unknown, topic: unknown): Promise<void> {
    const mod = await loadBCF();
    (mod.addTopicToProject as AnyFn)(project, topic);
  }

  /** Update the status of a topic. */
  async updateTopicStatus(topic: unknown, status: string, modifiedAuthor: string): Promise<void> {
    const mod = await loadBCF();
    (mod.updateTopicStatus as AnyFn)(topic, status, modifiedAuthor);
  }

  // --------------------------------------------------------------------------
  // Comments
  // --------------------------------------------------------------------------

  /** Create a new comment. */
  async createComment(options: CommentOptions): Promise<unknown> {
    const mod = await loadBCF();
    return (mod.createBCFComment as AnyFn)(options);
  }

  /** Add a comment to a topic. */
  async addComment(topic: unknown, comment: unknown): Promise<void> {
    const mod = await loadBCF();
    (mod.addCommentToTopic as AnyFn)(topic, comment);
  }

  // --------------------------------------------------------------------------
  // Viewpoints
  // --------------------------------------------------------------------------

  /**
   * Create a BCF viewpoint from viewer camera/section state.
   *
   * Converts the SDK's tuple-based `camera`/x-y-z `sectionPlane` shapes
   * (`bim.viewer.getCamera()`/`getSection()`) into `@ifc-lite/bcf`'s
   * object-based `ViewerCameraState`/`ViewerSectionPlane` shapes. Throws
   * `IncompleteCameraStateError` for a camera missing position/target/up,
   * and `MissingSectionBoundsError` for an enabled section plane with no
   * `bounds` — see #4251.
   */
  async createViewpoint(options?: ViewpointOptions): Promise<unknown> {
    const mod = await loadBCF();

    const missingCamera = collectMissingCameraFields(options?.camera);
    if (missingCamera.length > 0) {
      throw new IncompleteCameraStateError(missingCamera);
    }
    const camera = options!.camera!;

    // Map SDK's GlobalId (IFC convention) to BCF library's guid-based lists
    const comps = options?.components;
    const bcfOptions: Record<string, unknown> = {
      camera: {
        position: toVec3(camera.position!),
        target: toVec3(camera.target!),
        up: toVec3(camera.up!),
        fov: DEFAULT_VIEWPOINT_FOV,
        isOrthographic: camera.mode === 'orthographic',
      } satisfies BcfViewerCameraState,
    };

    if (options?.sectionPlane) {
      const sp = options.sectionPlane;
      if (sp.enabled && !options.bounds) {
        throw new MissingSectionBoundsError();
      }
      bcfOptions.sectionPlane = {
        axis: SDK_AXIS_TO_BCF_AXIS[sp.axis],
        position: sp.position,
        enabled: sp.enabled,
        flipped: sp.flipped,
      } satisfies BcfViewerSectionPlane;
    }
    if (options?.bounds) {
      bcfOptions.bounds = {
        min: toVec3(options.bounds.min),
        max: toVec3(options.bounds.max),
      };
    }

    if (comps?.selection) {
      bcfOptions.selectedGuids = comps.selection.map(c => c.GlobalId);
    }
    if (comps?.visibility) {
      // Both halves are spelled out on `ViewpointOptions.components
      // .visibility`: `DefaultVisibility` is optional and TRUE by default, and
      // `?? []` (not `?.map`) preserves an isolation that matches nothing.
      if (comps.visibility.defaultVisibility ?? true) {
        bcfOptions.hiddenGuids = comps.visibility.exceptions?.map(c => c.GlobalId);
      } else {
        bcfOptions.visibleGuids = comps.visibility.exceptions?.map(c => c.GlobalId) ?? [];
      }
    }
    if (comps?.coloring) {
      bcfOptions.coloredGuids = comps.coloring.map(g => ({
        color: g.color,
        guids: g.components.map(c => c.GlobalId),
      }));
    }

    return (mod.createViewpoint as AnyFn)(bcfOptions);
  }

  /** Add a viewpoint to a topic. */
  async addViewpoint(topic: unknown, viewpoint: unknown): Promise<void> {
    const mod = await loadBCF();
    (mod.addViewpointToTopic as AnyFn)(topic, viewpoint);
  }

  /**
   * Extract viewer state from a BCF viewpoint.
   *
   * Converts `@ifc-lite/bcf`'s object-based `camera`/`sectionPlane`
   * (`down`/`front`/`side` axis) back into the SDK's tuple `camera` /
   * `x`/`y`/`z` `sectionPlane` shapes, so the result round-trips straight
   * into `bim.viewer.setCamera()`/`setSection()` — the same conversion
   * `createViewpoint()` performs in reverse (#4251). Pass `bounds` (the
   * model's AABB) to also recover `sectionPlane`; without it
   * `@ifc-lite/bcf` cannot place a clipping plane and `sectionPlane` is
   * omitted, matching `createViewpoint()`'s own bounds requirement.
   */
  async extractViewpointState(viewpoint: unknown, bounds?: AABB): Promise<ExtractedViewpointState> {
    const mod = await loadBCF();
    const bcfBounds = bounds
      ? { min: toVec3(bounds.min), max: toVec3(bounds.max) }
      : undefined;
    const raw = (mod.extractViewpointState as AnyFn)(viewpoint, bcfBounds) as {
      camera?: BcfViewerCameraState;
      sectionPlane?: BcfViewerSectionPlane;
      selectedGuids: string[];
      hiddenGuids: string[];
      visibleGuids: string[] | null;
      coloredGuids: Array<{ color: string; guids: string[] }>;
    };

    return {
      camera: raw.camera
        ? {
            mode: raw.camera.isOrthographic ? 'orthographic' : 'perspective',
            position: toTuple(raw.camera.position),
            target: toTuple(raw.camera.target),
            up: toTuple(raw.camera.up),
          }
        : undefined,
      sectionPlane: raw.sectionPlane
        ? {
            axis: BCF_AXIS_TO_SDK_AXIS[raw.sectionPlane.axis],
            position: raw.sectionPlane.position,
            enabled: raw.sectionPlane.enabled,
            flipped: raw.sectionPlane.flipped,
          }
        : undefined,
      selectedGuids: raw.selectedGuids,
      hiddenGuids: raw.hiddenGuids,
      visibleGuids: raw.visibleGuids,
      coloredGuids: raw.coloredGuids,
    };
  }

  // --------------------------------------------------------------------------
  // Camera conversion helpers
  // --------------------------------------------------------------------------

  /** Convert viewer camera state to BCF perspective camera. */
  async cameraToPerspective(camera: unknown): Promise<unknown> {
    const mod = await loadBCF();
    return (mod.cameraToPerspective as AnyFn)(camera);
  }

  /** Convert viewer camera state to BCF orthogonal camera. `viewToWorldScale`
   * is required — it is the view extent the library returns verbatim (#4294). */
  async cameraToOrthogonal(camera: unknown, viewToWorldScale: unknown): Promise<unknown> {
    const mod = await loadBCF();
    return (mod.cameraToOrthogonal as AnyFn)(camera, viewToWorldScale);
  }

  /** Convert BCF perspective camera to viewer camera state. */
  async perspectiveToCamera(perspective: unknown): Promise<unknown> {
    const mod = await loadBCF();
    return (mod.perspectiveToCamera as AnyFn)(perspective);
  }

  /** Convert BCF orthogonal camera to viewer camera state. */
  async orthogonalToCamera(orthogonal: unknown): Promise<unknown> {
    const mod = await loadBCF();
    return (mod.orthogonalToCamera as AnyFn)(orthogonal);
  }

  // --------------------------------------------------------------------------
  // Section plane conversion
  // --------------------------------------------------------------------------

  /** Convert viewer section plane to BCF clipping plane. `bounds` is required
   * — the library needs it to place an absolute location (#4265). Accepts the
   * SDK's tuple `AABB` or the library's object-shaped bounds. */
  async sectionPlaneToClippingPlane(section: unknown, bounds: AABB | BcfViewerBounds): Promise<unknown> {
    const mod = await loadBCF();
    return (mod.sectionPlaneToClippingPlane as AnyFn)(section, toLibraryBounds(bounds));
  }

  /** Convert BCF clipping plane to viewer section plane. `bounds` is required
   * — the library needs it to compute a percentage position (#4265). Accepts
   * the SDK's tuple `AABB` or the library's object-shaped bounds. */
  async clippingPlaneToSectionPlane(clippingPlane: unknown, bounds: AABB | BcfViewerBounds): Promise<unknown> {
    const mod = await loadBCF();
    return (mod.clippingPlaneToSectionPlane as AnyFn)(clippingPlane, toLibraryBounds(bounds));
  }

  // --------------------------------------------------------------------------
  // I/O — Read / Write BCF files
  // --------------------------------------------------------------------------

  /** Read a BCF file (ZIP archive) into a BCF project structure. */
  async read(data: Blob | ArrayBuffer): Promise<unknown> {
    const mod = await loadBCF();
    return (mod.readBCF as AnyFn)(data);
  }

  /** Write a BCF project to a downloadable Blob (ZIP archive). */
  async write(project: unknown): Promise<Blob> {
    const mod = await loadBCF();
    return (mod.writeBCF as AnyFn)(project) as Promise<Blob>;
  }

  // --------------------------------------------------------------------------
  // IDS → BCF conversion
  // --------------------------------------------------------------------------

  /** Convert an IDS validation report into BCF topics (one topic per failed spec). */
  async createFromIDSReport(report: unknown, options?: IDSBCFOptions): Promise<unknown> {
    const mod = await loadBCF();
    return (mod.createBCFFromIDSReport as AnyFn)(report, options);
  }

}
