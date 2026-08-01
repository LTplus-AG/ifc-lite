/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Error boundary for `React.lazy` chunk roots.
 *
 * `Suspense` covers the pending state, not the failed one: when a lazy import
 * rejects, React re-throws it from the render phase, and with no boundary above
 * it React unmounts the entire tree. The user gets a blank page (issue #1941).
 *
 * The usual cause is deployment skew, a tab held open across a deploy that
 * rotated the chunk's content hash. `lib/chunk-version-skew.ts` reloads once per
 * tab for exactly that, so most of the time this fallback is on screen for only
 * a few hundred milliseconds. It earns its keep in the case that reload cannot
 * fix: the budget is already spent, or storage is blocked so no reload is
 * allowed at all. Then this is the difference between one dead panel and a dead
 * application.
 *
 * Deliberately narrow: wrap the `lazy()` root, not the app. A boundary that
 * spans working UI would take that UI down with the chunk that failed.
 */

import { Component, type ErrorInfo, type ReactNode } from 'react';
import { RefreshCw } from 'lucide-react';
import { posthog } from '@/lib/analytics';

interface ChunkErrorBoundaryProps {
  /** What failed, in the user's words: "Layers panel", "MCP playground". */
  label: string;
  children: ReactNode;
}

interface ChunkErrorBoundaryState {
  error: Error | null;
}

export class ChunkErrorBoundary extends Component<
  ChunkErrorBoundaryProps,
  ChunkErrorBoundaryState
> {
  state: ChunkErrorBoundaryState = { error: null };

  static getDerivedStateFromError(error: Error): ChunkErrorBoundaryState {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    console.error(`[chunk-boundary] "${this.props.label}" failed to load`, error, info);
    // Reported explicitly so it lands as HANDLED rather than as an uncaught
    // error-level exception. When a skew reload is in flight the before_send
    // gate in lib/chunk-version-skew.ts drops this as collateral; when no reload
    // is coming, it is a real dead end and worth hearing about.
    posthog.captureException(error, {
      context: 'lazy_chunk_boundary',
      chunk_label: this.props.label,
    });
  }

  render(): ReactNode {
    const { error } = this.state;
    if (!error) return this.props.children;
    return (
      <div className="flex h-full min-h-[160px] w-full flex-col items-center justify-center gap-2 px-4 text-center">
        <span className="text-xs text-muted-foreground">
          {this.props.label} could not be loaded
        </span>
        <span className="max-w-[280px] text-[11px] text-muted-foreground/70">
          This usually means the app was updated while your tab was open.
        </span>
        <button
          type="button"
          onClick={() => window.location.reload()}
          className="mt-1 inline-flex items-center gap-1.5 rounded-md border px-2.5 py-1 text-[11px] transition-colors hover:bg-accent"
        >
          <RefreshCw className="h-3 w-3" />
          Reload
        </button>
      </div>
    );
  }
}
