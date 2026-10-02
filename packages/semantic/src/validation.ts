/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { Ajv, type ValidateFunction } from 'ajv';
import type { NodeObject } from 'jsonld';
import jsonld from 'jsonld';
import { Parser, Store } from 'n3';
import SHACLValidator from 'rdf-validate-shacl';
import ShapesGraph from 'rdf-validate-shacl/src/shapes-graph.js';
import { DEFAULT_PROFILE, assertProfile, assertBoundedPattern, isUri, type ProfileDefinition } from './profiles.js';
import { exchangeSchema, resourceSchema, profileContext, shapesTurtle } from './profile-artifacts.js';
import type { SemanticDocument, SemanticResource, ValidationFinding } from './profile-types.js';
import { LIMITS } from './types.js';
import { assertBoundedSubclasses, assertBoundedPropertyShapes, countShapeTargets } from './shacl-targets.js';

export { isUri } from './profiles.js';
function compiler() { const ajv = new Ajv({ allErrors: true }); ajv.addFormat('uri', isUri); return ajv; }
export function parseProfileDocument(value: unknown, profile = DEFAULT_PROFILE): SemanticDocument {
  const ajv = compiler(); const validate = ajv.compile<SemanticDocument>(exchangeSchema(profile, true));
  if (!validate(value)) throw new Error(ajv.errorsText(validate.errors));
  const ids = new Set<string>();
  for (const record of value.resources) {
    if (ids.has(record.id)) throw new Error(`Duplicate resource identifier: ${record.id}`);
    ids.add(record.id);
    for (const [key, field] of Object.entries(profile.fields)) if (field.kind === 'language' && record[key]) {
      const languages = Object.keys(record[key] as Record<string, string>).map(language => language.toLowerCase());
      if (new Set(languages).size !== languages.length) throw new Error(`Duplicate language tag on ${record.id}.${key}`);
    }
  }
  return value;
}
export const parseDocument = parseProfileDocument;
export function parseImport(value: unknown, profile = DEFAULT_PROFILE): SemanticDocument {
  return parseProfileDocument(value && typeof value === 'object' && 'document' in value ? value.document : value, profile);
}
export function validateJson(document: SemanticDocument, profile = DEFAULT_PROFILE): ValidationFinding[] {
  assertProfile(profile);
  const ajv = compiler(); const validators = new Map<string, ValidateFunction>();
  const findings: ValidationFinding[] = [];
  for (const resource of document.resources) {
    if (!Object.hasOwn(profile.types, resource.type)) findings.push({ engine: 'JSON Schema', resourceId: resource.id, path: 'type', message: `Unknown type: ${resource.type}` });
    else {
      let validate = validators.get(resource.type);
      if (!validate) { validate = ajv.compile(resourceSchema(resource.type, profile)); validators.set(resource.type, validate); }
      validate(resource);
      for (const error of validate.errors ?? []) {
        findings.push({ engine: 'JSON Schema', resourceId: resource.id,
          path: error.instancePath || String(error.params.missingProperty ?? ''), message: error.message ?? error.keyword });
        if (findings.length === LIMITS.findings) return findings;
      }
    }
    if (findings.length === LIMITS.findings) return findings;
  }
  return findings;
}
export function validateLinks(document: SemanticDocument, profile = DEFAULT_PROFILE): ValidationFinding[] {
  assertProfile(profile);
  const byId = new Map(document.resources.map(record => [record.id, record]));
  const findings: ValidationFinding[] = [];
  for (const record of document.resources) for (const key of Object.keys(profile.types[record.type]?.fields ?? {})) {
    const field = profile.fields[key];
    if (field.kind !== 'iri' || field.external || !record[key]) continue;
    const values = Array.isArray(record[key]) ? record[key] : [record[key]];
    for (const target of values) {
      const found = typeof target === 'string' ? byId.get(target) : undefined;
      const message = found && field.targetType && found.type !== field.targetType ? `Expected ${field.targetType}, found ${found.type}: ${String(target)}`
        : !found && document.completeness === 'complete' ? `Referenced resource is absent from this complete submission: ${String(target)}` : undefined;
      if (message) findings.push({ engine: 'links', resourceId: record.id, path: key, message });
      if (findings.length === LIMITS.findings) return findings;
    }
  }
  return findings;
}
export function validateProfileDocument(document: SemanticDocument, profile = DEFAULT_PROFILE): ValidationFinding[] {
  parseProfileDocument(document, profile);
  return [...validateJson(document, profile), ...validateLinks(document, profile)];
}
export function asJsonLd(document: SemanticDocument, profile = DEFAULT_PROFILE) {
  parseProfileDocument(document, profile);
  return { '@context': profileContext(profile), '@graph': document.resources.map(record => ({ ...record }) as NodeObject) };
}
export async function toRdf(document: SemanticDocument, profile = DEFAULT_PROFILE): Promise<string> {
  const value = await jsonld.toRDF(asJsonLd(document, profile), { format: 'application/n-quads',
    documentLoader: async () => { throw new Error('Remote JSON-LD contexts are disabled; use the generated inline context'); } });
  if (typeof value !== 'string') throw new Error('Expected N-Quads from JSON-LD conversion');
  return value;
}
export interface GraphValidationOptions { profile?: ProfileDefinition; shapes?: string; maxBytes?: number; maxQuads?: number; maxErrors?: number }
const SH = 'http://www.w3.org/ns/shacl#';
const RDF = 'http://www.w3.org/1999/02/22-rdf-syntax-ns#';
/** Intentionally bounded SHACL Core subset; reject executable, recursive and complex paths. */
const supported = new Set(['IRI', 'Literal', 'BlankNode', 'BlankNodeOrIRI', 'BlankNodeOrLiteral', 'IRIOrLiteral', 'Violation', 'Warning', 'Info', 'NodeShape', 'PropertyShape', 'targetClass', 'targetNode', 'targetSubjectsOf', 'targetObjectsOf', 'property', 'path', 'closed', 'ignoredProperties',
  'minCount', 'maxCount', 'maxLength', 'datatype', 'nodeKind', 'class', 'pattern', 'flags', 'in', 'minInclusive', 'maxInclusive', 'uniqueLang', 'languageIn', 'severity', 'message', 'name', 'description', 'deactivated']);
function parseBounded(text: string, maxBytes: number, maxQuads: number): Store {
  if (new TextEncoder().encode(text).byteLength > maxBytes) throw new Error(`RDF exceeds the ${maxBytes} byte limit`);
  const parsed = new Parser().parse(text);
  if (parsed.length > maxQuads) throw new Error(`RDF exceeds the ${maxQuads} quad limit`);
  const store = new Store(parsed);
  return store;
}
export async function validateGraph(rdf: string, options: GraphValidationOptions | ProfileDefinition = {}): Promise<ValidationFinding[]> {
  const opts: GraphValidationOptions = 'types' in options ? { profile: options } : options;
  const profile = opts.profile ?? DEFAULT_PROFILE; assertProfile(profile);
  const bytes = opts.maxBytes ?? LIMITS.bytes;
  const quads = opts.maxQuads ?? LIMITS.quads; const maxErrors = opts.maxErrors ?? LIMITS.findings;
  if (!Number.isInteger(bytes) || bytes < 1 || bytes > LIMITS.bytes || !Number.isInteger(quads) || quads < 1 || quads > LIMITS.quads
    || !Number.isInteger(maxErrors) || maxErrors < 1 || maxErrors > LIMITS.findings) throw new Error('Validation limits must be positive integers within the supported bounds');
  const data = parseBounded(rdf, bytes, quads);
  const shapes = parseBounded(opts.shapes ?? await shapesTurtle(profile), bytes, quads);
  for (const quad of shapes) {
    if (quad.predicate.value.startsWith(SH) && !supported.has(quad.predicate.value.slice(SH.length))) throw new Error(`Unsupported SHACL constraint: ${quad.predicate.value}`);
    // RDF type declarations can introduce unsupported SHACL execution models.
    // Other objects (enum values, paths, messages and class IRIs) are data terms.
    if (quad.predicate.value === RDF + 'type' && quad.object.termType === 'NamedNode' && quad.object.value.startsWith(SH)
      && !supported.has(quad.object.value.slice(SH.length))) throw new Error(`Unsupported SHACL shape declaration: ${quad.object.value}`);
    if (quad.predicate.value === SH + 'path' && quad.object.termType !== 'NamedNode') throw new Error('Only direct IRI property paths are supported');
    if (quad.predicate.value === SH + 'pattern') assertBoundedPattern(quad.object.value, 'SHACL shape');
    if (quad.predicate.value === SH + 'flags' && !/^[isu]*$/.test(quad.object.value)) throw new Error('Unsupported SHACL regular-expression flags');
    if (quad.predicate.value === SH + 'maxLength' && (quad.object.termType !== 'Literal' || quad.object.datatype.value !== 'http://www.w3.org/2001/XMLSchema#integer' || !/^\+?\d+$/.test(quad.object.value)
      || !Number.isSafeInteger(Number(quad.object.value)))) throw new Error('SHACL maxLength must be a non-negative integer');
  }
  // Malformed/cyclic RDF lists otherwise let validators traverse file-controlled loops.
  const verifiedLists = new Set<string>();
  const listRoots = [...shapes.getQuads(null, RDF + 'first', null, null).map(quad => quad.subject),
    ...['in', 'ignoredProperties', 'languageIn'].flatMap(predicate => shapes.getQuads(null, SH + predicate, null, null).map(quad => quad.object))];
  for (const root of listRoots) {
    if (root.termType !== 'NamedNode' && root.termType !== 'BlankNode') throw new Error('SHACL list constraints require RDF resource lists');
    const visited = new Set<string>(); let cursor = root;
    while (cursor.value !== RDF + 'nil') {
      const key = `${cursor.termType}:${cursor.value}`;
      if (verifiedLists.has(key)) break;
      if (visited.has(key) || visited.size > LIMITS.findings) throw new Error('Cyclic or oversized SHACL RDF list');
      visited.add(key);
      const first = shapes.getQuads(cursor, RDF + 'first', null, null); const rest = shapes.getQuads(cursor, RDF + 'rest', null, null);
      if (first.length !== 1 || rest.length !== 1) throw new Error('Malformed SHACL RDF list');
      const next = rest[0].object;
      if (next.termType !== 'NamedNode' && next.termType !== 'BlankNode') throw new Error('Invalid SHACL RDF list tail');
      cursor = next;
    }
    for (const node of visited) verifiedLists.add(node);
  }
  assertBoundedSubclasses(data);
  assertBoundedPropertyShapes(shapes);
  const targets = countShapeTargets(data, shapes);
  if (!targets) throw new Error('No targets found for SHACL; validation would have no focus nodes');
  const validator = new SHACLValidator(shapes, { maxErrors });
  // rdf-validate-shacl 0.6.5 counts UTF-16 units. SHACL and JSON Schema
  // count Unicode codepoints; correct only this trusted built-in component.
  validator.validators.set(validator.ns.sh.MaxLengthConstraintComponent, {
    validate(context, _focusNode, valueNode, constraint) {
      if (valueNode.termType === 'BlankNode') return false;
      const limit = Number(constraint.getParameterValue(context.ns.sh.maxLength).value);
      let count = 0;
      for (const _character of valueNode.value) if (++count > limit) return false;
      return true;
    },
    validationMessage: 'Value has more than {$maxLength} characters',
  });
  // Components bind their registry callbacks at construction, so rebuild the
  // typed library graph after installing the correction, before any validation.
  validator.shapesGraph = new ShapesGraph(validator);
  const report = await validator.validate(data);
  return report.results.map(result => ({ engine: 'SHACL', resourceId: result.focusNode.value, path: result.path?.value ?? '',
    severity: result.severity.value === SH + 'Warning' ? 'Warning' : result.severity.value === SH + 'Info' ? 'Info' : 'Violation',
    message: result.message.map(term => term.value).join('; ') || result.sourceConstraintComponent.value }));
}
export function documentOf(resources: SemanticResource[], source: string, profile = DEFAULT_PROFILE): SemanticDocument {
  return parseProfileDocument({ profile: profile.id, source, completeness: 'partial', resources }, profile);
}
