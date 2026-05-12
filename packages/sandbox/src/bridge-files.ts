/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Bridge schema — bim.files namespace methods.
 */

import type { NamespaceSchema } from './bridge-schema.js';

export function buildFilesNamespace(): NamespaceSchema {
  return {
    name: 'files',
    doc: 'Uploaded file attachments',
    permission: 'files',
    methods: [
      {
        name: 'list',
        doc: 'List uploaded file attachments available to scripts',
        args: [],
        tsReturn: 'BimFileAttachment[]',
        call: (sdk) => sdk.files.list(),
        returns: 'value',
      },
      {
        name: 'text',
        doc: 'Get raw text content for an uploaded attachment by file name',
        args: ['string'],
        paramNames: ['name'],
        tsReturn: 'string | null',
        call: (sdk, args) => sdk.files.text(args[0] as string),
        returns: 'value',
        llmSemantics: {
          taskTags: ['inspect', 'modify', 'repair', 'export'],
          useWhen: 'Read uploaded CSV, TSV, JSON, or text attachments without using fetch().',
        },
      },
      {
        name: 'csv',
        doc: 'Get parsed CSV/TSV rows for an uploaded attachment by file name',
        args: ['string'],
        paramNames: ['name'],
        tsReturn: 'Record<string, string>[] | null',
        call: (sdk, args) => sdk.files.csv(args[0] as string),
        returns: 'value',
        llmSemantics: {
          taskTags: ['inspect', 'modify', 'repair', 'export'],
          useWhen: 'Load uploaded CSV rows directly inside a script and join them against model entities.',
        },
      },
      {
        name: 'csvColumns',
        doc: 'Get parsed CSV column names for an uploaded attachment by file name',
        args: ['string'],
        paramNames: ['name'],
        tsReturn: 'string[]',
        call: (sdk, args) => sdk.files.csvColumns(args[0] as string),
        returns: 'value',
      },
    ],
  };
}
