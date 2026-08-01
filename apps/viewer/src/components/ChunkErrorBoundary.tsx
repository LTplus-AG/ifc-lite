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
import { isChunkLoadError } from '@/lib/chunk-version-skew';

/**
 * Which surface the fallback paints on.
 *
 * `panel` (default) sits inside the viewer chrome and uses its theme tokens.
 * `night` is for the `/mcp` routes, which render OUTSIDE `ViewerLayout` on their
 * own near-black stage (`NIGHT` = #0a0a0c in McpLanding) while the document root
 * may still be on the light or colorful theme. There, `text-muted-foreground`
 * resolves to a dark grey and the message is effectively invisible, so those
 * routes borrow the MCP palette instead.
 */
type ChunkErrorTone = 'panel' | 'night';

/** McpLanding's `PAPER` / `PAPER_DIM`, kept in sync by eye: this is one message. */
const NIGHT_TONE = { fg: '#ede4d3', dim: '#9c9486' } as const;

interface ChunkErrorBoundaryProps {
  /** What failed, in the user's words: "Layers panel", "MCP playground". */
  label: string;
  tone?: ChunkErrorTone;
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
    // This boundary wraps whole page subtrees, so it catches ANY render error
    // under them, not only a rejected lazy import. Classify before reporting:
    // filing a component crash under the chunk-skew context would mis-group a
    // real bug with an auto-recovered one, and the render path below would tell
    // the user their tab was out of date when it was not.
    const chunk = isChunkLoadError(error);
    console.error(`[chunk-boundary] "${this.props.label}" failed`, error, info);
    // Reported explicitly so it lands as HANDLED rather than as an uncaught
    // error-level exception. When a skew reload is in flight the before_send
    // gate in lib/chunk-version-skew.ts drops this as collateral; when no reload
    // is coming, it is a real dead end and worth hearing about.
    posthog.captureException(error, {
      context: chunk ? 'lazy_chunk_boundary' : 'lazy_subtree_boundary',
      // `lazy_chunk`, not `chunk_label`: the analytics scrub deletes any key
      // with a `label` word (free text is where model names leak), so the
      // latter would have been dropped on the way out and this event would
      // have carried no indication of WHICH chunk died. The value is a fixed
      // string from the call sites in this repo, not user data.
      lazy_chunk: this.props.label,
    });
  }

  render(): ReactNode {
    const { error } = this.state;
    if (!error) return this.props.children;
    const night = this.props.tone === 'night';
    const chunk = isChunkLoadError(error);
    return (
      <div
        // The fallback swaps in asynchronously, so without this a screen reader
        // user gets no notification that the view they asked for is not coming.
        role="alert"
        className="flex h-full min-h-[160px] w-full flex-col items-center justify-center gap-2 px-4 text-center"
        style={night ? { background: '#0a0a0c' } : undefined}
      >
        <span
          className={night ? 'text-xs' : 'text-xs text-muted-foreground'}
          style={night ? { color: NIGHT_TONE.fg } : undefined}
        >
          {chunk ? `${this.props.label} could not be loaded` : `${this.props.label} stopped working`}
        </span>
        <span
          className={night ? 'max-w-[280px] text-[11px]' : 'max-w-[280px] text-[11px] text-muted-foreground/70'}
          style={night ? { color: NIGHT_TONE.dim } : undefined}
        >
          {chunk
            ? 'This usually means the app was updated while your tab was open.'
            : 'An unexpected error stopped it from rendering.'}
        </span>
        <button
          type="button"
          onClick={() => window.location.reload()}
          className={
            night
              ? 'mt-1 inline-flex items-center gap-1.5 rounded-md border px-2.5 py-1 text-[11px] transition-opacity hover:opacity-80'
              : 'mt-1 inline-flex items-center gap-1.5 rounded-md border px-2.5 py-1 text-[11px] transition-colors hover:bg-accent'
          }
          style={night ? { borderColor: NIGHT_TONE.dim, color: NIGHT_TONE.fg } : undefined}
        >
          <RefreshCw className="h-3 w-3" aria-hidden />
          Reload
        </button>
      </div>
    );
  }
}
