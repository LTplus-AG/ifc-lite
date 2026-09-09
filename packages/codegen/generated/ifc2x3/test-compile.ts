/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Type-check test file
 * This file is used to verify the generated types compile correctly.
 *
 * DO NOT EDIT - This file is auto-generated
 */

import type { IfcWall, IfcProject, IfcExtrudedAreaSolid } from './entities.js';
import { TYPE_IDS, getTypeId, getTypeName } from './type-ids.js';
import { SCHEMA_REGISTRY, getEntityMetadata } from './schema-registry.js';
import { toStepLine, serializeValue, ref, enumVal, type StepEntity } from './serializers.js';

// Test type IDs
const wallId: number = TYPE_IDS.IfcWall;
const projectId: number = TYPE_IDS.IfcProject;

// Test ID lookup
const wallIdFromName = getTypeId('IfcWall');
const nameFromId = getTypeName(wallId);

// Test schema registry
const wallMeta = getEntityMetadata('IfcWall');
const wallAttrs = wallMeta?.allAttributes;

// Test serialization
const testEntity: StepEntity = {
  expressId: 1,
  type: 'IfcProject',
  GlobalId: '0YvctVUKr0kugbFTf53O9L',
  OwnerHistory: ref(2),
  Name: 'Test Project',
  Description: null,
  ObjectType: null,
  LongName: null,
  Phase: null,
  RepresentationContexts: [ref(3)],
  UnitsInContext: ref(4),
};

const stepLine = toStepLine(testEntity);

console.log('✓ All types compile correctly');
console.log('  Wall ID:', wallId);
console.log('  Project ID:', projectId);
console.log('  STEP line:', stepLine);
