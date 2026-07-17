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

/**
 * Is this raw source token a bare STEP enumeration token (`.USERDEFINED.`,
 * `.T.`, `.FLAT_ROOF.`)? Mirrors the Rust tokenizer's `enum_value` rule —
 * `'.' [A-Za-z0-9_]+ '.'` — so client and server classify the token KIND
 * identically (#1799). Must be called on the token as it appears in the
 * source (before quote-stripping): a quoted string `'.USERDEFINED.'` starts
 * with a quote and is never flagged. Char-code loop, no per-call allocation.
 */
function isBareEnumToken(token: string): boolean {
  const n = token.length;
  if (n < 3 || token.charCodeAt(0) !== 0x2e /* . */ || token.charCodeAt(n - 1) !== 0x2e) {
    return false;
  }
  for (let i = 1; i < n - 1; i++) {
    const c = token.charCodeAt(i);
    const alnum =
      (c >= 0x30 && c <= 0x39) || // 0-9
      (c >= 0x41 && c <= 0x5a) || // A-Z
      (c >= 0x61 && c <= 0x7a) || // a-z
      c === 0x5f; // _
    if (!alnum) return false;
  }
  return true;
}

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
      // [\s\S] (not `.`) so records whose attribute list spans multiple
      // source lines still match — `.` stops at the first newline and made
      // extractEntity return null for ANY multi-line STEP record (lost
      // storey/covering names + the on-demand attribute fallback).
      const match = entityText.match(/^#(\d+)\s*=\s*(\w+)\(([\s\S]*)\)/);
      if (!match) return null;

      const expressId = parseInt(match[1], 10);
      const type = match[2];
      const paramsText = match[3];

      // Parse attributes (simplified - handles basic types)
      const { attributes, enumAttrIndices } = this.parseAttributes(paramsText);

      const entity: IfcEntity = {
        expressId,
        type,
        attributes,
      };
      // Token-kind side channel (#1799): only attached when at least one
      // top-level attribute was a bare enum, so the common case allocates
      // nothing extra and the object shape stays stable for most entities.
      if (enumAttrIndices) entity.enumAttrIndices = enumAttrIndices;
      return entity;
    } catch (error) {
      log.error('Failed to extract entity', error, {
        operation: 'extractEntity',
        entityId: ref.expressId,
        entityType: ref.type,
      });
      return null;
    }
  }

  private parseAttributes(paramsText: string): {
    attributes: any[];
    enumAttrIndices?: number[];
  } {
    if (!paramsText.trim()) return { attributes: [] };

    const attributes: any[] = [];
    // Indices of top-level attributes whose source token was a bare enum
    // (`.USERDEFINED.`). Lazily allocated — undefined when the entity has none.
    // Kind is decided on the RAW token, before parseAttributeValue strips
    // quotes, so `'.USERDEFINED.'` (a genuine string) is never flagged (#1799).
    let enumAttrIndices: number[] | undefined;
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
        const token = current.trim();
        if (isBareEnumToken(token)) (enumAttrIndices ??= []).push(attributes.length);
        attributes.push(this.parseAttributeValue(token));
        current = '';
      } else {
        current += char;
      }
    }

    // Add last attribute
    const lastToken = current.trim();
    if (lastToken) {
      if (isBareEnumToken(lastToken)) (enumAttrIndices ??= []).push(attributes.length);
      attributes.push(this.parseAttributeValue(lastToken));
    }

    return { attributes, enumAttrIndices };
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
    // Pattern: identifier followed by parentheses (e.g., IFCNORMALISEDRATIOMEASURE(0.5)).
    // The `s` (dotall) flag lets `.+` span line terminators so a wrapped value —
    // e.g. an IFCLABEL/IFCTEXT string an authoring tool broke across physical
    // lines — is still unwrapped. Without it the match fails and the raw
    // `IFCLABEL('...')` literal (mis-typed as a plain string) leaks to callers.
    const typedValueMatch = value.match(/^([A-Z][A-Z0-9_]*)\((.+)\)$/is);
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
      let inString = false;

      for (let i = 0; i < listContent.length; i++) {
        const char = listContent[i];

        if (char === "'") {
          if (inString) {
            // Check for escaped quote ('') - STEP uses doubled quotes
            if (i + 1 < listContent.length && listContent[i + 1] === "'") {
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
