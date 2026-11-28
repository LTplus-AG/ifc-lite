/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { type ComponentType } from 'react';

export function lazyToolComponent(load: () => Promise<ComponentType>): { Component: ComponentType; ready: () => Promise<void> } {
  let loaded: ComponentType | null = null;
  let pending: Promise<ComponentType> | null = null;
  const start = (): Promise<ComponentType> => {
    pending ??= load().then(
      (component) => { loaded = component; return component; },
      (error: unknown) => { pending = null; throw error; }, // a later open tries the network again
    );
    return pending;
  };
  const Component: ComponentType = () => {
    const started = start();
    if (!loaded) throw started;
    const Loaded = loaded;
    return <Loaded />;
  };
  return { Component, ready: async () => { await start(); } };
}
