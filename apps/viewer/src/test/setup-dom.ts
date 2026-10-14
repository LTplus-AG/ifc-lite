/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * happy-dom global registration for React rendering tests (#1907).
 *
 * Import this module FIRST in a `.test.tsx` file: ESM evaluates imported
 * modules in declaration order, so putting this import above `react-dom`
 * (and anything that transitively pulls it in) guarantees `window`,
 * `document`, `HTMLElement` etc. exist before React's module bodies run.
 *
 * There is deliberately no `unregister()` counterpart: the node test
 * runner executes each test file in its own child process, and code under
 * test schedules trailing timers (toast dismissal, blob-URL revocation)
 * that would blow up if the DOM globals disappeared underneath them.
 */

import { GlobalRegistrator } from '@happy-dom/global-registrator';

// Node's own `AbortSignal.timeout`, captured before registration swaps the
// global for happy-dom's class.
const platformTimeoutSignal = AbortSignal.timeout.bind(AbortSignal);

GlobalRegistrator.register({ url: 'http://localhost/' });

// happy-dom re-implements `AbortSignal.timeout` on a plain window timer, so
// every request bounded by `AbortSignal.timeout(ms)` held the test process
// open for the full `ms` after the request had finished (a minute per file for
// the OpenCDE and sandbox network clients). No platform behaves that way: a
// browser timeout signal does not outlive its page and Node's does not keep
// the process alive. Keep happy-dom's AbortSignal class and its TimeoutError
// reason, which code under test sees, and take only the timing from Node.
AbortSignal.timeout = (ms: number): AbortSignal => {
  const controller = new AbortController();
  platformTimeoutSignal(ms).addEventListener(
    'abort',
    () => controller.abort(new DOMException('signal timed out', 'TimeoutError')),
    { once: true },
  );
  return controller.signal;
};

// React 19's `act()` (and `createRoot` in tests) requires the environment
// to opt in explicitly; without this flag every act() call warns and
// updates are not flushed act-style.
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
