/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/** Store access for the Studio components: the document, the dispatcher and live lint. */

import { createContext, useContext, useEffect, useMemo, useRef } from 'react';
import { createLinter, type Diagnostic, type LintContext, type Linter, type StudioDocument } from '@ifc-lite/ids-authoring';
import { useViewerStore } from '@/store';
import { loadStudioContexts } from '@/lib/ids-studio/context';
import { indexDiagnostics, type DiagnosticIndex } from '@/lib/ids-studio/diagnostics';

export function useStudioDoc(): StudioDocument | null {
  return useViewerStore((s) => s.idsStudioState?.doc ?? null);
}

export function useStudioDispatch() {
  return useViewerStore((s) => s.idsStudioDispatch);
}

/** Loads the schema tables once; components read `idsStudioContexts`. */
export function useStudioContexts(): void {
  const ready = useViewerStore((s) => s.idsStudioContexts !== null);
  const setContexts = useViewerStore((s) => s.idsStudioSetContexts);
  useEffect(() => {
    if (ready) return;
    let live = true;
    loadStudioContexts().then(
      (contexts) => { if (live) setContexts(contexts); },
      (error: unknown) => console.warn('[ids-studio] schema tables unavailable', error),
    );
    return () => { live = false; };
  }, [ready, setContexts]);
}

export interface StudioDiagnostics extends DiagnosticIndex {
  diagnostics: Diagnostic[];
  /** False while the lint context is loading. */
  ready: boolean;
}

const EMPTY: StudioDiagnostics = { diagnostics: [], byRow: new Map(), severity: new Map(), counts: { error: 0, warning: 0, info: 0 }, ready: false };

/**
 * Static lint of the open document, recomputed on every change. One linter
 * per document keeps the per-spec cache warm (only touched specs re-run).
 */
export function useStudioDiagnostics(): StudioDiagnostics {
  const doc = useStudioDoc();
  const lint: LintContext | undefined = useViewerStore((s) => s.idsStudioContexts?.lint);
  const linter = useRef<{ docId: string; ctx: LintContext; linter: Linter } | null>(null);
  return useMemo(() => {
    if (!doc || !lint) return EMPTY;
    if (!linter.current || linter.current.docId !== doc.docId || linter.current.ctx !== lint) {
      linter.current = { docId: doc.docId, ctx: lint, linter: createLinter(lint) };
    }
    const { diagnostics } = linter.current.linter.lint(doc);
    return { diagnostics, ...indexDiagnostics(doc, diagnostics), ready: true };
  }, [doc, lint]);
}

const DiagnosticsContext = createContext<StudioDiagnostics>(EMPTY);
export const StudioDiagnosticsProvider = DiagnosticsContext.Provider;

/** The panel lints once and provides the result; rows and editors read it here. */
export function useDiagnosticsContext(): StudioDiagnostics {
  return useContext(DiagnosticsContext);
}
