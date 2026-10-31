/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * `ifc-lite oci push <oci://host/repository:tag> <model.ifc>`: publishes one
 * IFC-SPF file as an OCI artifact, in the layout the ifc-lite viewer
 * publishes: artifactType `application/vnd.ifc-lite.ifc.v1`, the OCI empty
 * config, exactly one `application/x-step` layer titled with the file name.
 * Credentials come from the environment, as for `oci://` input.
 */

import { buildImageManifest, OciClient, OciError, type OciCredentials } from '@ifc-lite/oci';
import { fatal, printJson } from '../output.js';
import { CREDENTIAL_HINT, credentialsFromEnv, LOOPBACK_HOSTS, ModelInputError, nodeHasher } from '../oci-input.js';
import {
  CREATED_ANNOTATION,
  createdTimestamp,
  IFC_PROFILE_ANNOTATION,
  IFC_RELEASE_PROFILE,
  IFC_SCHEMA_ANNOTATION,
  parseAnnotations,
  parsePushArgs,
  pushTarget,
  readIfcForPush,
  TITLE_ANNOTATION,
} from './oci-push-input.js';

export const IFC_ARTIFACT_TYPE = 'application/vnd.ifc-lite.ifc.v1';
export const IFC_LAYER_MEDIA_TYPE = 'application/x-step';

function pushFailure(reference: string, tag: string, error: OciError): never {
  if (error.code === 'TAG_EXISTS') fatal(`tag ${tag} already exists; pass --overwrite to replace it`);
  const auth = error.code === 'UNAUTHORIZED'
    ? `. Registry authentication failed (unauthorized); ${CREDENTIAL_HINT}`
    : error.code === 'DENIED'
      ? `. The registry refused these credentials for this repository (authentication or push permission); ${CREDENTIAL_HINT}`
      : '';
  fatal(`cannot push ${reference} (${error.code}): ${error.message}${auth}`);
}

export async function ociPushCommand(args: string[]): Promise<void> {
  const options = parsePushArgs(args);
  const ref = pushTarget(options.reference);
  const extra = parseAnnotations(options.annotations);
  const created = createdTimestamp(process.env);
  let credentials: OciCredentials | undefined;
  try {
    credentials = credentialsFromEnv(process.env);
  } catch (error) {
    if (error instanceof ModelInputError) fatal(`cannot push ${options.reference}: ${error.message}`);
    throw error;
  }
  // Read and validate the model before any request: a non-IFC file never reaches the registry.
  const model = await readIfcForPush(options.file);

  const client = new OciClient({
    ...(credentials ? { credentials } : {}),
    insecureHosts: LOOPBACK_HOSTS,
    createHasher: nodeHasher,
  });
  try {
    const config = await client.pushEmptyConfig(ref);
    const layer = await client.pushBlob(ref, model.bytes);
    const profile = { [IFC_PROFILE_ANNOTATION]: IFC_RELEASE_PROFILE, [IFC_SCHEMA_ANNOTATION]: model.schema };
    const manifest = await buildImageManifest({
      artifactType: IFC_ARTIFACT_TYPE,
      config,
      layers: [{ mediaType: IFC_LAYER_MEDIA_TYPE, ...layer, annotations: { ...profile, [TITLE_ANNOTATION]: model.fileName } }],
      annotations: { [CREATED_ANNOTATION]: created, ...extra, ...profile, [TITLE_ANNOTATION]: model.title },
    });
    const pushed = await client.pushManifest(ref, manifest.bytes, manifest.mediaType, { allowOverwrite: options.overwrite });
    if (options.json) {
      printJson({
        reference: options.reference,
        digest: pushed.digest,
        layer: { digest: layer.digest, size: layer.size, mediaType: IFC_LAYER_MEDIA_TYPE },
        artifactType: IFC_ARTIFACT_TYPE,
      });
    } else {
      process.stdout.write(`Pushed ${options.reference} → ${pushed.digest} (layer ${layer.digest}, ${layer.size} bytes)\n`);
    }
  } catch (error) {
    if (error instanceof OciError) pushFailure(options.reference, ref.tag, error);
    throw error;
  }
}
