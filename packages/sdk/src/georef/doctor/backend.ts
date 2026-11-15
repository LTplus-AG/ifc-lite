/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The headless backend's `bim.georef` methods: the session's read and write,
 * the IfcSite write, and the doctor. A check of a session with unsaved edits
 * diagnoses the bytes an export would write (re-parsed), so what it reports
 * is what the saved file will say.
 */

import { parseModel, type IfcDataStore } from '@ifc-lite/parser';
import type { GeoreferencingSession } from '../session.js';
import type { GeoreferencingBackendMethods } from '../types.js';
import { applyGeorefFixPlan } from './apply.js';
import { checkGeoreferencing } from './check.js';

export interface GeorefBackendDeps {
  session: GeoreferencingSession;
  store: IfcDataStore;
  assertKnownModelId(modelId: string): void;
  hasPendingChanges(): boolean;
  /** The session exported as STEP text, edits included. */
  exportIfc(): string;
}

export function createGeorefBackendMethods(deps: GeorefBackendDeps): GeoreferencingBackendMethods {
  const assert = (modelId?: string) => { if (modelId) deps.assertKnownModelId(modelId); };
  const { session } = deps;
  return {
    get: (m) => { assert(m); return session.get(); },
    write: (request, m) => { assert(m); return session.write(request); },
    writeSite: (input, m) => { assert(m); return session.writeSite(input); },
    async check(options, m) {
      assert(m);
      if (!deps.hasPendingChanges()) return checkGeoreferencing(deps.store, options);
      const { store } = await parseModel(new TextEncoder().encode(deps.exportIfc()), { disableWorkerScan: true });
      return checkGeoreferencing(store, options, true);
    },
    fix: (plan, m) => {
      assert(m);
      return applyGeorefFixPlan({
        write: (request) => session.write(request),
        writeSite: (input) => session.writeSite(input),
        validateSite: (input) => session.validateSite(input),
      }, plan);
    },
  };
}
