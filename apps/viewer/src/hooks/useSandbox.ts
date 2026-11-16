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
  const runner = useMemo(() => new NativeScriptRunner(bim, config), [bim, config?.permissions, config?.limits]);
  useEffect(() => () => runner.dispose(), [runner]);
  const execute = useCallback((source: string) => runner.execute(source), [runner]);
  const reset = useCallback(() => runner.reset(), [runner]);
  return { execute, reset };
}
