/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Bridge schema — bim.viewer namespace methods.
 */

import type { EntityRef } from '@ifc-lite/sdk';
import type { NamespaceSchema } from './bridge-schema.js';

export function buildViewerNamespace(): NamespaceSchema {
  return {
    name: 'viewer',
    doc: 'Viewer control',
    permission: 'viewer',
    methods: [
      {
        name: 'colorize',
        doc: "Colorize entities e.g. '#ff0000'",
        args: ['entityRefs', 'string'],
        paramNames: ['entities', 'color'],
        call: (sdk, args) => {
          sdk.viewer.colorize(args[0] as EntityRef[], args[1] as string);
        },
        returns: 'void',
      },
      {
        name: 'colorizeAll',
        doc: 'Batch colorize with [{entities, color}]',
        args: ['dump'],
        paramNames: ['batches'],
        tsParamTypes: ['Array<{ entities: BimEntity[]; color: string }>'],
        tsReturn: 'void',
        call: (sdk, args) => {
          // batches: Array<{ entities: EntityData[], color: string }>
          // Extract .ref from entity data objects and pass to SDK
          const raw = args[0] as Array<{ entities: Array<{ ref?: EntityRef } & EntityRef>; color: string }>;
          const batches = raw.map(b => ({
            refs: b.entities.map(e => e.ref ?? e),
            color: b.color,
          }));
          sdk.viewer.colorizeAll(batches);
        },
        returns: 'void',
      },
      {
        name: 'hide',
        doc: 'Hide entities',
        args: ['entityRefs'],
        paramNames: ['entities'],
        call: (sdk, args) => {
          sdk.viewer.hide(args[0] as EntityRef[]);
        },
        returns: 'void',
      },
      {
        name: 'show',
        doc: 'Show entities',
        args: ['entityRefs'],
        paramNames: ['entities'],
        call: (sdk, args) => {
          sdk.viewer.show(args[0] as EntityRef[]);
        },
        returns: 'void',
      },
      {
        name: 'isolate',
        doc: 'Isolate entities',
        args: ['entityRefs'],
        paramNames: ['entities'],
        call: (sdk, args) => {
          sdk.viewer.isolate(args[0] as EntityRef[]);
        },
        returns: 'void',
      },
      {
        name: 'select',
        doc: 'Select entities',
        args: ['entityRefs'],
        paramNames: ['entities'],
        call: (sdk, args) => {
          sdk.viewer.select(args[0] as EntityRef[]);
        },
        returns: 'void',
      },
      {
        name: 'flyTo',
        doc: 'Fly camera to entities',
        args: ['entityRefs'],
        paramNames: ['entities'],
        call: (sdk, args) => {
          sdk.viewer.flyTo(args[0] as EntityRef[]);
        },
        returns: 'void',
      },
      {
        name: 'resetColors',
        doc: 'Reset all colors',
        args: [],
        call: (sdk) => {
          sdk.viewer.resetColors();
        },
        returns: 'void',
      },
      {
        name: 'resetVisibility',
        doc: 'Reset all visibility',
        args: [],
        call: (sdk) => {
          sdk.viewer.resetVisibility();
        },
        returns: 'void',
      },
    ],
  };
}
