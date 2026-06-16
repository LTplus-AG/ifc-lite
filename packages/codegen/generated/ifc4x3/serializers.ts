/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * IFC Serialization Support
 * Generated from EXPRESS schema: IFC4X3_DEV_923b0514
 *
 * Thin binding over the shared, schema-agnostic STEP serializer in
 * `@ifc-lite/data`. All serialization logic lives there (single source of
 * truth); only this bundle's `SCHEMA_REGISTRY` is bound to the registry-coupled
 * helpers below.
 *
 * DO NOT EDIT - This file is auto-generated
 */

import { SCHEMA_REGISTRY } from './schema-registry.js';
import {
  generateHeader,
  generateStepFileWithRegistry,
  toStepLineWithRegistry,
  type StepEntity,
} from '@ifc-lite/data';

export {
  isEntityRef,
  isEnumValue,
  ref,
  enumVal,
  serializeValue,
  generateHeader,
  parseStepValue,
} from '@ifc-lite/data';
export type { StepValue, EntityRef, EnumValue, StepEntity } from '@ifc-lite/data';

/**
 * Serialize an entity to a STEP line (bound to this bundle's schema).
 */
export function toStepLine(entity: StepEntity): string {
  return toStepLineWithRegistry(SCHEMA_REGISTRY, entity);
}

/**
 * Generate complete STEP file content (bound to this bundle's schema).
 */
export function generateStepFile(
  entities: StepEntity[],
  options: Parameters<typeof generateHeader>[0]
): string {
  return generateStepFileWithRegistry(SCHEMA_REGISTRY, entities, options);
}
