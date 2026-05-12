/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Mutations integration (spec §16.3).
 *
 * `@ifc-lite/mutations` ships `MutablePropertyView` for property-level
 * editing in legacy STEP IFC code paths. The spec promises that when
 * a collab session is bound, those mutations also broadcast through
 * the Y.Doc — and when no session is bound, behaviour is unchanged.
 *
 * `bindMutationsToCollab(view, session, opts)` returns a thin wrapper
 * around the view that calls the original method first (so all
 * existing observers / change-set tracking still fire), then mirrors
 * the same write to the bound `CollabSession`.
 *
 * The bridge needs a way to translate the numeric `entityId` used by
 * the legacy view into the path-shaped identifier used by IFCX. Apps
 * provide a `resolveEntity(id)` callback (typically backed by their
 * `pathToId` / `idToPath` map from `@ifc-lite/ifcx`).
 */

import type { MutablePropertyView } from '@ifc-lite/mutations';
import { PropertyValueType, type PropertyValue as DataPropertyValue } from '@ifc-lite/data';
import type { CollabSession } from '../session.js';
import {
  deletePropertyValue,
  setPropertyValue,
} from '../doc/entity.js';
import type { PropertyValue } from '../doc/schema.js';

export interface BindMutationsOptions {
  /**
   * Translate a numeric `entityId` into the corresponding IFCX path.
   * Returning `null` skips the CRDT mirror for this mutation (the
   * local view still updates).
   */
  resolveEntity: (entityId: number) => string | null;
  /**
   * Optional translation between the legacy `PropertyValueType` enum
   * and the IFCX-shaped string we store in the Y.Doc. Defaults to
   * `PROPERTY_TYPE_NAMES`.
   */
  typeNameFor?: (vt: PropertyValueType) => string;
  /**
   * If true, only mirror writes when `session.provider !== 'memory'`.
   * Useful when consumers want to share-bind only after the websocket
   * upgrade has happened. Default false.
   */
  onlyWhenConnected?: boolean;
}

export const PROPERTY_TYPE_NAMES: Record<PropertyValueType, string> = {
  [PropertyValueType.String]: 'IfcText',
  [PropertyValueType.Real]: 'IfcReal',
  [PropertyValueType.Integer]: 'IfcInteger',
  [PropertyValueType.Boolean]: 'IfcBoolean',
  [PropertyValueType.Logical]: 'IfcLogical',
  [PropertyValueType.Label]: 'IfcLabel',
  [PropertyValueType.Identifier]: 'IfcIdentifier',
  [PropertyValueType.Text]: 'IfcText',
  [PropertyValueType.Enum]: 'IfcLabel',
  [PropertyValueType.Reference]: 'IfcLabel',
  [PropertyValueType.List]: 'IfcText',
};

export interface BoundPropertyView {
  setProperty(
    entityId: number,
    psetName: string,
    propName: string,
    value: string | number | boolean,
    valueType?: PropertyValueType,
    unit?: string,
  ): unknown;
  deleteProperty(entityId: number, psetName: string, propName: string): unknown;
  /** Pass-through to the underlying view's read API. */
  getPropertyValue(entityId: number, psetName: string, propName: string): unknown;
  /** The wrapped MutablePropertyView for advanced use. */
  readonly view: MutablePropertyView;
}

/**
 * Wrap a `MutablePropertyView` so writes mirror to a bound
 * `CollabSession`. Reads pass through.
 */
export function bindMutationsToCollab(
  view: MutablePropertyView,
  session: CollabSession,
  options: BindMutationsOptions,
): BoundPropertyView {
  const typeNameFor = options.typeNameFor ?? ((vt: PropertyValueType) => PROPERTY_TYPE_NAMES[vt] ?? 'IfcLabel');

  const shouldMirror = (): boolean => {
    if (!options.onlyWhenConnected) return true;
    return session.provider !== 'memory';
  };

  return {
    view,
    setProperty(entityId, psetName, propName, value, valueType = PropertyValueType.Label, unit) {
      // `BoundPropertyView.setProperty` only exposes scalar values
      // (string | number | boolean), which is a subset of
      // `@ifc-lite/data`'s PropertyValue (which also allows null and
      // recursive arrays). Widen explicitly to the upstream type
      // rather than silencing the type checker with `as never`.
      const result = view.setProperty(
        entityId,
        psetName,
        propName,
        value as DataPropertyValue,
        valueType,
        unit,
      );
      if (shouldMirror()) {
        const path = options.resolveEntity(entityId);
        if (path) {
          const pv: PropertyValue = {
            type: typeNameFor(valueType),
            value: value as PropertyValue['value'],
            unit,
            source: 'mutation',
          };
          session.transact(() => setPropertyValue(session.doc, path, psetName, propName, pv));
        }
      }
      return result;
    },
    deleteProperty(entityId, psetName, propName) {
      const result = view.deleteProperty(entityId, psetName, propName);
      if (shouldMirror()) {
        const path = options.resolveEntity(entityId);
        if (path) {
          session.transact(() => deletePropertyValue(session.doc, path, psetName, propName));
        }
      }
      return result;
    },
    getPropertyValue(entityId, psetName, propName) {
      return view.getPropertyValue(entityId, psetName, propName);
    },
  };
}
