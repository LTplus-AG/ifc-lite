/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import { useEffect, useMemo, useCallback } from 'react';
import { useBim } from '../sdk/BimProvider.js';
import type { SandboxConfig } from '@ifc-lite/sandbox';
import { NativeScriptRunner } from '@/lib/scripts/native-script-runner';
/** React owns one native runner instance; domain execution and cancellation do not depend on the panel. */
export function useSandbox(config?: SandboxConfig) {
  const bim = useBim();
  // Keyed by the config's contents, so an inline object does not dispose a live run on every rerender.
  // A network transport is a function, so it keys by identity.
  const configKey = JSON.stringify([config?.permissions ?? null, config?.limits ?? null, config?.network?.grants ?? null]);
  const transport = config?.network?.transport;
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const runner = useMemo(() => new NativeScriptRunner(bim, config), [bim, configKey, transport]);
  useEffect(() => () => runner.dispose(), [runner]);
  const execute = useCallback((source: string) => runner.execute(source), [runner]);
  const reset = useCallback(() => runner.reset(), [runner]);
  return { execute, reset };
}
