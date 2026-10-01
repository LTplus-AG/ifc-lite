/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import Ajv from 'ajv';
import jsonld from 'jsonld';
import { Parser, Store } from 'n3';
import SHACLValidator from 'rdf-validate-shacl';
import { context, exchangeSchema, fields, resourceSchema, shapesTurtle } from './profile';
import { PROFILE_ID, RESOURCE_TYPES, VOCAB, type SemanticDocument, type SemanticResource, type ValidationFinding } from './types';

const ajv = new Ajv({ allErrors: true });
export function isUri(value: string): boolean {
  if (/\s/.test(value)) return false;
  try { return !!new URL(value).protocol; } catch { return false; }
}
ajv.addFormat('uri', isUri);
const resourceProperties = Object.fromEntries(Object.entries(fields).map(([key, field]) => [key,
  { type: 'string', ...(field.kind === 'iri' ? { format: 'uri' } : {}) }]));
// Validate the transport shape before graph conversion, so unknown fields cannot disappear.
const structural = ajv.compile<SemanticDocument>({
  ...exchangeSchema,
  properties: { ...exchangeSchema.properties, resources: {
    type: 'array', maxItems: 5000, items: {
      type: 'object', additionalProperties: false, required: ['id', 'type', 'label'],
      properties: { ...resourceProperties, id: { type: 'string', format: 'uri' },
        type: { enum: [...RESOURCE_TYPES] }, label: { type: 'string' } },
    },
  } },
});
const validators = new Map(RESOURCE_TYPES.map(type => [type, ajv.compile(resourceSchema(type))]));

export function parseDocument(value: unknown): SemanticDocument {
  if (!structural(value)) throw new Error(ajv.errorsText(structural.errors));
  const ids = new Set<string>();
  for (const resource of value.resources) {
    if (ids.has(resource.id)) throw new Error(`Duplicate resource identifier: ${resource.id}`);
    ids.add(resource.id);
  }
  return value;
}
export function validateJson(document: SemanticDocument): ValidationFinding[] {
  return document.resources.flatMap(resource => {
    const validator = validators.get(resource.type)!;
    validator(resource);
    return (validator.errors ?? []).map(error => ({ engine: 'JSON Schema' as const, resourceId: resource.id,
      path: error.instancePath || String(error.params.missingProperty ?? ''), message: error.message ?? error.keyword }));
  });
}
export function validateLinks(document: SemanticDocument): ValidationFinding[] {
  const byId = new Map(document.resources.map(resource => [resource.id, resource]));
  const links = ['buildingId', 'productId', 'passportId', 'installationId', 'replacesId'] as const;
  const expected = { buildingId: 'Building', productId: 'Product', passportId: 'Passport', installationId: 'Installation', replacesId: 'Installation' };
  return document.resources.flatMap(resource => links.flatMap(key => {
    const target = resource[key];
    if (!target) return [];
    const found = byId.get(target);
    const message = found && found.type !== expected[key] ? `Expected ${expected[key]}, found ${found.type}: ${target}`
      : !found && document.completeness === 'complete' ? `Referenced resource is absent from this complete submission: ${target}` : undefined;
    return message ? [{ engine: 'links' as const, resourceId: resource.id, path: key, message }] : [];
  }));
}
/** Bundle imports use the installed profile, never execute imported shapes or contexts. */
export function parseImport(value: unknown): SemanticDocument {
  if (value && typeof value === 'object' && 'document' in value) return parseDocument(value.document);
  return parseDocument(value);
}
export function asJsonLd(document: SemanticDocument) {
  // Copy only after structural validation. Remote contexts are never loaded.
  parseDocument(document);
  return { '@context': context, '@graph': document.resources.map(resource => ({ ...resource })) };
}
export async function toRdf(document: SemanticDocument): Promise<string> {
  const rdf = await jsonld.toRDF(asJsonLd(document), { format: 'application/n-quads',
    documentLoader: async () => { throw new Error('Remote JSON-LD contexts are disabled in the pilot'); } });
  if (typeof rdf !== 'string') throw new Error('JSON-LD conversion did not produce N-Quads');
  return rdf;
}
export async function validateGraph(rdf: string): Promise<ValidationFinding[]> {
  if (rdf.length > 5 * 1024 * 1024) throw new Error('RDF exceeds the 5 MiB pilot limit');
  const data = new Store(new Parser().parse(rdf));
  if (data.size > 50000) throw new Error('RDF exceeds the 50,000 quad pilot limit');
  const known = RESOURCE_TYPES.some(type => data.countQuads(null,
    'http://www.w3.org/1999/02/22-rdf-syntax-ns#type', VOCAB + type, null) > 0);
  if (!known) throw new Error('No pilot resource types found; validation would have no targets');
  const validator = new SHACLValidator(new Store(new Parser().parse(await shapesTurtle())), { maxErrors: 1000 });
  const report = await validator.validate(data);
  return report.results.map(result => ({ engine: 'SHACL', resourceId: result.focusNode.value,
    path: result.path?.value ?? '', message: result.message.map(term => term.value).join('; ') || result.sourceConstraintComponent.value }));
}
export function documentOf(resources: SemanticResource[], source: string): SemanticDocument {
  return parseDocument({ profile: PROFILE_ID, source, completeness: 'partial', resources });
}
