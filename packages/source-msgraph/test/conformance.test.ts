/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { runConformanceSuite } from '@ifc-lite/source-fixture/conformance';

import { MsGraphProvider } from '../src/provider.js';
import { encodeContainerId } from '../src/ids.js';
import { createConformanceAuth, createConformanceContext } from './graph-mock.js';

// Runs the shared `@ifc-lite/source-fixture` conformance suite against this
// provider, backed by the mock Graph server in `graph-mock.ts` instead of a
// real tenant — see `CONFORMANCE_WORLD` there for the fixed drive/folder/
// file/version layout these ids and the query below refer to.
const provider = new MsGraphProvider(createConformanceAuth());

runConformanceSuite(provider, {
  createContext: () => createConformanceContext(),
  fixtures: {
    projectId: 'onedrive:me',
    containerWithChildrenId: 'drive-1',
    containerWithFilesId: encodeContainerId('drive-1', 'folder-a'),
    fileWithRevisions: { containerId: encodeContainerId('drive-1', 'folder-a'), fileId: 'file-1' },
    searchQuery: 'ifc',
  },
  smallPageLimit: 1,
});
