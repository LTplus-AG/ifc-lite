/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { readFile } from 'node:fs/promises';
import { IFC_CATALOG_ID } from '@ifc-lite/a2ui';
import { A2UI_APP_MIME_TYPE, A2UI_APP_URI } from '../apps/a2ui/constants.js';
import type { ResourceProvider } from './types.js';

const resources = [
  { uri: A2UI_APP_URI, name: 'ifc-lite result surface', mimeType: A2UI_APP_MIME_TYPE },
  { uri: IFC_CATALOG_ID, name: 'ifc-lite A2UI v1.0 catalog', mimeType: 'application/json' },
];

export const a2uiResourceProvider: ResourceProvider = {
  name: 'a2ui',
  list: () => resources,
  match: (uri) => resources.some((resource) => resource.uri === uri),
  async read(uri) {
    if (uri === IFC_CATALOG_ID) {
      const { ifcCatalogDocument } = await import('@ifc-lite/a2ui/catalog');
      return [{ uri, mimeType: 'application/json', text: JSON.stringify(ifcCatalogDocument()) }];
    }
    const url = new URL('../../dist/apps/a2ui/app.html', import.meta.url);
    return [{ uri, mimeType: A2UI_APP_MIME_TYPE, text: await readFile(url, 'utf8') }];
  },
};
