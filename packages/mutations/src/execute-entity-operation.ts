/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import type { StoreEditor } from './store-editor.js';
import type { MutablePropertyView } from './mutable-property-view.js';
import type { EntityOperation, EntityOperationEffect } from './cooperative-operation-types.js';

/** Reuse the canonical editor, including type normalization, allocation and removal rules. */
export function executeEntityOperation(editor: StoreEditor, view: MutablePropertyView, operation: EntityOperation): EntityOperationEffect {
  if (!operation || !Number.isSafeInteger(operation.expressId) || operation.expressId <= 0) {
    throw new TypeError('Entity operations require a positive integral expressId.');
  }
  switch (operation.kind) {
    case 'create': {
      if (operation.expressId !== view.peekNextExpressId() || !Array.isArray(operation.attributes)) {
        throw new Error('Entity operation allocation changed or attributes are invalid.');
      }
      const entity = editor.addEntity(operation.type, operation.attributes);
      if (entity.expressId !== operation.expressId) throw new Error('Entity operation allocation changed.');
      return { kind: 'create', entity: editor.getNewEntity(entity.expressId)! };
    }
    case 'setPositionalAttribute': {
      if (!editor.hasEntity(operation.expressId) || !Number.isSafeInteger(operation.index) || operation.index < 0) {
        throw new Error('Invalid positional entity operation target.');
      }
      const attributes = view.getPositionalMutationsForEntity(operation.expressId);
      const effect: EntityOperationEffect = { kind: operation.kind, expressId: operation.expressId,
        index: operation.index, present: attributes?.has(operation.index) ?? false, value: attributes?.get(operation.index) };
      // The view owns skip-history semantics; StoreEditor owns ordinary writes.
      if (operation.skipHistory) view.setPositionalAttribute(operation.expressId, operation.index, operation.value, true);
      else editor.setPositionalAttribute(operation.expressId, operation.index, operation.value);
      return effect;
    }
    case 'remove': {
      const entity = editor.getNewEntity(operation.expressId);
      if (!editor.removeEntity(operation.expressId)) throw new Error(`Cannot remove missing IFC entity #${operation.expressId}.`);
      return { kind: operation.kind, expressId: operation.expressId, entity };
    }
    default: throw new TypeError('Unsupported entity operation.');
  }
}
