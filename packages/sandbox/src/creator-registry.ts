/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Session-scoped IfcCreator instance registry.
 *
 * Each sandbox session can create multiple IfcCreator instances (via
 * `bim.create.project()`). This registry maps opaque numeric handles
 * back to the underlying IfcCreator so the bridge layer can route calls.
 */

import { IfcCreator } from '@ifc-lite/sdk';

/** Simple registry for IfcCreator instances managed by the sandbox */
export const creatorRegistry = (() => {
  const nextHandleBySession = new Map<string, number>();
  const creatorsBySession = new Map<string, Map<number, IfcCreator>>();

  function getSessionCreators(sessionId: string): Map<number, IfcCreator> {
    let sessionCreators = creatorsBySession.get(sessionId);
    if (!sessionCreators) {
      sessionCreators = new Map<number, IfcCreator>();
      creatorsBySession.set(sessionId, sessionCreators);
    }
    return sessionCreators;
  }

  return {
    registerForSession(sessionId: string, creator: IfcCreator): number {
      const handle = nextHandleBySession.get(sessionId) ?? 1;
      nextHandleBySession.set(sessionId, handle + 1);
      getSessionCreators(sessionId).set(handle, creator);
      return handle;
    },

    getForSession(sessionId: string, handle: number): IfcCreator {
      const creator = creatorsBySession.get(sessionId)?.get(handle);
      if (!creator) throw new Error(`Invalid creator handle: ${handle}`);
      return creator;
    },

    removeForSession(sessionId: string, handle: number): void {
      const sessionCreators = creatorsBySession.get(sessionId);
      if (!sessionCreators) return;
      sessionCreators.delete(handle);
      if (sessionCreators.size === 0) {
        creatorsBySession.delete(sessionId);
        nextHandleBySession.delete(sessionId);
      }
    },

    removeSession(sessionId: string): void {
      creatorsBySession.delete(sessionId);
      nextHandleBySession.delete(sessionId);
    },
  };
})();
