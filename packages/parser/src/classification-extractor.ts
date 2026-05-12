/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Classification Extractor
 *
 * Extracts IFC classification information.
 *
 * Classification systems in IFC:
 * - IfcClassification: The classification system itself (e.g., Uniclass, Omniclass, MasterFormat)
 * - IfcClassificationReference: Reference to a specific class in the system
 * - IfcRelAssociatesClassification: Associates classifications with elements
 *
 * Common classification systems:
 * - Uniclass 2015 (UK)
 * - Omniclass (North America)
 * - MasterFormat (North America)
 * - Uniformat (North America)
 * - DIN 276 (Germany)
 * - SfB (Sweden/Denmark)
 */

import type { IfcEntity } from './entity-extractor.js';
import { getString, getReference, getReferences, getStringList } from './attribute-helpers.js';

export interface Classification {
  id: number;
  name: string;
  source?: string;
  edition?: string;
  editionDate?: string;
  description?: string;
  location?: string;  // URL or file path
  referenceTokens?: string[];  // List of reference identifiers
}

export interface ClassificationReference {
  id: number;
  location?: string;  // URL or identifier
  identification?: string;  // Class code (e.g., "Pr_60_10_32")
  name?: string;      // Class name (e.g., "External wall")
  referencedSource?: number;  // Classification or parent ClassificationReference ID
  description?: string;
  sort?: string;      // Sort key for ordering
}

export interface ClassificationAssociation {
  relationshipId: number;
  classificationId: number;  // ClassificationReference ID
  relatedObjects: number[];  // Element IDs
}

export interface ClassificationsData {
  classifications: Map<number, Classification>;
  classificationReferences: Map<number, ClassificationReference>;
  associations: ClassificationAssociation[];
}

/**
 * Extract classifications from IFC entities
 */
export function extractClassifications(
  entities: Map<number, IfcEntity>,
  entitiesByType: Map<string, number[]>
): ClassificationsData {
  const data: ClassificationsData = {
    classifications: new Map(),
    classificationReferences: new Map(),
    associations: [],
  };

  // Extract IfcClassification
  const classificationIds = entitiesByType.get('IfcClassification') || [];
  for (const id of classificationIds) {
    const entity = entities.get(id);
    if (entity) {
      data.classifications.set(id, extractClassification(entity));
    }
  }

  // Extract IfcClassificationReference
  const referenceIds = entitiesByType.get('IfcClassificationReference') || [];
  for (const id of referenceIds) {
    const entity = entities.get(id);
    if (entity) {
      data.classificationReferences.set(id, extractClassificationReference(entity));
    }
  }

  // Extract IfcRelAssociatesClassification
  const relIds = entitiesByType.get('IfcRelAssociatesClassification') || [];
  for (const id of relIds) {
    const entity = entities.get(id);
    if (entity) {
      const association = extractClassificationAssociation(entity);
      if (association) {
        data.associations.push(association);
      }
    }
  }

  return data;
}

function extractClassification(entity: IfcEntity): Classification {
  // IfcClassification attributes (IFC4):
  // [0] Source (OPTIONAL IfcLabel)
  // [1] Edition (OPTIONAL IfcLabel)
  // [2] EditionDate (OPTIONAL IfcDate)
  // [3] Name (IfcLabel)
  // [4] Description (OPTIONAL IfcText)
  // [5] Location (OPTIONAL IfcURIReference)
  // [6] ReferenceTokens (OPTIONAL LIST OF IfcIdentifier)

  return {
    id: entity.expressId,
    source: getString(entity.attributes[0]),
    edition: getString(entity.attributes[1]),
    editionDate: getString(entity.attributes[2]),
    name: getString(entity.attributes[3]) || '',
    description: getString(entity.attributes[4]),
    location: getString(entity.attributes[5]),
    referenceTokens: getStringList(entity.attributes[6]),
  };
}

function extractClassificationReference(entity: IfcEntity): ClassificationReference {
  // IfcClassificationReference attributes (IFC4):
  // [0] Location (OPTIONAL IfcURIReference)
  // [1] Identification (OPTIONAL IfcIdentifier)
  // [2] Name (OPTIONAL IfcLabel)
  // [3] ReferencedSource (OPTIONAL IfcClassificationReferenceSelect)
  // [4] Description (OPTIONAL IfcText)
  // [5] Sort (OPTIONAL IfcIdentifier)

  return {
    id: entity.expressId,
    location: getString(entity.attributes[0]),
    identification: getString(entity.attributes[1]),
    name: getString(entity.attributes[2]),
    referencedSource: getReference(entity.attributes[3]),
    description: getString(entity.attributes[4]),
    sort: getString(entity.attributes[5]),
  };
}

function extractClassificationAssociation(entity: IfcEntity): ClassificationAssociation | null {
  // IfcRelAssociatesClassification attributes:
  // [0] GlobalId
  // [1] OwnerHistory
  // [2] Name
  // [3] Description
  // [4] RelatedObjects (list of elements)
  // [5] RelatingClassification (ClassificationReference or Classification)

  const relatedObjects = getReferences(entity.attributes[4]) || [];
  const classificationRef = getReference(entity.attributes[5]);

  if (!classificationRef) {
    return null;
  }

  return {
    relationshipId: entity.expressId,
    classificationId: classificationRef,
    relatedObjects,
  };
}

/**
 * Get classifications for an element
 */
export function getClassificationsForElement(
  elementId: number,
  classificationsData: ClassificationsData
): ClassificationReference[] {
  const results: ClassificationReference[] = [];

  // Find all associations for this element
  for (const assoc of classificationsData.associations) {
    if (assoc.relatedObjects.includes(elementId)) {
      const ref = classificationsData.classificationReferences.get(assoc.classificationId);
      if (ref) {
        results.push(ref);
      }
    }
  }

  return results;
}

/**
 * Get classification code for an element (first classification found)
 */
export function getClassificationCodeForElement(
  elementId: number,
  classificationsData: ClassificationsData
): string | undefined {
  const classifications = getClassificationsForElement(elementId, classificationsData);
  return classifications[0]?.identification;
}

/**
 * Get full classification path (e.g., "Pr_60 > Pr_60_10 > Pr_60_10_32")
 */
export function getClassificationPath(
  classificationRefId: number,
  classificationsData: ClassificationsData
): string[] {
  const path: string[] = [];
  let currentId: number | undefined = classificationRefId;

  // Walk up the reference chain
  while (currentId !== undefined) {
    const ref = classificationsData.classificationReferences.get(currentId);
    if (!ref) break;

    // Add identification or name to path
    const code = ref.identification || ref.name;
    if (code) {
      path.unshift(code);  // Add to front
    }

    // Move to parent
    currentId = ref.referencedSource;

    // Stop if we reached a Classification (not a ClassificationReference)
    if (currentId && !classificationsData.classificationReferences.has(currentId)) {
      // This is a Classification, add its name
      const classification = classificationsData.classifications.get(currentId);
      if (classification) {
        path.unshift(classification.name);
      }
      break;
    }
  }

  return path;
}

/**
 * Group elements by classification
 */
export function groupElementsByClassification(
  classificationsData: ClassificationsData
): Map<string, number[]> {
  const groups = new Map<string, number[]>();

  for (const assoc of classificationsData.associations) {
    const ref = classificationsData.classificationReferences.get(assoc.classificationId);
    const code = ref?.identification || ref?.name || 'Unclassified';

    const existing = groups.get(code) || [];
    existing.push(...assoc.relatedObjects);
    groups.set(code, existing);
  }

  return groups;
}

/**
 * Get classification system name
 */
export function getClassificationSystemName(
  classificationRefId: number,
  classificationsData: ClassificationsData
): string | undefined {
  // Walk up to find the root Classification
  let currentId: number | undefined = classificationRefId;

  while (currentId !== undefined) {
    // Check if this is a Classification
    const classification = classificationsData.classifications.get(currentId);
    if (classification) {
      return classification.name;
    }

    // Otherwise, get the parent reference
    const ref = classificationsData.classificationReferences.get(currentId);
    if (!ref || !ref.referencedSource) break;

    currentId = ref.referencedSource;
  }

  return undefined;
}

