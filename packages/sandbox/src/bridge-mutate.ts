/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Bridge schema — bim.mutate namespace methods.
 */

import type { NamespaceSchema } from './bridge-schema.js';
import { toRef } from './bridge-helpers.js';

export function buildMutateNamespace(): NamespaceSchema {
  return {
    name: 'mutate',
    doc: 'Property editing',
    permission: 'mutate',
    methods: [
      {
        name: 'setProperty',
        doc: 'Set an IfcPropertySet or quantity value (not a root IFC attribute)',
        args: ['dump', 'string', 'string', 'dump'],
        paramNames: ['entity', 'psetName', 'propName', 'value'],
        call: (sdk, args) => {
          const ref = toRef(args[0]);
          if (!ref) {
            throw new Error('bim.mutate.setProperty: invalid entity reference');
          }
          sdk.mutate.setProperty(
            ref,
            args[1] as string,
            args[2] as string,
            args[3] as string | number | boolean,
          );
        },
        returns: 'void',
      },
      {
        name: 'setAttribute',
        doc: 'Set a root IFC attribute such as Name, Description, ObjectType, or Tag',
        args: ['dump', 'string', 'string'],
        paramNames: ['entity', 'attrName', 'value'],
        call: (sdk, args) => {
          const ref = toRef(args[0]);
          if (!ref) {
            throw new Error('bim.mutate.setAttribute: invalid entity reference');
          }
          sdk.mutate.setAttribute(
            ref,
            args[1] as string,
            args[2] as string,
          );
        },
        returns: 'void',
      },
      {
        name: 'deleteProperty',
        doc: 'Delete a property',
        args: ['dump', 'string', 'string'],
        paramNames: ['entity', 'psetName', 'propName'],
        call: (sdk, args) => {
          const ref = toRef(args[0]);
          if (!ref) {
            throw new Error('bim.mutate.deleteProperty: invalid entity reference');
          }
          sdk.mutate.deleteProperty(
            ref,
            args[1] as string,
            args[2] as string,
          );
        },
        returns: 'void',
      },
      // Note: batch is intentionally omitted — it takes a callback in the SDK
      // but QuickJS cannot marshal functions through vm.dump(). Scripts should
      // use individual setProperty calls instead.
      {
        name: 'undo',
        doc: 'Undo last mutation',
        args: ['string'],
        paramNames: ['modelId'],
        call: (sdk, args) => {
          sdk.mutate.undo(args[0] as string);
        },
        returns: 'void',
      },
      {
        name: 'redo',
        doc: 'Redo undone mutation',
        args: ['string'],
        paramNames: ['modelId'],
        call: (sdk, args) => {
          sdk.mutate.redo(args[0] as string);
        },
        returns: 'void',
      },
    ],
  };
}
