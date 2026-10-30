/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// The shared `FileSourceProvider` conformance suite against the in-memory API.

import { beforeAll, describe } from 'vitest';
import { runConformanceSuite } from '@ifc-lite/source-fixture/conformance';
import { BuildagilProvider } from '../src/provider.js';
import { createMockApi, type MockWorld } from './buildagil-api-mock.js';

const version = (index: number, content: string) => ({
  version_index: index, version_number: String(index), modified_date: `2026-04-0${index}T00:00:00.000Z`, content,
});

const WORLD: MockWorld = {
  projects: [{ project_id: 'p1', name: 'Tower' }, { project_id: 'p2', name: 'Bridge' }],
  documents: {
    p1: [
      { guid: 'b0000000-0000-4000-8000-000000000001', filename: 'model.ifc', folder_url: '/documents/alpha',
        creation_date: '2026-01-01T00:00:00.000Z', versions: [version(1, 'OLD'), version(2, 'MODEL-1')] },
      { guid: 'b0000000-0000-4000-8000-000000000002', filename: 'plan.ifc', folder_url: '/documents/alpha',
        creation_date: '2026-01-02T00:00:00.000Z', versions: [version(1, 'MODEL-2')] },
      { guid: 'b0000000-0000-4000-8000-000000000003', filename: 'model-copy.ifc', folder_url: '/documents/alpha/sub',
        creation_date: '2026-01-03T00:00:00.000Z', versions: [version(1, 'MODEL-3')] },
      { guid: 'b0000000-0000-4000-8000-000000000004', filename: 'model-beta.ifc', folder_url: '/documents/beta',
        creation_date: '2026-01-04T00:00:00.000Z', versions: [version(1, 'MODEL-4')] },
    ],
    p2: [],
  },
};

describe('BuildagilProvider conformance', () => {
  const api = createMockApi(WORLD);
  beforeAll(() => api.signIn());
  runConformanceSuite(new BuildagilProvider({ clientId: 'client-1' }), {
    createContext: api.createContext,
    fixtures: {
      projectId: 'p1',
      secondProjectId: 'p2',
      containerWithChildrenId: '/documents/alpha',
      containerWithFilesId: '/documents/alpha',
      searchQuery: 'model',
      fileWithRevisions: { containerId: '/documents/alpha', fileId: 'b0000000-0000-4000-8000-000000000001' },
    },
    smallPageLimit: 1,
  });
});
