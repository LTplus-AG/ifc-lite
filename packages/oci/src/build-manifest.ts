/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { finishDigest } from './digest.js';
import { OCI_MANIFEST, parseDescriptor } from './manifest-shape.js';
import type { OciBuiltManifest, OciDescriptor, OciImageManifestInput } from './types.js';

/** The OCI empty descriptor: the 2-byte blob `{}`. */
export const EMPTY_CONFIG_MEDIA_TYPE = 'application/vnd.oci.empty.v1+json';
export const EMPTY_CONFIG_DIGEST = 'sha256:44136fa355b3678a1146ad16f7e8649e94fb4fc21fe77e8310c060f61caaff8a';

export function emptyConfigBytes(): Uint8Array<ArrayBuffer> {
  return new TextEncoder().encode('{}');
}

function emptyConfig(): OciDescriptor {
  return { mediaType: EMPTY_CONFIG_MEDIA_TYPE, digest: EMPTY_CONFIG_DIGEST, size: 2 };
}

function sortedAnnotations(value: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const key of Object.keys(value).sort()) out[key] = value[key];
  return out;
}

function annotationsOf(value: unknown, where: string): Record<string, string> | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new TypeError(`@ifc-lite/oci: ${where} must be an object`);
  for (const [key, v] of Object.entries(value)) {
    if (typeof v !== 'string') throw new TypeError(`@ifc-lite/oci: ${where}["${key}"] must be a string`);
  }
  return sortedAnnotations(value as Record<string, string>);
}

/**
 * Validates a descriptor and rebuilds it with a fixed key order (mediaType,
 * digest, size, artifactType, annotations sorted by key). Other fields are
 * not serialized.
 */
function canonicalDescriptor(value: OciDescriptor, where: string): OciDescriptor {
  let checked: OciDescriptor;
  try {
    checked = parseDescriptor(value, where);
  } catch (err) {
    throw new TypeError(`@ifc-lite/oci: buildImageManifest() ${err instanceof Error ? err.message : String(err)}`, { cause: err });
  }
  const out: OciDescriptor = { mediaType: checked.mediaType, digest: checked.digest, size: checked.size };
  if (checked.artifactType !== undefined) out.artifactType = checked.artifactType;
  const annotations = annotationsOf(checked.annotations, `${where}.annotations`);
  if (annotations !== undefined) out.annotations = annotations;
  return out;
}

/**
 * Serializes an OCI image manifest deterministically: fixed key order,
 * annotations sorted by key, no whitespace, so the same input always gives
 * the same bytes and the same digest. `config` defaults to the OCI empty
 * descriptor, whose 2-byte blob `{}` must be in the repository before the
 * manifest is pushed (`OciClient.pushEmptyConfig`). The image spec requires
 * `artifactType` whenever the config is the empty descriptor.
 */
export async function buildImageManifest(input: OciImageManifestInput): Promise<OciBuiltManifest> {
  const config = canonicalDescriptor(input.config ?? emptyConfig(), 'config');
  if (!Array.isArray(input.layers)) throw new TypeError('@ifc-lite/oci: buildImageManifest() layers must be an array');
  const layers = input.layers.map((layer, i) => canonicalDescriptor(layer, `layers[${i}]`));
  const { artifactType } = input;
  if (artifactType !== undefined && (typeof artifactType !== 'string' || artifactType === '')) {
    throw new TypeError('@ifc-lite/oci: buildImageManifest() artifactType must be a non-empty string');
  }
  if (artifactType === undefined && config.mediaType === EMPTY_CONFIG_MEDIA_TYPE) {
    throw new TypeError('@ifc-lite/oci: buildImageManifest() needs artifactType when the config is the empty descriptor (OCI image spec)');
  }
  const doc: Record<string, unknown> = { schemaVersion: 2, mediaType: OCI_MANIFEST };
  if (artifactType !== undefined) doc.artifactType = artifactType;
  doc.config = config;
  doc.layers = layers;
  const annotations = annotationsOf(input.annotations, 'annotations');
  if (annotations !== undefined) doc.annotations = annotations;
  const bytes = new TextEncoder().encode(JSON.stringify(doc));
  return { bytes, mediaType: OCI_MANIFEST, digest: await finishDigest(bytes, undefined) };
}
