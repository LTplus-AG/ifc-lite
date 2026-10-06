/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * React commit counts per load (#6957), as the `react.commits` counter.
 *
 * Not a `<Profiler>`: React compiles Profiler's `onRender` out of its
 * production build, and the benchmark (and every user) runs that build, so a
 * Profiler at the root would count zero. Production React still reports every
 * commit to the DevTools global hook (`onCommitFiberRoot`), which is what this
 * listens to: it chains onto an installed React DevTools hook, or installs a
 * minimal one. React reads the hook once, when react-dom loads, so this module
 * is imported by `bootstrap.tsx` BEFORE React, and only acts under `?perfTrace=1`.
 */

import { perfCount } from '@ifc-lite/load-trace';
import { PERF_TRACE_ENABLED } from './perfTraceFlag.js';

const HOOK_KEY = '__REACT_DEVTOOLS_GLOBAL_HOOK__';

interface DevtoolsHook {
  supportsFiber?: boolean;
  inject?: (renderer: unknown) => number;
  onCommitFiberRoot?: (...args: unknown[]) => void;
  [key: string]: unknown;
}

export function installReactCommitCounter(target: Record<string, unknown> = globalThis as Record<string, unknown>): void {
  const existing = target[HOOK_KEY] as DevtoolsHook | undefined;
  if (existing && typeof existing === 'object') {
    const chained = existing.onCommitFiberRoot;
    existing.onCommitFiberRoot = (...args: unknown[]) => {
      perfCount('react.commits');
      chained?.apply(existing, args);
    };
    return;
  }
  let nextId = 1;
  const hook: DevtoolsHook = {
    supportsFiber: true,
    renderers: new Map<number, unknown>(),
    inject(renderer) {
      const id = nextId++;
      (hook.renderers as Map<number, unknown>).set(id, renderer);
      return id;
    },
    onCommitFiberRoot: () => perfCount('react.commits'),
    onCommitFiberUnmount: () => {},
    onPostCommitFiberRoot: () => {},
    checkDCE: () => {},
  };
  target[HOOK_KEY] = hook;
}

if (PERF_TRACE_ENABLED) installReactCommitCounter();
