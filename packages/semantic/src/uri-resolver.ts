/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { GUID_PATTERN, assertIri } from './types.js';
import { IFC_GLOBAL_ID_STRATEGY, type IdentityStrategy } from './resolver.js';
export type ResourceUriIdentityConfig = { mode: 'template'; template: string } | { mode: 'last-path-segment' };
export const DEFAULT_RESOURCE_URI_CONFIG: ResourceUriIdentityConfig = { mode: 'template', template: 'https://lbd.org/{GlobalId}' };
const PLACEHOLDER = '{GlobalId}';
const TEST_GUID = '0000000000000000000001';
const MAX_URI_LENGTH = 2048;
function rawPath(value: string): string { const start = value.indexOf('/', value.indexOf('://') + 3); return start < 0 ? '' : value.slice(start); }
function absolutePathUri(value: string): URL {
  if (value.length > MAX_URI_LENGTH) throw new Error('Resource URI exceeds 2048 characters');
  assertIri(value);
  if (!/^https?:\/\//iu.test(value) || /%(?![0-9a-f]{2})/iu.test(value)) throw new Error('Resource URI contains an invalid scheme or percent escape');
  if (rawPath(value).split('/').some(part => /^(?:\.|%2e){1,2}$/iu.test(part))) throw new Error('Resource URI dot segments are unsupported');
  const url = new URL(value);
  if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password || url.search || url.hash || value.includes('?') || value.includes('#')) throw new Error('Resource URI must be an absolute HTTP(S) URI without credentials, query or fragment');
  return url;
}
/** Literal template matching only: a single path placeholder, never a user-supplied regular expression. */
export function assertResourceUriIdentityConfig(value: unknown): asserts value is ResourceUriIdentityConfig {
  if (!value || typeof value !== 'object' || Array.isArray(value) || !Object.hasOwn(value, 'mode') || !('mode' in value)) throw new Error('Invalid resource URI identity configuration');
  const allowed = value.mode === 'template' ? ['mode', 'template'] : ['mode'];
  if (Object.keys(value).some(key => !allowed.includes(key))) throw new Error('Unknown resource URI identity configuration member');
  if (value.mode === 'last-path-segment') return;
  if (value.mode !== 'template' || !Object.hasOwn(value, 'template') || !('template' in value) || typeof value.template !== 'string') throw new Error('Expected a resource URI template');
  if (value.template.length > MAX_URI_LENGTH) throw new Error('Resource URI template exceeds 2048 characters');
  const parts = value.template.split(PLACEHOLDER);
  if (parts.length !== 2 || /[{}]/u.test(parts.join(''))) throw new Error('URI template requires exactly one {GlobalId} placeholder');
  if (value.template.length - PLACEHOLDER.length + TEST_GUID.length > MAX_URI_LENGTH) throw new Error('Expanded resource URI exceeds 2048 characters');
  if (/%[0-9a-f]?$/iu.test(parts[0])) throw new Error('GlobalId placeholder must not participate in a percent escape');
  absolutePathUri(parts.join(TEST_GUID));
  if (!rawPath(value.template).includes(PLACEHOLDER)) throw new Error('GlobalId placeholder must occur in the URI path');
}
export function resourceUriForGlobalId(GlobalId: string, config: ResourceUriIdentityConfig): string {
  assertResourceUriIdentityConfig(config);
  if (!new RegExp(GUID_PATTERN).test(GlobalId)) throw new Error('Invalid IFC GlobalId');
  if (config.mode !== 'template') throw new Error('Last path segment cannot infer a resource base URI; configure a full URI template or load known resource URIs first');
  const uri = config.template.replace(PLACEHOLDER, () => GlobalId);
  absolutePathUri(uri);
  return uri;
}
export function createResourceUriStrategy(config: ResourceUriIdentityConfig): IdentityStrategy {
  assertResourceUriIdentityConfig(config);
  // Capture a validated portable copy, independent of later caller mutations.
  const template = config.mode === 'template' ? config.template.split(PLACEHOLDER) : undefined;
  return { id: 'resource-uri', resolve(record, context) {
    if (typeof record.id !== 'string') return { status: 'invalid' };
    try { absolutePathUri(record.id); }
    catch { return { status: 'invalid' }; }
    const captured = template ? (record.id.startsWith(template[0]) && record.id.endsWith(template[1])
      ? record.id.slice(template[0].length, record.id.length - template[1].length) : undefined) : rawPath(record.id).split('/').at(-1);
    let GlobalId: string;
    try { GlobalId = decodeURIComponent(captured ?? ''); }
    catch { return { status: 'invalid' }; }
    // One decoding pass only; decoded delimiters and percent signs fail the compressed GUID contract.
    if (!GlobalId || !new RegExp(GUID_PATTERN).test(GlobalId) || (record.GlobalId !== undefined && record.GlobalId !== GlobalId)) return { status: 'invalid' };
    return IFC_GLOBAL_ID_STRATEGY.resolve({ ...record, GlobalId }, context);
  } };
}
