/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Bridge schema — bim.export namespace methods.
 */

import type { EntityRef } from '@ifc-lite/sdk';
import type { NamespaceSchema } from './bridge-schema.js';

export function buildExportNamespace(): NamespaceSchema {
  return {
    name: 'export',
    doc: 'Data export',
    permission: 'export',
    methods: [
      {
        name: 'csv',
        doc: 'Export entities to CSV string',
        args: ['entityRefs', 'dump'],
        paramNames: ['entities', 'options'],
        tsParamTypes: [undefined, '{ columns: string[]; filename?: string; separator?: string }'],
        tsReturn: 'string',
        call: (sdk, args) => {
          return sdk.export.csv(
            args[0] as EntityRef[],
            args[1] as { columns: string[]; separator?: string },
          );
        },
        returns: 'string',
      },
      {
        name: 'json',
        doc: 'Export entities to JSON array',
        args: ['entityRefs', 'dump'],
        paramNames: ['entities', 'columns'],
        tsParamTypes: [undefined, 'string[]'],
        tsReturn: 'Record<string, unknown>[]',
        call: (sdk, args) => {
          return sdk.export.json(
            args[0] as EntityRef[],
            args[1] as string[],
          );
        },
        returns: 'value',
      },
      {
        name: 'ifc',
        doc: 'Export entities to IFC STEP text. Pass filename to auto-download a valid .ifc file',
        args: ['entityRefs', 'dump'],
        paramNames: ['entities', 'options'],
        tsParamTypes: [undefined, '{ schema?: "IFC2X3" | "IFC4" | "IFC4X3"; filename?: string; includeMutations?: boolean; visibleOnly?: boolean }'],
        tsReturn: 'string | Uint8Array',
        call: (sdk, args) => {
          return sdk.export.ifc(
            args[0] as EntityRef[],
            args[1] as {
              schema?: 'IFC2X3' | 'IFC4' | 'IFC4X3';
              filename?: string;
              includeMutations?: boolean;
              visibleOnly?: boolean;
            },
          );
        },
        returns: 'value',
      },
      {
        name: 'download',
        doc: 'Trigger a browser file download with the given content. mimeType defaults to text/plain.',
        args: ['string', 'string', 'string'],
        paramNames: ['content', 'filename', 'mimeType'],
        tsParamTypes: [undefined, undefined, 'string | undefined'],
        call: (sdk, args) => {
          sdk.export.download(
            args[0] as string,
            args[1] as string,
            (args[2] as string) || 'text/plain',
          );
        },
        returns: 'void',
      },
    ],
  };
}
