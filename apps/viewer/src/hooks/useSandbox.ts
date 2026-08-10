/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * useSandbox — React hook for executing scripts in a QuickJS sandbox.
 *
 * Creates a fresh sandbox context per execution for full isolation.
 * The WASM module is cached across the session (cheap to reuse),
 * but each script runs in a clean context with no leaked state.
 */

import { useCallback, useEffect, useRef } from 'react';
import { useBim } from '../sdk/BimProvider.js';
import { useViewerStore } from '../store/index.js';
import type { Sandbox, ScriptResult, SandboxConfig } from '@ifc-lite/sandbox';
import { validateScriptPreflightDetailed } from '../lib/llm/script-preflight.js';
import {
  createRuntimeDiagnostic,
  formatDiagnosticsForDisplay,
  type RuntimeScriptDiagnostic,
} from '../lib/llm/script-diagnostics.js';
import { describeSandboxAbort, disposeSandboxReportingAbort } from '../lib/sandboxAbort.js';

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

/**
 * Hook that provides a sandbox execution interface.
 *
 * Each execute() call creates a fresh QuickJS context for full isolation —
 * scripts cannot leak global state between runs. The WASM module itself
 * is cached (loaded once per app lifetime, ~1ms context creation overhead).
 */
export function useSandbox(config?: SandboxConfig) {
  const bim = useBim();
  const activeSandboxRef = useRef<Sandbox | null>(null);

  const setExecutionState = useViewerStore((s) => s.setScriptExecutionState);
  const setResult = useViewerStore((s) => s.setScriptResult);
  const setError = useViewerStore((s) => s.setScriptError);
  const setDiagnostics = useViewerStore((s) => s.setScriptDiagnostics);

  /** Execute a script in an isolated sandbox context */
  const execute = useCallback(async (code: string): Promise<ScriptResult | null> => {
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
      if (activeSandboxRef.current === sandbox) {
        activeSandboxRef.current = null;
      }
      return message;
    };

    try {
      // Create a fresh sandbox for every execution — full isolation. Because
      // it is fresh, a prior run's #1922 teardown abort costs this one
      // nothing: the package retired that WASM module, so this sandbox is
      // built on a healthy one. (The pre-flight refusal that used to stand
      // here reported "reload the page" for the rest of the document.)
      const { createSandbox } = await import('@ifc-lite/sandbox');

      sandbox = await createSandbox(bim, {
        permissions: { model: true, query: true, viewer: true, mutate: true, store: true, lens: true, export: true, files: true, ...config?.permissions },
        limits: { timeoutMs: 30_000, ...config?.limits },
      });
      activeSandboxRef.current = sandbox;

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
        // Keep the captured logs — they are the only record of how far the
        // script got — but not the value, which is a lie about a dead run.
        setResult({
          value: undefined,
          logs: result.logs,
          durationMs: result.durationMs,
        });
        setError(teardownAbortMessage);
        return null;
      }

      setResult({
        value: result.value,
        logs: result.logs,
        durationMs: result.durationMs,
      });
      // Successful-run signal for baseline consumers (scripting tour run
      // gate). Deliberately NOT bumped on the error-path setResult below
      // (that call only preserves captured logs), on reset(), or on the
      // teardown-abort path above — a crashed run must not count as a run.
      useViewerStore.getState().bumpScriptRunSeq();
      return result;
    } catch (err: unknown) {
      // A SandboxAbortError surfacing from create/eval is the #1922 teardown
      // abort, not a fault in the script — the generic diagnostics below would
      // only mislead. (The ordinary route is the `finally`: the abort happens
      // during teardown, after this run has already returned.)
      const abortMessage = describeSandboxAbort(err);
      if (abortMessage) {
        setError(abortMessage);
        return null;
      }

      const runtime = augmentScriptError(err instanceof Error ? err.message : String(err), code);

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
      // Always dispose the sandbox after execution. A no-op on the success
      // path, which already settled itself above; this covers create/eval
      // throwing, and a teardown abort on the way out of a failed run.
      // Reported after the result is set, because setResult clears the
      // store's error.
      const teardownAbortMessage = teardown();
      if (teardownAbortMessage) {
        setError(teardownAbortMessage);
      }
    }
  }, [bim, config?.permissions, config?.limits, setDiagnostics, setExecutionState, setResult, setError]);

  /** Reset clears any active sandbox (no-op if none running) */
  const reset = useCallback(() => {
    if (activeSandboxRef.current) {
      disposeSandboxReportingAbort(activeSandboxRef.current);
      activeSandboxRef.current = null;
    }
    setExecutionState('idle');
    setResult(null);
    setError(null);
    setDiagnostics([]);
  }, [setDiagnostics, setExecutionState, setResult, setError]);

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      if (activeSandboxRef.current) {
        disposeSandboxReportingAbort(activeSandboxRef.current);
        activeSandboxRef.current = null;
      }
    };
  }, []);

  return { execute, reset };
}
