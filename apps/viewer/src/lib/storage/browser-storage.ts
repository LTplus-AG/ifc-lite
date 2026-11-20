/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

const REQUEST_KEY = 'ifc-lite:storage-persistence-request';
type PersistenceState = 'persisted' | 'bestEffort' | 'unsupported';
type PersistenceStatus = { state: PersistenceState; canRequest: boolean };
const unsupported: PersistenceStatus = { state: 'unsupported', canRequest: false };

function storageManager(): StorageManager | undefined {
  if (typeof window === 'undefined' || window.top !== window) return undefined;
  return navigator.storage;
}

/** One request per browser profile and origin, with an in-memory guard if storage is blocked. */
export function createStoragePersistence() {
  let attempted = false;
  let pending: Promise<PersistenceStatus> | undefined;

  const remember = (outcome: string) => {
    try {
      window.localStorage.setItem(REQUEST_KEY, outcome);
    } catch (error) {
      console.debug('[Browser storage] Could not remember persistence request', error);
    }
  };

  const alreadyRequested = () => {
    if (attempted) return true;
    try {
      return window.localStorage.getItem(REQUEST_KEY) !== null;
    } catch (error) {
      console.debug('[Browser storage] Could not read saved persistence request', error);
      return false;
    }
  };

  const read = async (): Promise<PersistenceStatus> => {
    if (pending) return pending;
    try {
      const storage = storageManager();
      if (typeof storage?.persisted !== 'function') return unsupported;
      if (await storage.persisted()) return { state: 'persisted', canRequest: false };
      if (typeof storage.persist !== 'function') return unsupported;
      return { state: 'bestEffort', canRequest: !alreadyRequested() };
    } catch (error) {
      console.debug('[Browser storage] Could not read persistence status', error);
      return unsupported;
    }
  };

  const request = async (): Promise<PersistenceStatus> => {
    try {
      const storage = storageManager();
      if (typeof storage?.persist !== 'function' || typeof storage.persisted !== 'function') return unsupported;
      if (alreadyRequested()) return read();
      attempted = true;
      // Record the attempt before invoking the browser so a reload or another tab
      // opened while permission is pending cannot immediately prompt again.
      remember('requested');
      const granted = await storage.persist();
      remember(granted ? 'granted' : 'denied');
      return { state: granted ? 'persisted' : 'bestEffort', canRequest: false };
    } catch (error) {
      if (attempted) remember('unavailable');
      console.debug('[Browser storage] Could not request persistence', error);
      return unsupported;
    }
  };

  return {
    read,
    async request(): Promise<PersistenceStatus> {
      if (pending) return pending;
      pending = request();
      try {
        return await pending;
      } finally {
        pending = undefined;
      }
    },
  };
}

export const storagePersistence = createStoragePersistence();

export async function estimateBrowserStorage(): Promise<StorageEstimate | undefined> {
  try {
    return await storageManager()?.estimate?.();
  } catch (error) {
    console.debug('[Browser storage] Could not estimate origin usage', error);
    return undefined;
  }
}
