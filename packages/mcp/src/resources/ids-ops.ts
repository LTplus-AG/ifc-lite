/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { getOpJsonSchema } from '@ifc-lite/ids-authoring';
import { IDS_OPS_SCHEMA_URI } from '../tools/ids-ops-schema.js';
import type { ResourceProvider } from './types.js';

/** The full JSON Schema of one `ids_apply_ops` op; the tool advertises a summary. */
let schemaText: string | undefined;

export const idsOpsSchemaProvider: ResourceProvider = {
  name: 'ids-ops-schema',
  list: () => [{
    uri: IDS_OPS_SCHEMA_URI,
    name: 'IDS ops schema (v1)',
    description: 'JSON Schema 2020-12 of one ids_apply_ops operation: every kind and payload type.',
    mimeType: 'application/schema+json',
  }],
  match: (uri) => uri === IDS_OPS_SCHEMA_URI,
  read: (uri) => {
    if (uri !== IDS_OPS_SCHEMA_URI) throw new Error(`ids-ops-schema cannot read ${uri}`);
    return [{ uri, mimeType: 'application/schema+json', text: (schemaText ??= JSON.stringify(getOpJsonSchema())) }];
  },
};
