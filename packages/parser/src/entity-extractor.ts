/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Entity extractor - parses full entity content from STEP format
 */

import { createLogger } from '@ifc-lite/data';
import { decodeIfcString } from '@ifc-lite/encoding';
import type { IfcEntity, EntityRef } from './types.js';
import { safeUtf8Decode } from '@ifc-lite/data';

export type { IfcEntity };

const log = createLogger('EntityExtractor');

/** Maximum recursion depth for parsing nested structures (prevents DoS via deeply nested data) */
const MAX_PARSE_DEPTH = 100;

export class EntityExtractor {
  private buffer: Uint8Array;

  constructor(buffer: Uint8Array) {
    this.buffer = buffer;
  }

  /**
   * Extract full entity data from a reference
   */
  extractEntity(ref: EntityRef): IfcEntity | null {
    try {
      const entityText = safeUtf8Decode(
        this.buffer,
        ref.byteOffset,
        ref.byteOffset + ref.byteLength,
      );

      // Parse: #ID = TYPE(attr1, attr2, ...)
      const match = entityText.match(/^#(\d+)\s*=\s*(\w+)\((.*)\)/);
      if (!match) return null;

      const expressId = parseInt(match[1], 10);
      const type = match[2];
      const paramsText = match[3];

      // Parse attributes (simplified - handles basic types)
      const attributes = this.parseAttributes(paramsText);

      return {
        expressId,
        type,
        attributes,
      };
    } catch (error) {
      log.error('Failed to extract entity', error, {
        operation: 'extractEntity',
        entityId: ref.expressId,
        entityType: ref.type,
      });
      return null;
    }
  }

  private parseAttributes(paramsText: string): any[] {
    if (!paramsText.trim()) return [];

    const attributes: any[] = [];
    let depth = 0;
    let current = '';
    let inString = false;

    for (let i = 0; i < paramsText.length; i++) {
      const char = paramsText[i];

      if (char === "'") {
        if (inString) {
          // Check for escaped quote ('') - STEP uses doubled quotes
          if (i + 1 < paramsText.length && paramsText[i + 1] === "'") {
            current += "''"; // Keep the escaped quote
            i++; // Skip next quote
            continue;
          }
          inString = false;
        } else {
          inString = true;
        }
        current += char;
      } else if (inString) {
        current += char;
      } else if (char === '(') {
        depth++;
        current += char;
      } else if (char === ')') {
        depth--;
        current += char;
      } else if (char === ',' && depth === 0) {
        // End of attribute
        attributes.push(this.parseAttributeValue(current.trim()));
        current = '';
      } else {
        current += char;
      }
    }

    // Add last attribute
    if (current.trim()) {
      attributes.push(this.parseAttributeValue(current.trim()));
    }

    return attributes;
  }

  private parseAttributeValue(value: string, depth: number = 0): any {
    // Guard against deeply nested structures (potential DoS vector)
    if (depth > MAX_PARSE_DEPTH) {
      log.warn('Maximum parse depth exceeded - truncating nested structure', {
        operation: 'parseAttributeValue',
        data: { depth, valuePreview: value.slice(0, 50) },
      });
      return null;
    }

    value = value.trim();

    if (!value || value === '$') {
      return null;
    }

    // TypedValue: IFCTYPENAME(value) - must check before list check
    // Pattern: identifier followed by parentheses (e.g., IFCNORMALISEDRATIOMEASURE(0.5))
    const typedValueMatch = value.match(/^([A-Z][A-Z0-9_]*)\((.+)\)$/i);
    if (typedValueMatch) {
      const typeName = typedValueMatch[1];
      const innerValue = typedValueMatch[2].trim();
      // Return as array [typeName, parsedValue] to match Rust structure
      return [typeName, this.parseAttributeValue(innerValue, depth + 1)];
    }

    // List/Array: (#123) or (#123, #456) or ()
    if (value.startsWith('(') && value.endsWith(')')) {
      const listContent = value.slice(1, -1).trim();
      if (!listContent) {
        return []; // Empty list
      }

      // Parse list items (comma-separated)
      const items: any[] = [];
      let parenDepth = 0;
      let current = '';

      for (let i = 0; i < listContent.length; i++) {
        const char = listContent[i];

        if (char === '(') {
          parenDepth++;
          current += char;
        } else if (char === ')') {
          parenDepth--;
          current += char;
        } else if (char === ',' && parenDepth === 0) {
          // End of item
          const itemValue = current.trim();
          if (itemValue) {
            items.push(this.parseAttributeValue(itemValue, depth + 1));
          }
          current = '';
        } else {
          current += char;
        }
      }

      // Add last item
      if (current.trim()) {
        items.push(this.parseAttributeValue(current.trim(), depth + 1));
      }

      return items;
    }

    // Reference: #123
    if (value.startsWith('#')) {
      const id = parseInt(value.substring(1), 10);
      return isNaN(id) ? null : id;
    }

    // String: 'text'
    if (value.startsWith("'") && value.endsWith("'")) {
      // STEP uses doubled quotes ('') for escaping, not backslash
      const raw = value.slice(1, -1).replace(/''/g, "'");
      // Decode IFC STEP encoded characters (\X2\00FC\X0\ -> ü, etc.)
      return decodeIfcString(raw);
    }

    // Number
    const num = parseFloat(value);
    if (!isNaN(num)) {
      return num;
    }

    // Enumeration or other identifier
    return value;
  }
}
