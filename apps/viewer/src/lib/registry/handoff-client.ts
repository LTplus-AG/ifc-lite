/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { OciClient, OciError, buildImageManifest, parseReference, type OciDescriptor, type OciManifestResult } from '@ifc-lite/oci';
import { RegistryError, releaseName, repositoryName } from './protocol';
import { registryOrigin, type ArtifactSource } from './handoff-contract';
import { resourceAllows, type ResourceSession } from './handoff-auth';
const MAX_IFC_BYTES = 512 * 1024 * 1024;
const IFC_ARTIFACT_TYPE = 'application/vnd.ifc-lite.ifc.v1';
const VERSIONS_PER_PAGE = 12;

export interface RepositoryVersion {
  tag: string;
  title: string;
  digest: string;
}

function ifcLayer({ value }: OciManifestResult): OciDescriptor | undefined {
  if ('layers' in value && value.artifactType === IFC_ARTIFACT_TYPE &&
      value.layers.length === 1 && value.layers[0].mediaType === 'application/x-step') {
    return value.layers[0];
  }
}

function connection(session: ResourceSession, registry: string, repository: string, action: 'pull' | 'push') {
  registryOrigin(registry); repositoryName(repository);
  if (session.registry !== registry || !resourceAllows(session, repository, action)) throw new RegistryError('Sign in to this file store for the selected folder and action.', 403);
  const origin = new URL(registry), insecureHosts = origin.protocol === 'http:' ? [origin.host] : undefined;
  return { client: new OciClient({ credentials: { token: session.accessToken }, insecureHosts }), reference: (suffix = '') => parseReference(`${origin.host}/${repository}${suffix}`, { insecureHosts }) };
}

/** Read tags in a known repository and inspect a bounded page of their manifests. */
export async function browseRepositoryVersions(
  registry: string, repository: string, session: ResourceSession, signal: AbortSignal, remainingTags?: string[],
): Promise<{ versions: RepositoryVersion[]; remaining: string[] }> {
  const { client, reference } = connection(session, registry, repository, 'pull');
  const tags = remainingTags ?? [...new Set(await client.tags(reference(), { signal }))];
  const versions = await Promise.all(tags.slice(0, VERSIONS_PER_PAGE).map(async tag => {
    try {
      const manifest = await client.manifest(reference(`:${tag}`), { signal });
      const layer = ifcLayer(manifest);
      return layer && {
        tag, digest: manifest.digest,
        title: manifest.value.annotations?.['org.opencontainers.image.title']
          ?? layer.annotations?.['org.opencontainers.image.title'] ?? tag,
      };
    } catch (error) {
      if (error instanceof OciError && (error.code === 'NOT_FOUND' || error.code === 'UNSUPPORTED_MANIFEST')) return undefined;
      throw error;
    }
  }));
  return { versions: versions.filter(version => version !== undefined), remaining: tags.slice(VERSIONS_PER_PAGE) };
}

export async function pullHandoff(source: ArtifactSource, session: ResourceSession, signal?: AbortSignal): Promise<{ bytes: Uint8Array<ArrayBuffer>; filename: string; digest: string }> {
  const { client, reference } = connection(session, source.registry, source.repository, 'pull');
  if (!/^sha256:[a-f0-9]{64}$/.test(source.digest)) throw new RegistryError('Choose an exact published version.');
  const ref = reference(`@${source.digest}`), manifest = await client.manifest(ref, { signal });
  const layer = ifcLayer(manifest);
  if (!layer) throw new RegistryError('Choose a version containing a supported IFC package.');
  const bytes = await client.blob(ref, layer, { signal, maxBytes: MAX_IFC_BYTES });
  return { bytes: new Uint8Array(bytes), filename: layer.annotations?.['org.opencontainers.image.title']?.split(/[\\/]/).pop() || 'model.ifc', digest: manifest.digest };
}
export async function pushHandoff(registry: string, repository: string, tag: string, bytes: Uint8Array<ArrayBuffer>, filename: string, session: ResourceSession, signal?: AbortSignal): Promise<ArtifactSource> {
  releaseName(tag);
  if (bytes.length > MAX_IFC_BYTES || !new TextDecoder().decode(bytes.subarray(0, 64)).trimStart().startsWith('ISO-10303-21;')) throw new RegistryError('Choose an IFC STEP model up to 512 MiB.');
  const { client, reference } = connection(session, registry, repository, 'push');
  if (!resourceAllows(session, repository, 'pull')) throw new RegistryError('View permission is required to check for an existing version.', 403);
  const ref = reference(`:${tag}`);
  // Check before uploading large files. The registry owns any atomic immutability policy.
  try { await client.manifest(ref, { signal }); throw new RegistryError('That version already exists. Choose a new version name.'); }
  catch (error) { if (!(error && typeof error === 'object' && 'code' in error && error.code === 'NOT_FOUND')) throw error; }
  const config = await client.pushEmptyConfig(ref, { signal });
  const file = await client.pushBlob(ref, bytes, { signal });
  const built = await buildImageManifest({ artifactType: IFC_ARTIFACT_TYPE, config,
    layers: [{ mediaType: 'application/x-step', ...file, annotations: { 'org.opencontainers.image.title': filename } }] });
  const saved = await client.pushManifest(ref, built.bytes, built.mediaType, { signal });
  return { registry, repository, digest: saved.digest };
}
