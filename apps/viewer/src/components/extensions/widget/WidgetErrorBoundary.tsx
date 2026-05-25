/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Error boundary for extension-authored widgets. Wraps the
 * `WidgetRenderer` tree so a single malformed widget cannot crash
 * the Extensions panel — instead the user sees a labelled fallback
 * and can carry on using the rest of the panel.
 *
 * Designed as a *narrow* boundary: the host catches everything else
 * via the dispatcher's per-command try/catch. This boundary covers
 * render-time failures (bad bindings, missing fields, etc.).
 */

import { Component, type ErrorInfo, type ReactNode } from 'react';
import { AlertCircle } from 'lucide-react';

interface WidgetErrorBoundaryProps {
  /** Human-readable identifier used in the fallback (`extensionId` or `commandId`). */
  label: string;
  children: ReactNode;
}

interface WidgetErrorBoundaryState {
  error: Error | null;
}

export class WidgetErrorBoundary extends Component<
  WidgetErrorBoundaryProps,
  WidgetErrorBoundaryState
> {
  state: WidgetErrorBoundaryState = { error: null };

  static getDerivedStateFromError(error: Error): WidgetErrorBoundaryState {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    console.error(`[WidgetErrorBoundary] widget "${this.props.label}" crashed`, error, info);
  }

  render(): ReactNode {
    const { error } = this.state;
    if (!error) return this.props.children;
    return (
      <div className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-xs">
        <div className="flex items-start gap-2">
          <AlertCircle className="h-4 w-4 text-destructive mt-0.5 shrink-0" />
          <div className="min-w-0">
            <div className="font-medium text-destructive">
              {this.props.label} crashed while rendering
            </div>
            <div className="text-muted-foreground mt-0.5 font-mono break-words">
              {error.message}
            </div>
          </div>
        </div>
      </div>
    );
  }
}
