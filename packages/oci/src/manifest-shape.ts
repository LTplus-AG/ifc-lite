/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { OciError } from './errors.js';
import type { OciDescriptor, OciIndex, OciManifest } from './types.js';

export const OCI_MANIFEST = 'application/vnd.oci.image.manifest.v1+json';
export const OCI_INDEX = 'application/vnd.oci.image.index.v1+json';
export const DOCKER_MANIFEST = 'application/vnd.docker.distribution.manifest.v2+json';
export const DOCKER_MANIFEST_LIST = 'application/vnd.docker.distribution.manifest.list.v2+json';

/** `Accept` for manifest requests: the four media types this client parses. */
export const MANIFEST_ACCEPT = [OCI_MANIFEST, OCI_INDEX, DOCKER_MANIFEST, DOCKER_MANIFEST_LIST].join(', ');

const KIND_BY_MEDIA_TYPE: Record<string, 'manifest' | 'index'> = {
  [OCI_MANIFEST]: 'manifest',
  [DOCKER_MANIFEST]: 'manifest',
  [OCI_INDEX]: 'index',
  [DOCKER_MANIFEST_LIST]: 'index',
};

// Generic digest grammar (algorithm:encoded) from the OCI image spec. A
// descriptor may legitimately name another algorithm; `blob()` is where
// sha256 is required, because that is the only one it can verify.
const DIGEST = /^[a-z0-9]+(?:[+._-][a-z0-9]+)*:[a-zA-Z0-9=_-]+$/;

function bad(what: string): OciError {
  return new OciError('PROTOCOL', `Malformed manifest: ${what}`);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function annotations(value: unknown, where: string): Record<string, string> | undefined {
  if (value === undefined) return undefined;
  if (!isRecord(value)) throw bad(`${where}.annotations is not an object`);
  const out: Record<string, string> = {};
  for (const [key, v] of Object.entries(value)) {
    if (typeof v !== 'string') throw bad(`${where}.annotations["${key}"] is not a string`);
    out[key] = v;
  }
  return out;
}

function optionalString(value: unknown, where: string): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'string') throw bad(`${where} is not a string`);
  return value;
}

export function parseDescriptor(value: unknown, where: string): OciDescriptor {
  if (!isRecord(value)) throw bad(`${where} is not an object`);
  const { mediaType, digest, size } = value;
  if (typeof mediaType !== 'string' || mediaType === '') throw bad(`${where}.mediaType is missing`);
  if (typeof digest !== 'string' || !DIGEST.test(digest)) throw bad(`${where}.digest is missing or malformed`);
  if (typeof size !== 'number' || !Number.isSafeInteger(size) || size < 0) throw bad(`${where}.size is not a non-negative integer`);
  const out: OciDescriptor = { mediaType, digest, size };
  const ann = annotations(value.annotations, where);
  if (ann) out.annotations = ann;
  const artifactType = optionalString(value.artifactType, `${where}.artifactType`);
  if (artifactType !== undefined) out.artifactType = artifactType;
  if (value.platform !== undefined) out.platform = value.platform;
  return out;
}

function descriptorList(value: unknown, where: string): OciDescriptor[] {
  if (!Array.isArray(value)) throw bad(`${where} is not an array`);
  return value.map((entry, i) => parseDescriptor(entry, `${where}[${i}]`));
}

/**
 * Validates a manifest document and returns a normalized copy. The media type
 * comes from the document's own `mediaType` when present (the bytes are what
 * the digest covers), otherwise from the response `Content-Type`.
 */
export function parseManifestDocument(bytes: Uint8Array, contentType: string | null): OciManifest | OciIndex {
  let doc: unknown;
  try {
    doc = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
  } catch (err) {
    throw new OciError('PROTOCOL', 'Malformed manifest: not UTF-8 JSON', { cause: err });
  }
  if (!isRecord(doc)) throw bad('document is not a JSON object');
  const headerType = contentType?.split(';')[0].trim().toLowerCase() || undefined;
  const bodyType = optionalString(doc.mediaType, 'mediaType');
  const mediaType = bodyType ?? headerType;
  if (mediaType === undefined) {
    throw new OciError('UNSUPPORTED_MANIFEST', 'Manifest has no media type (neither a mediaType field nor a Content-Type)');
  }
  const kind = KIND_BY_MEDIA_TYPE[mediaType];
  if (!kind) throw new OciError('UNSUPPORTED_MANIFEST', `Unsupported manifest media type "${mediaType}"`);
  if (doc.schemaVersion !== 2) throw bad('schemaVersion is not 2');
  const ann = annotations(doc.annotations, 'manifest');

  if (kind === 'index') {
    const index: OciIndex = { kind, mediaType, manifests: descriptorList(doc.manifests, 'manifests') };
    if (ann) index.annotations = ann;
    return index;
  }
  const manifest: OciManifest = {
    kind,
    mediaType,
    config: parseDescriptor(doc.config, 'config'),
    layers: descriptorList(doc.layers, 'layers'),
  };
  const artifactType = optionalString(doc.artifactType, 'artifactType');
  if (artifactType !== undefined) manifest.artifactType = artifactType;
  if (ann) manifest.annotations = ann;
  return manifest;
}
