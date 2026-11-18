/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import Ajv from 'ajv';
import type { GraphicOverrideRule } from '@ifc-lite/drawing-2d';
const scalar = { anyOf: [{ type: 'string', maxLength: 10000 }, { type: 'number' }, { type: 'boolean' }, { type: 'array', maxItems: 1000, items: { type: 'string', maxLength: 10000 } }, { type: 'array', maxItems: 1000, items: { type: 'number' } }] };
const color = { type: 'string', pattern: '^#[0-9a-fA-F]{6}([0-9a-fA-F]{2})?$' };
const positive = { type: 'number', exclusiveMinimum: 0, maximum: 1000000 };
const lineStyle = { type: 'string', enum: ['solid', 'dashed', 'dotted', 'dashdot', 'center'] };
const validate = new Ajv({ strict: true }).compile<GraphicOverrideRule>({
  type: 'object', properties: { id: { type: 'string', minLength: 1, maxLength: 200 }, name: { type: 'string', minLength: 1, maxLength: 10000 }, description: { type: 'string', maxLength: 10000 }, enabled: { type: 'boolean' }, priority: { type: 'number', minimum: -1000000, maximum: 1000000 }, criteria: { $ref: '#/$defs/criteria' },
    style: { type: 'object', properties: { fillColor: color, strokeColor: color, backgroundColor: color, lineWeight: { anyOf: [{ type: 'string', enum: ['heavy', 'medium', 'light', 'hairline'] }, positive] }, lineStyle: { anyOf: [lineStyle, { type: 'object', properties: { preset: lineStyle, custom: { type: 'array', items: positive, minItems: 2, maxItems: 20 } }, additionalProperties: false }] }, lineCap: { type: 'string', enum: ['butt', 'round', 'square'] }, lineJoin: { type: 'string', enum: ['miter', 'round', 'bevel'] }, hatchPattern: { type: 'string', enum: ['solid', 'diagonal', 'cross-hatch', 'horizontal', 'vertical', 'brick', 'concrete', 'insulation', 'earth', 'wood', 'steel', 'glass', 'none'] }, hatchSpacing: positive, hatchAngle: { type: 'number' }, hatchSecondaryAngle: { type: 'number' }, hatchColor: color, hatchLineWeight: positive, visible: { type: 'boolean' }, opacity: { type: 'number', minimum: 0, maximum: 1 }, drawOrder: { type: 'number' } }, additionalProperties: false },
    category: { type: 'string', maxLength: 1000 }, tags: { type: 'array', maxItems: 100, items: { type: 'string', maxLength: 1000 } },
  }, required: ['id', 'name', 'enabled', 'priority', 'criteria', 'style'], additionalProperties: false,
  $defs: { criteria: { anyOf: [{ type: 'object', properties: { logic: { type: 'string', enum: ['and', 'or'] }, conditions: { type: 'array', items: { $ref: '#/$defs/criteria' }, minItems: 1, maxItems: 100 } }, required: ['logic', 'conditions'], additionalProperties: false },
    { type: 'object', properties: { type: { type: 'string', enum: ['ifcType', 'property', 'propertySet', 'expressId', 'modelId', 'all'] }, ifcTypes: { type: 'array', maxItems: 1000, items: { type: 'string', pattern: '^(Ifc|IFC)[A-Za-z0-9]+$' } }, includeSubtypes: { type: 'boolean' }, propertySet: { type: 'string', maxLength: 10000 }, propertyName: { type: 'string', maxLength: 10000 }, operator: { type: 'string', enum: ['equals', 'notEquals', 'contains', 'notContains', 'startsWith', 'endsWith', 'greaterThan', 'lessThan', 'greaterOrEqual', 'lessOrEqual', 'exists', 'notExists', 'in', 'notIn'] }, value: scalar, expressIds: { type: 'array', maxItems: 1000, items: { type: 'integer', minimum: 1 } }, modelIds: { type: 'array', maxItems: 100, items: { type: 'string', minLength: 1, maxLength: 200 } } }, required: ['type'], additionalProperties: false }] } },
});
/** Bound the evaluator's recursive criteria before invoking recursive schema validation. */
export function parseGraphicRule(text: string): GraphicOverrideRule {
  const value: unknown = JSON.parse(text);
  const stack: { value: unknown; depth: number }[] = [{ value, depth: 0 }]; let budget = 10000;
  while (stack.length) {
    const next = stack.pop(); if (!next) break;
    if (--budget < 0 || next.depth > 32) throw new Error('Graphic override exceeds native criteria depth/work limits.');
    if (next.value && typeof next.value === 'object') for (const child of Object.values(next.value)) stack.push({ value: child, depth: next.depth + 1 });
  }
  if (!validate(value)) throw new Error(`Invalid native graphic override: ${JSON.stringify(validate.errors)}`);
  return value;
}
