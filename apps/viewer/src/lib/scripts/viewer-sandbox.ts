/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import type { BimContext } from '@ifc-lite/sdk';
import type { SandboxConfig, ScriptResult } from '@ifc-lite/sandbox';
import { prepareSandboxStepExport } from '@/sdk/sdk-step-writer';
import { disposeSandboxReportingAbort } from '@/lib/sandboxAbort';
/** The panel's existing permission defaults, shared with parameterized native runners. */
export async function createViewerSandbox(bim: BimContext, config?: SandboxConfig) {
  const [{ createSandbox }] = await Promise.all([
    import('@ifc-lite/sandbox'),
    config?.permissions?.export !== false && prepareSandboxStepExport(),
  ]);
  return createSandbox(bim, {
    permissions: { model: true, query: true, viewer: true, mutate: true, store: true, lens: true, export: true, files: true, ...config?.permissions },
    limits: { timeoutMs: 30_000, ...config?.limits },
    network: config?.network,
  });
}
/** A fresh QuickJS VM with only query access; no host eval, files, network or model-loading namespace. */
export async function analyzeViewerScript(bim: BimContext, source: string, limits: { timeoutMs: number; memoryBytes: number }, signal?: AbortSignal): Promise<ScriptResult> {
  signal?.throwIfAborted();
  const sandbox = await createViewerSandbox(bim, { permissions: { model: false, query: true, viewer: false, mutate: false, store: false, lens: false, export: false, files: false, network: false }, limits });
  let disposed = false, teardownFailure: string | null = null;
  const dispose = () => { if (!disposed) { disposed = true; teardownFailure = disposeSandboxReportingAbort(sandbox); } };
  signal?.addEventListener('abort', dispose, { once: true });
  try {
    signal?.throwIfAborted(); const result = await sandbox.eval(source); dispose(); signal?.throwIfAborted();
    if (teardownFailure) throw new Error(teardownFailure); return result;
  } finally { signal?.removeEventListener('abort', dispose); dispose(); }
}
