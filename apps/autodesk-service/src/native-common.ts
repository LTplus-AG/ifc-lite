/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import { apsResponse, boundedResponse, ServiceError } from './upstream.js';
export function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new ServiceError(502, 'invalid-snapshot', 'Autodesk returned an invalid snapshot.');
  return value as Record<string, unknown>;
}
export function text(value: unknown): string {
  if (typeof value !== 'string' || !value || value.length > 32_768) throw new ServiceError(400, 'invalid-reference', 'Invalid Autodesk reference.');
  return value;
}
export function address(raw: string) {
  if (!raw.startsWith('adsk1:') || raw.length > 32_768) throw new ServiceError(400, 'invalid-reference', 'Invalid Autodesk project.');
  const value = object(JSON.parse(decodeURIComponent(raw.slice(6))));
  return { project: text(value.project), kind: text(value.kind), region: text(value.region),
    hub: value.hub === undefined ? undefined : text(value.hub), id: value.id === undefined ? undefined : text(value.id) };
}
export async function metadata(fetcher: typeof fetch, path: string, token: string, region: string, signal: AbortSignal) {
  const response = await apsResponse(fetcher, path, token, region, signal);
  return object(await boundedResponse(response, 8 * 1024 * 1024, new AbortController()).json());
}
export function immutableUrn(raw: string, context?: string) {
  const match = /^urn:adsk-forma-elements:([^:]+):([^:]+):([^:]+):([^:]+)$/.exec(raw);
  if (!match || (context !== undefined && match[2] !== context)) throw new ServiceError(400, 'revision-context', 'Forma revision and site authorization context do not match.');
  return raw;
}
