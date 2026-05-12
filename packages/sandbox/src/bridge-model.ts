/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Bridge schema — bim.model namespace methods.
 */

import type { NamespaceSchema } from './bridge-schema.js';

export function buildModelNamespace(): NamespaceSchema {
  return {
    name: 'model',
    doc: 'Model operations',
    permission: 'model',
    methods: [
      {
        name: 'list',
        doc: 'List loaded models',
        args: [],
        tsReturn: 'BimModelInfo[]',
        call: (sdk) => sdk.model.list(),
        returns: 'value',
      },
      {
        name: 'active',
        doc: 'Get active model',
        args: [],
        tsReturn: 'BimModelInfo | null',
        call: (sdk) => sdk.model.active(),
        returns: 'value',
      },
      {
        name: 'activeId',
        doc: 'Get active model ID',
        args: [],
        tsReturn: 'string | null',
        call: (sdk) => sdk.model.activeId(),
        returns: 'value',
      },
      {
        name: 'loadIfc',
        doc: 'Load IFC content into the 3D viewer for preview',
        args: ['string', 'string'],
        paramNames: ['content', 'filename'],
        call: (sdk, args) => { sdk.model.loadIfc(args[0] as string, args[1] as string); },
        returns: 'void',
      },
    ],
  };
}
