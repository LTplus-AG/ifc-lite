/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { getAttributeXsdTypes } from '@ifc-lite/data';
import { getReference } from './attribute-helpers.js';
import { getAttributeTypeForSchema } from './ifc-schema.js';
import { getSchemaRegistryForVersion } from './generated/schema-registry-by-version.js';

/** Native edit values as the STEP reader observes them after serialization (#7195). */
export function positionalMetadataValue(value: unknown): unknown {
  if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
    if ('real' in value) return value.real;
    if ('typed' in value && value.typed !== null && typeof value.typed === 'object'
      && 'type' in value.typed && 'value' in value.typed && typeof value.typed.type === 'string') {
      return [value.typed.type.toUpperCase(), value.typed.value];
    }
  }
  if (typeof value !== 'string') return value;
  const token = value.trim();
  if (token === '$') return null;
  if (token === '*') return '*';
  // Public '#id' references become numeric source references, including in
  // positional STRING slots: only named STRING edits force literal quoting.
  return /^#\d+$/.test(token) ? getReference(token) ?? value : value;
}

export function namedMetadataValue(value: string, type: string, name: string, schema: string | undefined): unknown {
  const version = schema === 'IFC2X3' ? 'IFC2X3' : schema?.startsWith('IFC4X3') ? 'IFC4X3' : 'IFC4';
  const declared = getAttributeTypeForSchema(type, name, schema);
  const registry = getSchemaRegistryForVersion(version);
  if (declared && Object.hasOwn(registry.enums, declared)) {
    const token = value.trim();
    if (token === '$' || token === '') return null;
    if (token === '*') return '*';
    return `.${token.replace(/^\.|\.$/g, '').toUpperCase()}.`;
  }
  const xsd = getAttributeXsdTypes(version, type, name);
  if (xsd?.includes('xs:double') && !xsd.includes('xs:integer')) {
    const token = value.trim();
    if (token === '') return null;
    const number = Number(token);
    if (Number.isFinite(number)) return number;
  }
  // Native named STRING overrides preserve whitespace and explicit empty text.
  return value === '$' ? null : value;
}
