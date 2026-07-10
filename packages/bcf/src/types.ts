/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * BCF (BIM Collaboration Format) TypeScript types
 * Based on BCF 2.1 and 3.0 specifications by buildingSMART
 * https://github.com/buildingSMART/BCF-XML
 */

// ============================================================================
// BCF Project
// ============================================================================

export interface BCFProject {
  /** BCF version (2.1 or 3.0) */
  version: '2.1' | '3.0';
  /** Project ID (GUID) */
  projectId?: string;
  /** Project name */
  name?: string;
  /** Map of topic GUIDs to topics */
  topics: Map<string, BCFTopic>;
  /** Extensions schema (allowed topic types, statuses, etc.) */
  extensions?: BCFExtensions;
}

export interface BCFExtensions {
  topicTypes?: string[];
  topicStatuses?: string[];
  priorities?: string[];
  topicLabels?: string[];
  users?: string[];
  stages?: string[];
}

// ============================================================================
// BCF Topic (Issue)
// ============================================================================

export interface BCFTopic {
  /** Unique identifier (22-char GUID) */
  guid: string;
  /** Topic title (required) */
  title: string;
  /** Detailed description */
  description?: string;
  /** Topic type (e.g., 'Error', 'Warning', 'Info', 'Request') */
  topicType?: string;
  /** Status (e.g., 'Open', 'In Progress', 'Closed', 'Resolved') */
  topicStatus?: string;
  /** Priority (e.g., 'High', 'Medium', 'Low') */
  priority?: string;
  /** Index for ordering topics */
  index?: number;
  /** Creation date (ISO 8601) */
  creationDate: string;
  /** Author email */
  creationAuthor: string;
  /** Modification date (ISO 8601) */
  modifiedDate?: string;
  /** Modifier email */
  modifiedAuthor?: string;
  /** Due date (ISO 8601) */
  dueDate?: string;
  /** Assigned user email */
  assignedTo?: string;
  /** Stage/phase */
  stage?: string;
  /** Labels for categorization */
  labels?: string[];
  /** Referenced BIM snippet */
  bimSnippet?: BCFBimSnippet;
  /** Document references */
  documentReferences?: BCFDocumentReference[];
  /** Related topics */
  relatedTopics?: string[];
  /** Comments on the topic */
  comments: BCFComment[];
  /** Viewpoints associated with the topic */
  viewpoints: BCFViewpoint[];
  /**
   * Source IFC file(s) this topic refers to (markup `<Header>`). One entry per
   * distinct model touched by the topic, so a federated topic round-trips the
   * provenance of every model it spans. Optional: absent for topics with no
   * resolvable source model.
   */
  header?: BCFHeaderFile[];
}

export interface BCFBimSnippet {
  snippetType: string;
  isExternal: boolean;
  reference: string;
  referenceSchema?: string;
}

export interface BCFDocumentReference {
  guid?: string;
  isExternal: boolean;
  referencedDocument: string;
  description?: string;
}

// ============================================================================
// BCF Comment
// ============================================================================

export interface BCFComment {
  /** Unique identifier */
  guid: string;
  /** Comment creation date (ISO 8601) */
  date: string;
  /** Author email */
  author: string;
  /** Comment text */
  comment: string;
  /** Reference to a viewpoint GUID */
  viewpointGuid?: string;
  /** Modification date */
  modifiedDate?: string;
  /** Modifier email */
  modifiedAuthor?: string;
}

// ============================================================================
// BCF Viewpoint
// ============================================================================

export interface BCFViewpoint {
  /** Unique identifier */
  guid: string;
  /** Perspective camera settings */
  perspectiveCamera?: BCFPerspectiveCamera;
  /** Orthographic camera settings */
  orthogonalCamera?: BCFOrthogonalCamera;
  /** Lines markup (3D annotations) */
  lines?: BCFLine[];
  /** Clipping planes (section cuts) */
  clippingPlanes?: BCFClippingPlane[];
  /** Bitmaps (image annotations) */
  bitmaps?: BCFBitmap[];
  /** Snapshot image (PNG or JPG) as data URL or filename */
  snapshot?: string;
  /** Snapshot data as Uint8Array for export */
  snapshotData?: Uint8Array;
  /** Component visibility and selection */
  components?: BCFComponents;
}

// ============================================================================
// BCF Camera Types
// ============================================================================

export interface BCFPoint {
  x: number;
  y: number;
  z: number;
}

export interface BCFDirection {
  x: number;
  y: number;
  z: number;
}

export interface BCFPerspectiveCamera {
  /** Camera position in world coordinates */
  cameraViewPoint: BCFPoint;
  /** Camera viewing direction (normalized) */
  cameraDirection: BCFDirection;
  /** Camera up vector (normalized) */
  cameraUpVector: BCFDirection;
  /** Vertical field of view in degrees (typically 45-60) */
  fieldOfView: number;
  /** Aspect ratio (optional, BCF 3.0) */
  aspectRatio?: number;
}

export interface BCFOrthogonalCamera {
  /** Camera position in world coordinates */
  cameraViewPoint: BCFPoint;
  /** Camera viewing direction (normalized) */
  cameraDirection: BCFDirection;
  /** Camera up vector (normalized) */
  cameraUpVector: BCFDirection;
  /** View-to-world scale factor */
  viewToWorldScale: number;
  /** Aspect ratio (optional, BCF 3.0) */
  aspectRatio?: number;
}

// ============================================================================
// BCF Markup Elements
// ============================================================================

export interface BCFLine {
  /** Start point in 3D world coordinates */
  startPoint: BCFPoint;
  /** End point in 3D world coordinates */
  endPoint: BCFPoint;
}

export interface BCFClippingPlane {
  /** Point on the clipping plane */
  location: BCFPoint;
  /** Normal direction of the clipping plane */
  direction: BCFDirection;
}

export interface BCFBitmap {
  /** Bitmap format (PNG or JPG) */
  format: 'PNG' | 'JPG';
  /** Reference to the bitmap file in the BCF archive */
  reference: string;
  /** Center location in world coordinates */
  location: BCFPoint;
  /** Normal vector of the bitmap plane */
  normal: BCFDirection;
  /** Up vector of the bitmap */
  up: BCFDirection;
  /** Height of the bitmap in world units */
  height: number;
}

// ============================================================================
// BCF Components (Visibility/Selection/Coloring)
// ============================================================================

export interface BCFComponents {
  /** Components to select/highlight */
  selection?: BCFComponent[];
  /** Visibility settings */
  visibility?: BCFVisibility;
  /** Coloring settings */
  coloring?: BCFColoring[];
}

export interface BCFComponent {
  /** IFC GlobalId (22-character base64 encoded GUID) */
  ifcGuid?: string;
  /** Fallback: authoring tool's internal ID */
  authoringToolId?: string;
  /** Originating system identifier */
  originatingSystem?: string;
}

export interface BCFVisibility {
  /** Default visibility for all components */
  defaultVisibility: boolean;
  /** Components that are exceptions to the default visibility */
  exceptions?: BCFComponent[];
  /** View setup hints for the viewer */
  viewSetupHints?: BCFViewSetupHints;
}

export interface BCFViewSetupHints {
  spacesVisible?: boolean;
  spaceBoundariesVisible?: boolean;
  openingsVisible?: boolean;
}

export interface BCFColoring {
  /** ARGB color in hex format (e.g., 'FFFF0000' for red) */
  color: string;
  /** Components to apply this color to */
  components: BCFComponent[];
}

// ============================================================================
// BCF Version Info
// ============================================================================

export interface BCFVersion {
  versionId: '2.1' | '3.0';
  detailedVersion?: string;
}

// ============================================================================
// Header file references
// ============================================================================

export interface BCFHeaderFile {
  /** IFC project GUID */
  ifcProject?: string;
  /** IFC spatial structure element GUID */
  ifcSpatialStructureElement?: string;
  /** Is the file reference external? */
  isExternal?: boolean;
  /** Filename or URL */
  filename?: string;
  /** Date the file was created */
  date?: string;
  /** Reference to the IFC file */
  reference?: string;
}
