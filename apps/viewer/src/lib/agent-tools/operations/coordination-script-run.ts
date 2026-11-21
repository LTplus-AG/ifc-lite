/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import { useViewerStore } from '@/store';
import { viewerOperation } from './contract';
import { coordination } from './coordination-common';
import { coordinationOutputSchema } from './coordination-outputs';
export const coordinationScriptRunOperations = [
  viewerOperation<{ expected_revision: number }>({ id: 'script.execute', owner: 'script', description: 'Execute the exact current native editor source/revision through the same preflight, QuickJS permission defaults, native edit/role guards, limits, diagnostics, epoch ownership and deterministic teardown as the UI. No network sandbox permission is granted.',
    effects: ['read', 'configuration', 'view', 'selection', 'model', 'artifact'], capability: 'commands-and-edits', implementation: 'native-store', policy: { model: 'native-reviewed', artifact: 'native-export' }, outputSchema: coordinationOutputSchema('script.execute') }, {
    type: 'object', properties: { expected_revision: { type: 'integer', minimum: 0 } }, required: ['expected_revision'], additionalProperties: false,
  }, async (i, c) => {
    const { NativeScriptRunner } = await import('@/lib/scripts/native-script-runner');
    if (!c.host.bim) throw new Error('This host does not expose the native viewer SDK.');
    const state = useViewerStore.getState(), source = state.scriptEditorContent;
    if (state.scriptEditorRevision !== i.expected_revision || state.scriptExecutionState === 'running') throw new Error('Native editor revision changed or a script is already running.');
    const runner = new NativeScriptRunner(c.host.bim, { permissions: { network: false, export: false, files: false } }), cancel = () => runner.cancel(); c.signal?.addEventListener('abort', cancel, { once: true });
    try {
      return await c.commitAsync(async () => {
        if (useViewerStore.getState().scriptEditorRevision !== i.expected_revision) throw new Error('Native editor changed before script admission.');
        const cancellations = runner.cancellationCount; const pending = runner.execute(source); const epoch = useViewerStore.getState().scriptRunEpoch; if (c.signal?.aborted) cancel(); const result = await pending;
        // The store's error and diagnostics are this run's only while no later run has replaced its epoch.
        const own = useViewerStore.getState().scriptRunEpoch === epoch;
        // script.cancel stops the runner without aborting this call's signal; both are a cancellation.
        return { state: c.signal?.aborted || runner.cancelledSince(cancellations) ? 'cancelled' : result ? 'completed' : 'failed', result, error: own ? useViewerStore.getState().scriptLastError : null, diagnostics: own ? useViewerStore.getState().scriptLastDiagnostics : [] };
      });
    } finally { c.signal?.removeEventListener('abort', cancel); runner.dispose(); }
  }),
  coordination<{ expected_epoch: number }>('script.cancel', 'Cancel the exact currently executing native script epoch, including runs started by the editor, without cancelling a newer script.', ['configuration'], {
    type: 'object', properties: { expected_epoch: { type: 'integer', minimum: 0 } }, required: ['expected_epoch'], additionalProperties: false,
  }, async (i, c) => { const { cancelNativeScriptRun } = await import('@/lib/scripts/native-script-runner'); return c.commit(() => ({ cancellation_requested: cancelNativeScriptRun(i.expected_epoch), terminal: false })); }),
];
