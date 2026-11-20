/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import type { BimContext } from '@ifc-lite/sdk';
import type { Sandbox, ScriptResult, SandboxConfig } from '@ifc-lite/sandbox';
import { useViewerStore } from '@/store';
import { captureAnalysisStamp, stampAnalysisReport } from '@/hooks/useAnalysisStaleness';
import { validateScriptPreflightDetailed } from '@/lib/llm/script-preflight';
import { createRuntimeDiagnostic, formatDiagnosticsForDisplay, type RuntimeScriptDiagnostic } from '@/lib/llm/script-diagnostics';
import { describeSandboxAbort, disposeSandboxReportingAbort } from '@/lib/sandboxAbort';
/** Type guard for ScriptError shape (has logs + durationMs) */
function isScriptError(err: unknown): err is { message: string; logs: Array<{ level: string; args: unknown[]; timestamp: number }>; durationMs: number } {
  return (
    err !== null &&
    typeof err === 'object' &&
    'logs' in err &&
    Array.isArray((err as Record<string, unknown>).logs) &&
    'durationMs' in err &&
    typeof (err as Record<string, unknown>).durationMs === 'number'
  );
}

function augmentScriptError(message: string, code?: string): { message: string; diagnostics: RuntimeScriptDiagnostic[] } {
  const lower = message.toLowerCase();
  const source = code ?? '';
  const missingIdent = /['"]([A-Za-z_]\w*)['"] is not defined/i.exec(message)?.[1];
  const looksDetachedCreateSnippet = /\bbim\.create\.[A-Za-z]+\(\s*h\s*,/.test(source)
    && !/\b(?:const|let|var)\s+h\b/.test(source)
    && !/bim\.create\.project\(/.test(source);
  const looksElevationDoubledScript = /\bbim\.create\.addIfc\w+\(/.test(source)
    && /\baddIfcBuildingStorey\(/.test(source)
    && /\bconst\s+elevation\b/.test(source);

  if (lower.includes(`can't access property "location", placement is undefined`)) {
    const diagnostic = createRuntimeDiagnostic(
      'generic_placement_contract',
      'Likely cause: a generic `bim.create.addElement(...)` payload is using `Position` or missing `Placement.Location`. Use `Placement: { Location: [x, y, z] }` and `Depth`.',
      'error',
      { methodName: 'addElement', symbol: 'Placement.Location', fixHint: 'Use `Placement: { Location: [...] }` and include `Depth`.' },
    );
    return { message: `${message}\n${diagnostic.message}`, diagnostics: [diagnostic] };
  }
  if (lower.includes('invalid creator handle')) {
    const diagnostic = createRuntimeDiagnostic(
      'generic_placement_contract',
      'Likely cause: the script finalized or invalidated the active creator handle before later create calls completed. Move `bim.create.toIfc(h)` to the end and do not reuse a finalized handle.',
      'error',
      {
        symbol: 'h',
        failureKind: 'creator_lifecycle',
        rootCauseKey: 'creator_lifecycle_violation',
        repairScope: 'structural',
        fixHint: 'Finalize the model only once, after all create calls are done.',
      },
    );
    return { message: `${message}\n${diagnostic.message}`, diagnostics: [diagnostic] };
  }
  if (lower.includes(`can't access property "tostring", v is undefined`)) {
    if (/\bbim\.create\.addIfcPlate\(/.test(source) && /\bHeight\s*:/.test(source) && !/\bDepth\s*:/.test(source)) {
      const diagnostic = createRuntimeDiagnostic(
        'plate_contract_mismatch',
        'Likely cause: `bim.create.addIfcPlate(...)` was given slab-style keys. Re-check the plate contract and use `Position`, `Width`, `Depth`, and `Thickness` instead of `Height`.',
        'error',
        { methodName: 'addIfcPlate', symbol: 'Height', fixHint: 'Use `Position`, `Width`, `Depth`, and `Thickness` for plates.' },
      );
      return { message: `${message}\n${diagnostic.message}`, diagnostics: [diagnostic] };
    }
    if (looksElevationDoubledScript) {
      const diagnostic = createRuntimeDiagnostic(
        'storey_elevation_double_applied',
        'Likely cause: a repeated create call inside a storey loop is writing the level elevation into its Z coordinate. Every `bim.create.addIfc*(h, storey, ...)` coordinate is already relative to that storey, whose placement carries `Elevation`, so this puts the element at 2x the level height.',
        'error',
        {
          failureKind: 'storey_elevation_double_applied',
          repairScope: 'block',
          fixHint: 'Use storey-relative Z (usually `0`) in `Start`, `End`, or `Position` — do not add the level elevation.',
        },
      );
      return { message: `${message}\n${diagnostic.message}`, diagnostics: [diagnostic] };
    }
    return {
      message: `${message}\nLikely cause: a required numeric geometry field is missing or undefined (commonly \`Elevation\`, \`Width\`, \`Depth\`, \`Height\`, or \`Thickness\`). Re-check the exact required keys for the create method you called.`,
      diagnostics: [],
    };
  }
  if (lower.includes(`'position' is not defined`) || lower.includes(`"position" is not defined`)) {
    return {
      message: `${message}\nLikely cause: the script contains a malformed BIM object literal or transpilation fallback corrupted a plain JS key like \`Position: [...]\`. Re-send the exact object with explicit key-value pairs.`,
      diagnostics: [],
    };
  }
  if (missingIdent && ['h', 'storey', 'width', 'depth', 'i', 'z'].includes(missingIdent) && looksDetachedCreateSnippet) {
    const diagnostic = createRuntimeDiagnostic(
      'detached_snippet_scope',
      `Likely cause: the fix replaced the full script with a detached fragment that still depends on outer variables like \`${missingIdent}\`. Preserve the surrounding project/storey/loop context and patch the existing script in place.`,
      'error',
      {
        symbol: missingIdent,
        failureKind: 'detached_snippet',
        repairScope: 'structural',
        fixHint: 'Patch the existing script instead of returning a smaller fragment.',
      },
    );
    return { message: `${message}\n${diagnostic.message}`, diagnostics: [diagnostic] };
  }
  if (lower.includes('rotated') && lower.includes('window') && lower.includes('wall')) {
    const diagnostic = createRuntimeDiagnostic(
      'wall_hosted_opening_alignment',
      'Likely cause: a standalone `bim.create.addIfcWindow(...)` was used where a wall-hosted insert was needed. Use `bim.create.addIfcWallWindow(...)` or wall `Openings` for wall-aligned placement.',
      'error',
      { methodName: 'addIfcWindow', fixHint: 'Use `addIfcWallWindow(...)` or wall `Openings` for wall-aligned placement.' },
    );
    return { message: `${message}\n${diagnostic.message}`, diagnostics: [diagnostic] };
  }
  return { message, diagnostics: [] };
}

const activeRunners = new Set<NativeScriptRunner>();
/** Per-invocation native lifecycle, shared by the editor/assistant UI and viewer operations. */
export class NativeScriptRunner {
  private active: Sandbox | null = null;
  /**
   * This instance's own run counter. The store's `scriptRunEpoch` decides whether a run may
   * still publish to the shared script state; this one decides whether `execute()` returns the
   * result to its caller (a newer run or a reset of the same instance supersedes it).
   */
  private epoch = 0;
  private cancellationEpoch = 0;
  private running = 0;
  private sharedEpoch = -1;
  constructor(private readonly bim: BimContext, private readonly config?: SandboxConfig) {}
  async execute(code: string): Promise<ScriptResult | null> {
    const { bim, config } = this;
    const { setScriptExecutionState: setExecutionState, setScriptError: setError, setScriptDiagnostics: setDiagnostics } = useViewerStore.getState();
    const setResult = (result: ScriptResult | null) => useViewerStore.getState().setScriptResult(result ? stampAnalysisReport(result, captureAnalysisStamp()) : null);
    // Captured BEFORE any await, and re-checked before every terminal store
    // write below: each caller (ScriptPanel, ChatPanel, CommandPalette,
    // ExecutableCodeBlock, the agent operations) has its own runner instance,
    // so two overlapping `execute()` calls from DIFFERENT instances are not
    // ordered by anything local to this class. `scriptRunEpoch` lives in the store precisely so every
    // instance shares one counter (see its doc in scriptSlice.ts).
    const myEpoch = useViewerStore.getState().bumpScriptRunEpoch(); this.sharedEpoch = myEpoch;
    const stillCurrent = () => useViewerStore.getState().scriptRunEpoch === myEpoch;

    // This instance's own epoch: whether THIS instance has since started a
    // newer run (a second `execute()` call) or reset itself. Gates the
    // RETURN VALUE only — see the `epoch` field doc.
    const myLocalEpoch = ++this.epoch, cancellationEpoch = this.cancellationEpoch;
    const stillCurrentLocally = () => this.epoch === myLocalEpoch;

    setExecutionState('running');
    setError(null);
    setDiagnostics([]);

    const preflightDiagnostics = validateScriptPreflightDetailed(code);
    if (preflightDiagnostics.length > 0) {
      const preflightErrors = formatDiagnosticsForDisplay(preflightDiagnostics);
      setError(
        `Preflight validation failed:\n${preflightErrors.map((e) => `- ${e}`).join('\n')}`,
        preflightDiagnostics,
      );
      return null;
    }

    this.running++; activeRunners.add(this);
    let sandbox: Sandbox | null = null;
    let torndown = false;
    /**
     * Tear the sandbox down exactly once and report a #1922 teardown abort.
     *
     * Called from the success path *before* the run is reported, and from the
     * `finally` for every other path; whichever arrives second is a no-op.
     */
    const teardown = (): string | null => {
      if (torndown) return null;
      torndown = true;
      const message = sandbox ? disposeSandboxReportingAbort(sandbox) : null;
      if (this.active === sandbox) {
        this.active = null;
      }
      return message;
    };

    try {
      // Create a fresh sandbox for every execution — full isolation. Because
      // it is fresh, a prior run's #1922 teardown abort costs this one
      // nothing: the package retired that WASM module, so this sandbox is
      // built on a healthy one. (The pre-flight refusal that used to stand
      // here reported "reload the page" for the rest of the document.)
      const { createViewerSandbox } = await import('@/lib/scripts/viewer-sandbox');

      sandbox = await createViewerSandbox(bim, config);
      this.active = sandbox;
      // Cancelled while the sandbox was being created: settle the store too, or it stays 'running'.
      if (this.cancellationEpoch !== cancellationEpoch) { if (stillCurrent()) setExecutionState('idle'); return null; }

      const result = await sandbox.eval(code);

      // Settle the run BEFORE reporting it, because teardown is where this
      // run's real outcome lives. A teardown abort is the *only* signal that
      // the script exhausted the sandbox heap inside a drained job (#1922):
      // that eval() resolves normally — the reproducer returns "started".
      //
      // Disposing here rather than only in the `finally` is what lets the
      // failure reach the RETURN value. A `finally` runs after the return
      // expression has already been evaluated, so reporting the abort only
      // there left `execute()` resolving with a truthy ScriptResult for a run
      // that died, and every caller reads success off exactly that:
      // `ExecutableCodeBlock.handleRun` treats any non-null result as success,
      // and ChatPanel's auto-execute path only handles failure when the result
      // is null. The store said "error" while the UI said "ran fine".
      const teardownAbortMessage = teardown();
      if (teardownAbortMessage) {
        // A #1922 teardown abort is a genuine failure of THIS run — unlike
        // the success path below, there is no real outcome for a caller to
        // recover, so this always resolves `null` regardless of either
        // epoch. The shared-store write is still gated on `stillCurrent()`:
        // a superseded run's abort is not this document's current story to
        // tell any more; a newer run already published (or is about to).
        if (stillCurrent()) {
          // Keep the captured logs — they are the only record of how far the
          // script got — but not the value, which is a lie about a dead run.
          setResult({
            value: undefined,
            logs: result.logs,
            durationMs: result.durationMs,
          });
          setError(teardownAbortMessage);
        }
        return null;
      }

      // The shared-store publish and this call's RETURN VALUE are gated
      // separately on purpose (see the `epoch` field doc): `stillCurrent()`
      // (the store epoch) decides whether this run's data is still the
      // document's current story — a DIFFERENT instance's newer run may have
      // already made it stale, and publishing anyway would clobber that
      // newer, already-displayed result (the original #2802-shaped bug this
      // guard exists for). `stillCurrentLocally()` decides what THIS call
      // resolves with — this run genuinely succeeded, so its own caller gets
      // the real result even when a different instance's run means the store
      // itself must not hear about it. Only THIS instance's own newer call
      // (or its own `reset()`) supersedes what execute() resolves with.
      if (stillCurrent()) {
        setResult({
          value: result.value,
          logs: result.logs,
          durationMs: result.durationMs,
        });
        // Successful-run signal for baseline consumers (scripting tour run
        // gate). Deliberately NOT bumped on the error-path setResult below
        // (that call only preserves captured logs), on reset(), or on the
        // teardown-abort path above — a crashed run must not count as a run.
        // Tied to the store publish, not the return value: a run this
        // instance's own store write skipped never became "the document's
        // current script run" for the tour gate to observe.
        useViewerStore.getState().bumpScriptRunSeq();
      }
      if (!stillCurrentLocally()) return null;
      return result;
    } catch (err: unknown) {
      // A SandboxAbortError surfacing from create/eval is the #1922 teardown
      // abort, not a fault in the script — the generic diagnostics below would
      // only mislead. (The ordinary route is the `finally`: the abort happens
      // during teardown, after this run has already returned.)
      //
      // NO TEST OBSERVES THIS BRANCH, and none in this repo can. Both other
      // teardown-abort publishes are covered
      // (`useSandbox.runSupersession.test.tsx`); this one is not, and the gap
      // is in what can be *reached*, not in what is asserted.
      // `SandboxAbortError` is constructed in exactly one place — the `catch`
      // around `runtime.dispose()` in `Sandbox.dispose()` — and every
      // `dispose()` this runner performs goes through
      // `disposeSandboxReportingAbort`, which returns the message rather than
      // throwing. So reaching here needs `createSandbox`/`eval` itself to
      // throw one: `init()` failing AND the cleanup `dispose()` it runs
      // aborting the runtime, which takes another sandbox retiring the shared
      // WASM module in the single microtask between `acquireQuickJSModule()`
      // resolving and `newRuntime()`. Measured, not assumed: a host bridge
      // function that throws or rejects with a `SandboxAbortError` does not
      // propagate one out of `eval()` (the bridge delivers it into the realm),
      // and a 16 KiB heap limit does not make `init()` throw. Kept gated
      // anyway — it is the same decision as the two publishes that ARE
      // covered, and an ungated one here would put a superseded run's abort
      // over a newer run's displayed result.
      const abortMessage = describeSandboxAbort(err);
      if (abortMessage) {
        if (stillCurrent()) setError(abortMessage);
        return null;
      }

      const runtime = augmentScriptError(err instanceof Error ? err.message : String(err), code);

      if (!stillCurrent()) return null;

      // If the error is a ScriptError with captured logs, preserve them.
      // Important: setError must run AFTER setResult, because setResult clears
      // scriptLastError in the store.
      if (isScriptError(err)) {
        setResult({
          value: undefined,
          logs: err.logs as ScriptResult['logs'],
          durationMs: err.durationMs,
        });
      }
      setError(runtime.message, runtime.diagnostics);
      return null;
    } finally {
      if (--this.running === 0) activeRunners.delete(this);
      // Always dispose the sandbox after execution. A no-op on the success
      // path, which already settled itself above; this covers create/eval
      // throwing, and a teardown abort on the way out of a failed run.
      // Reported after the result is set, because setResult clears the
      // store's error.
      const teardownAbortMessage = teardown();
      if (teardownAbortMessage && stillCurrent()) {
        setError(teardownAbortMessage);
      }
    }
  }
  ownsEpoch(epoch: number): boolean { return this.sharedEpoch === epoch; }
  /** True when cancel(), reset() or dispose() ran since the given cancellation count (see cancellationCount). */
  cancelledSince(count: number): boolean { return this.cancellationEpoch !== count; }
  get cancellationCount(): number { return this.cancellationEpoch; }
  cancel(): void {
    if (useViewerStore.getState().scriptRunEpoch === this.sharedEpoch) this.reset();
    else { this.epoch++; this.dispose(); }
  }
  reset(): void {
    const { setScriptExecutionState: setExecutionState, setScriptError: setError, setScriptDiagnostics: setDiagnostics } = useViewerStore.getState();
    const setResult = (result: ScriptResult | null) => useViewerStore.getState().setScriptResult(result ? stampAnalysisReport(result, captureAnalysisStamp()) : null);
    // dispose() advances the cancellation epoch, so a run still creating its sandbox stops before eval.
    this.dispose();
    // Same reasoning as `useClash.clearAll()`/`useIDS.clearIDS()`: bump the
    // shared epoch so an in-flight run (this instance's or any other
    // runner instance's) that lands after this reset cannot
    // resurrect the state this call just cleared.
    useViewerStore.getState().bumpScriptRunEpoch();
    // Also bump THIS instance's own local epoch: `reset()` is this
    // instance's own action, so an in-flight run of its own that lands after
    // this must resolve `null` to its caller too — not just skip the store
    // write. See the `epoch` field doc.
    this.epoch += 1;
    setExecutionState('idle');
    // `setResult(null)` lands on `'idle'` too (scriptSlice.ts) — a null result
    // is the absence of a run, not a successful one — so this clear leaves a
    // coherent state no matter which of the two writes is read. It used to
    // land on `'success'`, and the epoch bump above is what made that
    // terminal: a run this reset() superseded no longer overwrites it.
    setResult(null);
    setError(null);
    setDiagnostics([]);
  }
  dispose(): void { this.cancellationEpoch++; if (this.active) { disposeSandboxReportingAbort(this.active); this.active = null; } }
}

export function cancelNativeScriptRun(expectedEpoch: number): boolean {
  // A finished run whose epoch a later run replaced has nothing left to cancel.
  if (useViewerStore.getState().scriptRunEpoch !== expectedEpoch) return false;
  const runner = [...activeRunners].find(runner => runner.ownsEpoch(expectedEpoch)); if (!runner) return false; runner.cancel(); return true;
}
