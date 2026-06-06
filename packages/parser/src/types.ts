/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Core types for IFC parsing
 */

export interface EntityRef {
  expressId: number;
  type: string;
  byteOffset: number;
  byteLength: number;
  lineNumber: number;
}

export interface EntityIndex {
  byId: Map<number, EntityRef>;
  byType: Map<string, number[]>;
}

import type { IfcEntity } from '@ifc-lite/data';
export type { IfcAttributeValue, IfcEntity } from '@ifc-lite/data';

export interface PropertyValue {
  type: 'string' | 'number' | 'boolean' | 'null' | 'reference';
  value: string | number | boolean | null | number;
}

export interface PropertySet {
  name: string;
  properties: Map<string, PropertyValue>;
}

export interface Relationship {
  type: string;
  relatingObject: number;
  relatedObjects: number[];
  attributes?: Record<string, any>;
}

export interface ParseResult {
  entities: Map<number, IfcEntity>;
  propertySets: Map<number, PropertySet>;
  relationships: Relationship[];
  entityIndex: EntityIndex;
  fileSize: number;
  entityCount: number;
}
