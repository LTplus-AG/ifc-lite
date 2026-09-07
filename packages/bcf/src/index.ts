/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * @ifc-lite/bcf - BIM Collaboration Format support
 *
 * This package provides BCF (BIM Collaboration Format) support for IFC-Lite.
 * It implements BCF 2.1 and 3.0 specifications for topic tracking in BIM projects.
 *
 * @see https://github.com/buildingSMART/BCF-XML
 * @see https://www.buildingsmart.org/standards/bsi-standards/bim-collaboration-format/
 */

// Types
export type {
  // Project
  BCFProject,
  BCFExtensions,
  BCFVersion,
  // Topic
  BCFTopic,
  BCFComment,
  BCFBimSnippet,
  BCFDocumentReference,
  // Viewpoint
  BCFViewpoint,
  BCFPerspectiveCamera,
  BCFOrthogonalCamera,
  BCFPoint,
  BCFDirection,
  // Components
  BCFComponents,
  BCFComponent,
  BCFVisibility,
  BCFColoring,
  BCFViewSetupHints,
  // Markup
  BCFLine,
  BCFClippingPlane,
  BCFBitmap,
  // Header
  BCFHeaderFile,
} from './types.js';

// GUID utilities
export {
  uuidToIfcGuid,
  ifcGuidToUuid,
  generateIfcGuid,
  generateUuid,
  isValidIfcGuid,
  isValidUuid,
} from '@ifc-lite/encoding';

// Reader
export { readBCF } from './reader.js';

// Writer
export { writeBCF } from './writer.js';

// Viewpoint utilities
export type { ViewerCameraState, ViewerSectionPlane, ViewerBounds } from './viewpoint.js';
export {
  cameraToPerspective,
  cameraToOrthogonal,
  perspectiveToCamera,
  orthogonalToCamera,
  sectionPlaneToClippingPlane,
  clippingPlaneToSectionPlane,
  createViewpoint,
  extractViewpointState,
} from './viewpoint.js';

// 3D Overlay (viewer-agnostic marker positioning)
export type {
  OverlayPoint3D,
  OverlayBBox,
  BCFMarker3D,
  BCFOverlayProjection,
  EntityBoundsLookup,
  ComputeMarkersOptions,
} from './overlay.js';
export { computeMarkerPositions } from './overlay.js';

// 3D Overlay DOM Renderer (browser-only, framework-agnostic)
export type { BCFOverlayRendererOptions } from './overlay-renderer.js';
export { BCFOverlayRenderer } from './overlay-renderer.js';

// IDS → BCF reporter
export type {
  IDSReportInput,
  IDSSpecResultInput,
  IDSEntityResultInput,
  IDSRequirementResultInput,
  IDSBCFExportOptions,
  EntityBoundsInput,
} from './ids-reporter.js';
export { createBCFFromIDSReport } from './ids-reporter.js';

// ============================================================================
// Convenience functions
// ============================================================================

import type { BCFProject, BCFTopic, BCFComment, BCFViewpoint } from './types.js';
import { generateIfcGuid, generateUuid } from '@ifc-lite/encoding';

/**
 * Create a new empty BCF project
 */
export function createBCFProject(options?: {
  name?: string;
  version?: '2.1' | '3.0';
}): BCFProject {
  return {
    version: options?.version ?? '2.1',
    projectId: generateUuid(),
    name: options?.name,
    topics: new Map(),
  };
}

/**
 * Create a new BCF topic
 */
export function createBCFTopic(options: {
  title: string;
  description?: string;
  author: string;
  topicType?: string;
  topicStatus?: string;
  priority?: string;
  assignedTo?: string;
  dueDate?: string;
  labels?: string[];
}): BCFTopic {
  return {
    guid: generateUuid(),
    title: options.title,
    description: options.description,
    topicType: options.topicType ?? 'Issue',
    topicStatus: options.topicStatus ?? 'Open',
    priority: options.priority,
    creationDate: new Date().toISOString(),
    creationAuthor: options.author,
    assignedTo: options.assignedTo,
    dueDate: options.dueDate,
    labels: options.labels,
    comments: [],
    viewpoints: [],
  };
}

/**
 * Create a new BCF comment
 */
export function createBCFComment(options: {
  author: string;
  comment: string;
  viewpointGuid?: string;
}): BCFComment {
  return {
    guid: generateUuid(),
    date: new Date().toISOString(),
    author: options.author,
    comment: options.comment,
    viewpointGuid: options.viewpointGuid,
  };
}

/**
 * Add a topic to a project
 */
export function addTopicToProject(project: BCFProject, topic: BCFTopic): void {
  project.topics.set(topic.guid, topic);
}

/**
 * Add a comment to a topic
 */
export function addCommentToTopic(topic: BCFTopic, comment: BCFComment): void {
  topic.comments.push(comment);
  topic.modifiedDate = new Date().toISOString();
}

/**
 * Add a viewpoint to a topic
 */
export function addViewpointToTopic(topic: BCFTopic, viewpoint: BCFViewpoint): void {
  topic.viewpoints.push(viewpoint);
  topic.modifiedDate = new Date().toISOString();
}

/**
 * Update topic status
 */
export function updateTopicStatus(
  topic: BCFTopic,
  status: string,
  modifiedAuthor: string
): void {
  topic.topicStatus = status;
  topic.modifiedDate = new Date().toISOString();
  topic.modifiedAuthor = modifiedAuthor;
}

/**
 * Parse ARGB hex color string to RGBA values
 * BCF uses ARGB format (e.g., 'FFFF0000' = opaque red)
 */
export function parseARGBColor(argb: string): {
  r: number;
  g: number;
  b: number;
  a: number;
} {
  // Handle both 6 and 8 character formats
  const hex = argb.replace('#', '');

  if (hex.length === 6) {
    return {
      a: 255,
      r: parseInt(hex.substring(0, 2), 16),
      g: parseInt(hex.substring(2, 4), 16),
      b: parseInt(hex.substring(4, 6), 16),
    };
  }

  return {
    a: parseInt(hex.substring(0, 2), 16),
    r: parseInt(hex.substring(2, 4), 16),
    g: parseInt(hex.substring(4, 6), 16),
    b: parseInt(hex.substring(6, 8), 16),
  };
}

/**
 * Create ARGB hex color string from RGBA values
 */
export function toARGBColor(r: number, g: number, b: number, a = 255): string {
  const toHex = (n: number) => Math.round(Math.max(0, Math.min(255, n))).toString(16).padStart(2, '0');
  return `${toHex(a)}${toHex(r)}${toHex(g)}${toHex(b)}`.toUpperCase();
}
