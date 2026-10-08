/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { DropboxProvider, type DropboxApiClient } from '@ifc-lite/source-dropbox';
import { MsGraphProvider, type GraphApiClient } from '@ifc-lite/source-msgraph';
import { HostedCloudAuth } from './hosted-cloud-auth';
import { HostedCloudClient } from './hosted-cloud-client';
export function hostedDropbox(client = new HostedCloudClient('dropbox')): DropboxProvider {
  const api: DropboxApiClient = {
    rpc: (path, args, signal) => client.request({ path, args }, signal),
    downloadContent: (path, options) => client.download({ path }, options),
  };
  return new DropboxProvider({ auth: new HostedCloudAuth(client), createClient: () => api });
}
export function hostedMsGraph(client = new HostedCloudClient('msgraph')): MsGraphProvider {
  const api: GraphApiClient = {
    get: (path, params, signal) => client.request({ path, params }, signal),
    downloadItem: (ref, options) => client.download({ path: `/me/drive/items/${encodeURIComponent(ref.fileId)}/content`, revision: ref.revisionId }, options),
  };
  return new MsGraphProvider({ auth: new HostedCloudAuth(client), createClient: () => api });
}
