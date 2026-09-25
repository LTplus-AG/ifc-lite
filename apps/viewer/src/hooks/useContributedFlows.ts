/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { useEffect, useState } from 'react';
import { useOptionalExtensionHost } from '@/sdk/ExtensionHostProvider.js';
import type { ResolveFlowContributionsResult } from '@/services/extensions/host-flows.js';

/** The contributed graphs, and whether the host has answered at least once. */
export interface ContributedFlowsState extends ResolveFlowContributionsResult {
  /**
   * False until the first list arrives. An empty list before then means
   * "not asked yet", not "uninstalled", so it must not close an open graph.
   */
  readonly loaded: boolean;
}

const LOADING: ContributedFlowsState = { graphs: [], diagnostics: [], loaded: false };
const NONE: ContributedFlowsState = { graphs: [], diagnostics: [], loaded: true };

/**
 * Live list of extension-contributed flow graphs (#5167 phase 4.2).
 * Refreshes whenever the host service's "anything changed" signal fires
 * (install/uninstall/enable/disable) — same pattern as
 * `useInstalledExtensions`.
 */
export function useContributedFlows(): ContributedFlowsState {
  const host = useOptionalExtensionHost();
  const [state, setState] = useState<ContributedFlowsState>(LOADING);

  useEffect(() => {
    if (!host) {
      setState(NONE);
      return;
    }
    let cancelled = false;
    const refresh = async () => {
      try {
        const next = await host.listContributedFlows();
        if (!cancelled) setState({ ...next, loaded: true });
      } catch (err) {
        console.error('[useContributedFlows] listContributedFlows failed:', err);
        // Fail closed: keeping the previous list would keep a graph from an
        // extension that may be gone open and runnable (#5431 review).
        if (!cancelled) setState(NONE);
      }
    };
    void refresh();
    const off = host.onChange(() => {
      void refresh();
    });
    return () => {
      cancelled = true;
      off();
    };
  }, [host]);

  return state;
}
