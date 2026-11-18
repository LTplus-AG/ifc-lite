/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { artifactSource, type ArtifactSource, type OciHandoff, type RegistryConnection } from './handoff-contract';
import { RegistryError, responseBytes } from './protocol';

/** The provider records the staged digest as a revision of the original file. */
export async function confirmPublication(
  connection: RegistryConnection,
  handoff: OciHandoff,
  uploaded: ArtifactSource,
  publicationToken: string,
  signal: AbortSignal,
): Promise<ArtifactSource> {
  const endpoint = connection.token_exchange?.publication_endpoint;
  const destination = handoff.destination;
  if (!endpoint || !publicationToken || handoff.intent !== 'edit' ||
      handoff.source.registry !== connection.registry || destination?.registry !== connection.registry ||
      uploaded.registry !== destination.registry || uploaded.repository !== destination.repository) {
    throw new RegistryError('Open the original file for editing to save a version there.');
  }
  const response = await fetch(endpoint, {
    method: 'POST', signal, credentials: 'omit', redirect: 'error', cache: 'no-store',
    headers: { Authorization: `Bearer ${publicationToken}`, 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify({ source: handoff.source, uploaded }),
  });
  if (!response.ok) {
    await response.body?.cancel();
    if (response.status === 409) throw new RegistryError('A newer version was saved. Open it before saving your changes.', 409);
    if (response.status === 401 || response.status === 403) throw new RegistryError('The file store denied this save. Sign in again or ask the owner for access.', response.status);
    throw new RegistryError('The upload finished, but the file store could not confirm the save. Try finishing the save again.', response.status);
  }
  const receipt: unknown = JSON.parse(new TextDecoder().decode(await responseBytes(response, 64 * 1024)));
  return artifactSource(receipt, connection.registry);
}
