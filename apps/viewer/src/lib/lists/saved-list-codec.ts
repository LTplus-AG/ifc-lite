/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import { migrateLegacyListDefinition, type ListDefinition } from '@ifc-lite/lists';
import { isCapturedEntityScope } from '@ifc-lite/rules';

/** Keep scoped serialized data unreadable to old engines that ignore capture (#7186). */
export function encodeSavedList(definition: ListDefinition): unknown {
  return definition.capturedScope
    ? { format: 'ifc-lite-captured-list', version: 1, definition }
    : definition;
}

export function decodeSavedList(value: unknown, importedAt?: number): ListDefinition {
  if (value !== null && typeof value === 'object' && !Array.isArray(value)
    && 'format' in value && value.format === 'ifc-lite-captured-list') {
    if (!('version' in value) || value.version !== 1 || !('definition' in value)
      || value.definition === null || typeof value.definition !== 'object'
      || !('capturedScope' in value.definition) || !isCapturedEntityScope(value.definition.capturedScope)) {
      throw new Error('Invalid captured list file; its captured population cannot be read.');
    }
    value = value.definition;
  }
  if (importedAt !== undefined && value !== null && typeof value === 'object' && !Array.isArray(value)) {
    value = { ...value, createdAt: importedAt, updatedAt: importedAt };
  }
  return migrateLegacyListDefinition(value);
}
