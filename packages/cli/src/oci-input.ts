/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Opens an `oci://` model reference: one IFC layer of an OCI artifact,
 * pulled through `@ifc-lite/oci`. Credentials and the size cap come from the
 * environment only; nothing here reads Docker config or `GITHUB_TOKEN`.
 */

import { createHash } from 'node:crypto';
import {
  OciClient,
  OciError,
  parseReference,
  type OciCredentials,
  type OciDescriptor,
  type OciHasher,
  type OciManifest,
  type OciReference,
} from '@ifc-lite/oci';

/** A model reference that could not be opened; `message` is ready for the user. */
export class ModelInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ModelInputError';
  }
}

/** Loopback hosts (any port) are reached over plain http; every other host over https. */
export const LOOPBACK_HOSTS = ['localhost', '127.0.0.1', '[::1]'];
const DEFAULT_MAX_BYTES = 1024 * 1024 * 1024;
export const CREDENTIAL_HINT =
  'set IFC_LITE_OCI_USERNAME and IFC_LITE_OCI_PASSWORD, or IFC_LITE_OCI_TOKEN';
const TITLE = 'org.opencontainers.image.title';

export type Env = Readonly<Record<string, string | undefined>>;

/** Parses an `oci://` reference with the CLI's loopback-only plain-http rule. */
export function parseModelReference(arg: string): OciReference {
  return parseReference(arg, { insecureHosts: LOOPBACK_HOSTS });
}

/** An unset or empty variable counts as absent (CI expands a missing secret to ''). */
function envValue(env: Env, key: string): string | undefined {
  const value = env[key];
  return value === undefined || value === '' ? undefined : value;
}

/** Registry credentials from the environment, or `undefined` for anonymous pulls. */
export function credentialsFromEnv(env: Env): OciCredentials | undefined {
  const username = envValue(env, 'IFC_LITE_OCI_USERNAME');
  const password = envValue(env, 'IFC_LITE_OCI_PASSWORD');
  const token = envValue(env, 'IFC_LITE_OCI_TOKEN');
  const basic = username !== undefined || password !== undefined;
  if (basic && token !== undefined) {
    throw new ModelInputError(
      'IFC_LITE_OCI_TOKEN and IFC_LITE_OCI_USERNAME/IFC_LITE_OCI_PASSWORD are both set; set only one form of registry credentials',
    );
  }
  if (token !== undefined) return { token };
  if (!basic) return undefined;
  if (username === undefined) throw new ModelInputError('IFC_LITE_OCI_PASSWORD is set but IFC_LITE_OCI_USERNAME is not; set both');
  if (password === undefined) throw new ModelInputError('IFC_LITE_OCI_USERNAME is set but IFC_LITE_OCI_PASSWORD is not; set both');
  return { username, password };
}

/** The layer size cap: `IFC_LITE_OCI_MAX_BYTES` (positive integer bytes), else 1 GiB. */
function maxBytesFromEnv(env: Env): number {
  const raw = envValue(env, 'IFC_LITE_OCI_MAX_BYTES');
  if (raw === undefined) return DEFAULT_MAX_BYTES;
  const value = Number(raw);
  if (!/^[1-9][0-9]*$/.test(raw) || !Number.isSafeInteger(value)) {
    throw new ModelInputError(`IFC_LITE_OCI_MAX_BYTES must be a positive integer number of bytes, got "${raw}"`);
  }
  return value;
}

export function nodeHasher(): OciHasher {
  const hash = createHash('sha256');
  return {
    update: (chunk) => {
      hash.update(chunk);
    },
    digest: () => hash.digest('hex'),
  };
}

function titleOf(descriptor: OciDescriptor): string | undefined {
  return descriptor.annotations?.[TITLE];
}

function isIfcLayer(layer: OciDescriptor): boolean {
  const mediaType = layer.mediaType.split(';')[0].trim().toLowerCase();
  return mediaType === 'application/x-step' || /\.(ifc|ifczip)$/i.test(titleOf(layer) ?? '');
}

function describeLayer(layer: OciDescriptor): string {
  return `  - ${titleOf(layer) ?? '(no title)'}  ${layer.mediaType}  ${layer.size} bytes  ${layer.digest}`;
}

/**
 * The layer holding the model: the only layer, else the single layer typed
 * `application/x-step` or titled `*.ifc` / `*.ifczip`.
 */
function selectModelLayer(manifest: OciManifest, label: string): OciDescriptor {
  const { layers } = manifest;
  if (layers.length === 1) return layers[0];
  if (layers.length === 0) throw new ModelInputError(`cannot open ${label}: the manifest has no layers`);
  const candidates = layers.filter(isIfcLayer);
  if (candidates.length === 1) return candidates[0];
  const why = candidates.length === 0
    ? 'none of its layers is an IFC model (mediaType application/x-step, or a title ending in .ifc/.ifczip)'
    : `${candidates.length} of its layers look like IFC models; push the model as its own artifact`;
  throw new ModelInputError(
    `cannot open ${label}: the manifest has ${layers.length} layers and ${why}. Layers:\n${layers.map(describeLayer).join('\n')}`,
  );
}

function indexError(label: string, entries: readonly OciDescriptor[]): ModelInputError {
  const lines = entries.map((entry) => {
    const kind = entry.artifactType ?? entry.mediaType;
    const platform = entry.platform === undefined ? '' : `  platform ${JSON.stringify(entry.platform)}`;
    return `  - ${entry.digest}  ${kind}${platform}`;
  });
  return new ModelInputError(
    `cannot open ${label}: it names an index of ${entries.length} manifests, not a single model; ` +
      `pin one with oci://<host>/<repository>@<digest>. Entries:\n${lines.join('\n')}`,
  );
}

/** `name` for a layer: the title's basename, else `<repository-last-segment>:<tag>` / `@<short digest>`. */
function modelName(ref: OciReference, layer: OciDescriptor, manifestDigest: string): string {
  const title = titleOf(layer)?.split(/[\\/]/).pop();
  if (title) return title;
  const repo = ref.repository.split('/').pop() ?? ref.repository;
  if (ref.tag !== undefined) return `${repo}:${ref.tag}`;
  return `${repo}@${(ref.digest ?? manifestDigest).slice(0, 'sha256:'.length + 12)}`;
}

function ociFailure(label: string, error: OciError): ModelInputError {
  const auth = error.code === 'UNAUTHORIZED'
    ? `. Registry authentication failed (unauthorized); ${CREDENTIAL_HINT}`
    : error.code === 'DENIED'
      ? `. The registry refused these credentials for this repository (authentication or pull permission); ${CREDENTIAL_HINT}`
      : '';
  return new ModelInputError(`cannot open ${label} (${error.code}): ${error.message}${auth}`);
}

function environmentConfig(arg: string, env: Env): { credentials?: OciCredentials; maxBytes: number } {
  try {
    const credentials = credentialsFromEnv(env);
    return { ...(credentials ? { credentials } : {}), maxBytes: maxBytesFromEnv(env) };
  } catch (error) {
    if (error instanceof ModelInputError) throw new ModelInputError(`cannot open ${arg}: ${error.message}`);
    throw error;
  }
}

/**
 * Pulls the model layer `arg` names. Every failure, including bad
 * environment configuration, is a {@link ModelInputError}.
 */
export async function openOciModel(arg: string): Promise<{ bytes: Uint8Array; name: string }> {
  const { credentials, maxBytes } = environmentConfig(arg, process.env);
  try {
    const ref = parseModelReference(arg);
    const client = new OciClient({
      ...(credentials ? { credentials } : {}),
      insecureHosts: LOOPBACK_HOSTS,
      createHasher: nodeHasher,
    });
    const manifest = await client.manifest(ref);
    if (manifest.value.kind === 'index') throw indexError(arg, manifest.value.manifests);
    const layer = selectModelLayer(manifest.value, arg);
    const bytes = await client.blob(ref, layer, { maxBytes });
    return { bytes, name: modelName(ref, layer, manifest.digest) };
  } catch (error) {
    if (error instanceof OciError) throw ociFailure(arg, error);
    throw error;
  }
}
