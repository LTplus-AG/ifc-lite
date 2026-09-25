/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/** Finding a server's Documents API base URL via the OpenCDE Foundation API. */

import { apiBaseUrlFor, findApiVersion, getFoundationVersions } from '@ifc-lite/opencde-foundation';
import type { FetchLike, FoundationVersion } from '@ifc-lite/opencde-foundation';

/** `api_id` the Documents API registers itself under in `/foundation/versions`. */
const DOCUMENTS_API_ID = 'documents';

export interface DiscoverDocumentsServiceOptions {
  /** Server base URL; the Foundation API's `/foundation/versions` is fetched from here. */
  baseUrl: string;
  fetchFn?: FetchLike;
}

export interface DocumentsServiceDiscovery {
  /** Base URL to construct a {@link DocumentsApiClient} with. */
  baseUrl: string;
  /** The matching `/foundation/versions` entry, for its `version_id`. */
  version: FoundationVersion;
}

/**
 * Discover a server's Documents API base URL via the Foundation API's
 * `/foundation/versions` (Foundation API §2.1): unlike BCF's `/bcf`-suffix
 * guessing, the Documents API has no conventional path to guess — a server
 * either lists `documents` in its versions or it does not support it.
 */
export async function discoverDocumentsService(
  options: DiscoverDocumentsServiceOptions,
): Promise<DocumentsServiceDiscovery> {
  const versions = await getFoundationVersions(options);
  const version = findApiVersion(versions, DOCUMENTS_API_ID);
  if (!version) {
    throw new Error(
      `Server at ${options.baseUrl} does not advertise the OpenCDE Documents API in /foundation/versions`,
    );
  }
  return { baseUrl: apiBaseUrlFor(options.baseUrl, version), version };
}
