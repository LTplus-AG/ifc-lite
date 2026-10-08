/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The JSON Schema subset the AI evaluation schemas use (#6928), interpreted
 * directly so the committed `*.schema.json` files are the single source of
 * truth for structure (editors read them; the gates enforce them) without a
 * schema-library dependency.
 *
 * Supported keywords: type (string or list), required, properties,
 * additionalProperties (boolean or schema), items, minItems, maxItems, enum,
 * const, pattern, minLength, maxLength, minimum, maximum, oneOf, $ref to
 * `#/$defs/<name>`. Any other keyword is REFUSED rather than ignored, so a
 * schema edit can never silently stop being enforced.
 */

const SUPPORTED = new Set(['$schema', '$id', '$defs', '$ref', 'title', 'description', 'type', 'required', 'properties',
  'additionalProperties', 'items', 'minItems', 'maxItems', 'enum', 'const', 'pattern', 'minLength', 'maxLength',
  'minimum', 'maximum', 'oneOf']);

function typeOf(value) {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  if (Number.isInteger(value)) return 'integer';
  return typeof value;
}

function typeMatches(value, type) {
  const actual = typeOf(value);
  return actual === type || (type === 'number' && actual === 'integer');
}

/** Errors as `path: message` strings; empty when `value` conforms. */
export function validateSchema(schema, value, root = schema, path = '$') {
  for (const key of Object.keys(schema)) {
    if (!SUPPORTED.has(key)) throw new Error(`${path}: schema keyword "${key}" is not supported by schema-subset.mjs`);
  }
  if (schema.$ref) {
    const name = /^#\/\$defs\/([\w-]+)$/.exec(schema.$ref)?.[1];
    const target = name ? root.$defs?.[name] : undefined;
    if (!target) throw new Error(`${path}: unresolvable $ref ${schema.$ref}`);
    return validateSchema(target, value, root, path);
  }
  const errors = [];
  if (schema.oneOf) {
    const passing = schema.oneOf.filter(option => validateSchema(option, value, root, path).length === 0).length;
    if (passing !== 1) errors.push(`${path}: must match exactly one alternative (matched ${passing})`);
    return errors;
  }
  if (schema.type) {
    const types = Array.isArray(schema.type) ? schema.type : [schema.type];
    if (!types.some(type => typeMatches(value, type))) return [`${path}: expected ${types.join(' or ')}, got ${typeOf(value)}`];
  }
  if ('const' in schema && JSON.stringify(value) !== JSON.stringify(schema.const)) errors.push(`${path}: must equal ${JSON.stringify(schema.const)}`);
  if (schema.enum && !schema.enum.some(option => JSON.stringify(option) === JSON.stringify(value))) {
    errors.push(`${path}: must be one of ${schema.enum.map(option => JSON.stringify(option)).join(', ')}`);
  }
  if (typeof value === 'string') {
    if (schema.pattern && !new RegExp(schema.pattern, 'u').test(value)) errors.push(`${path}: does not match ${schema.pattern}`);
    if (schema.minLength !== undefined && value.length < schema.minLength) errors.push(`${path}: shorter than ${schema.minLength}`);
    if (schema.maxLength !== undefined && value.length > schema.maxLength) errors.push(`${path}: longer than ${schema.maxLength}`);
  }
  if (typeof value === 'number') {
    if (schema.minimum !== undefined && value < schema.minimum) errors.push(`${path}: below ${schema.minimum}`);
    if (schema.maximum !== undefined && value > schema.maximum) errors.push(`${path}: above ${schema.maximum}`);
  }
  if (Array.isArray(value)) {
    if (schema.minItems !== undefined && value.length < schema.minItems) errors.push(`${path}: fewer than ${schema.minItems} items`);
    if (schema.maxItems !== undefined && value.length > schema.maxItems) errors.push(`${path}: more than ${schema.maxItems} items`);
    if (schema.items) value.forEach((item, index) => errors.push(...validateSchema(schema.items, item, root, `${path}[${index}]`)));
  }
  if (typeOf(value) === 'object') {
    for (const name of schema.required ?? []) if (!Object.hasOwn(value, name)) errors.push(`${path}: missing required "${name}"`);
    const properties = schema.properties ?? {};
    for (const [name, child] of Object.entries(value)) {
      if (Object.hasOwn(properties, name)) errors.push(...validateSchema(properties[name], child, root, `${path}.${name}`));
      else if (schema.additionalProperties === false) errors.push(`${path}: unexpected property "${name}"`);
      else if (typeof schema.additionalProperties === 'object') errors.push(...validateSchema(schema.additionalProperties, child, root, `${path}.${name}`));
    }
  }
  return errors;
}
