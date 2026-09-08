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

export interface ViewpointOptions {
  /** Camera state from bim.viewer.getCamera() */
  camera?: {
    mode: 'perspective' | 'orthographic';
    position?: [number, number, number];
    target?: [number, number, number];
    up?: [number, number, number];
  };
  /** Section plane from bim.viewer.getSection() */
  sectionPlane?: {
    axis: 'x' | 'y' | 'z';
    position: number;
    enabled: boolean;
    flipped: boolean;
  };
  /** Component selection/visibility */
  components?: {
    selection?: Array<{ GlobalId: string }>;
    visibility?: {
      defaultVisibility: boolean;
      exceptions?: Array<{ GlobalId: string }>;
    };
    coloring?: Array<{
      color: string;
      components: Array<{ GlobalId: string }>;
    }>;
  };
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
// Dynamic import
// ============================================================================

async function loadBCF(): Promise<Record<string, unknown>> {
  const name = '@ifc-lite/bcf';
  return import(/* webpackIgnore: true */ name) as Promise<Record<string, unknown>>;
}

type AnyFn = (...args: unknown[]) => unknown;

// ============================================================================
// BCFNamespace
// ============================================================================

/** bim.bcf — BIM Collaboration Format (topics, viewpoints, comments, I/O) */
export class BCFNamespace {

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

  /** Create a BCF viewpoint from viewer camera/section state. */
  async createViewpoint(options?: ViewpointOptions): Promise<unknown> {
    const mod = await loadBCF();
    if (!options) return (mod.createViewpoint as AnyFn)({});

    // Map SDK's GlobalId (IFC convention) to BCF library's guid-based lists
    const comps = options.components;
    const bcfOptions: Record<string, unknown> = {};
    if (options.camera) bcfOptions.camera = options.camera;
    if (options.sectionPlane) bcfOptions.sectionPlane = options.sectionPlane;

    if (comps?.selection) {
      bcfOptions.selectedGuids = comps.selection.map(c => c.GlobalId);
    }
    if (comps?.visibility) {
      if (comps.visibility.defaultVisibility) {
        // Default visible → exceptions are hidden
        bcfOptions.hiddenGuids = comps.visibility.exceptions?.map(c => c.GlobalId);
      } else {
        // Default hidden → exceptions are visible (isolation mode)
        bcfOptions.visibleGuids = comps.visibility.exceptions?.map(c => c.GlobalId);
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

  /** Extract viewer state from a BCF viewpoint. */
  async extractViewpointState(viewpoint: unknown): Promise<unknown> {
    const mod = await loadBCF();
    return (mod.extractViewpointState as AnyFn)(viewpoint);
  }

  // --------------------------------------------------------------------------
  // Camera conversion helpers
  // --------------------------------------------------------------------------

  /** Convert viewer camera state to BCF perspective camera. */
  async cameraToPerspective(camera: unknown): Promise<unknown> {
    const mod = await loadBCF();
    return (mod.cameraToPerspective as AnyFn)(camera);
  }

  /** Convert viewer camera state to BCF orthogonal camera. */
  async cameraToOrthogonal(camera: unknown): Promise<unknown> {
    const mod = await loadBCF();
    return (mod.cameraToOrthogonal as AnyFn)(camera);
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

  /** Convert viewer section plane to BCF clipping plane. */
  async sectionPlaneToClippingPlane(section: unknown): Promise<unknown> {
    const mod = await loadBCF();
    return (mod.sectionPlaneToClippingPlane as AnyFn)(section);
  }

  /** Convert BCF clipping plane to viewer section plane. */
  async clippingPlaneToSectionPlane(clippingPlane: unknown): Promise<unknown> {
    const mod = await loadBCF();
    return (mod.clippingPlaneToSectionPlane as AnyFn)(clippingPlane);
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

  // --------------------------------------------------------------------------
  // GUID utilities
  // --------------------------------------------------------------------------

  /** Generate a new IFC GUID (22-char base64). */
  async generateIfcGuid(): Promise<string> {
    const mod = await loadBCF();
    return (mod.generateIfcGuid as () => string)();
  }

  /** Generate a new UUID (36-char). */
  async generateUuid(): Promise<string> {
    const mod = await loadBCF();
    return (mod.generateUuid as () => string)();
  }

  /** Convert UUID to IFC GUID. */
  async uuidToIfcGuid(uuid: string): Promise<string> {
    const mod = await loadBCF();
    return (mod.uuidToIfcGuid as (u: string) => string)(uuid);
  }

  /** Convert IFC GUID to UUID. */
  async ifcGuidToUuid(guid: string): Promise<string> {
    const mod = await loadBCF();
    return (mod.ifcGuidToUuid as (g: string) => string)(guid);
  }

  /** Validate whether a string is a valid IFC GUID. */
  async isValidIfcGuid(guid: string): Promise<boolean> {
    const mod = await loadBCF();
    return (mod.isValidIfcGuid as (g: string) => boolean)(guid);
  }

  /** Validate whether a string is a valid UUID. */
  async isValidUuid(uuid: string): Promise<boolean> {
    const mod = await loadBCF();
    return (mod.isValidUuid as (u: string) => boolean)(uuid);
  }

  // --------------------------------------------------------------------------
  // Color utilities
  // --------------------------------------------------------------------------

  /** Parse ARGB hex color string (BCF format) to RGBA values. */
  async parseARGBColor(argb: string): Promise<{ r: number; g: number; b: number; a: number }> {
    const mod = await loadBCF();
    return (mod.parseARGBColor as (c: string) => { r: number; g: number; b: number; a: number })(argb);
  }

  /** Create ARGB hex color string (BCF format) from RGBA values. */
  async toARGBColor(r: number, g: number, b: number, a?: number): Promise<string> {
    const mod = await loadBCF();
    return (mod.toARGBColor as (r: number, g: number, b: number, a?: number) => string)(r, g, b, a);
  }
}
