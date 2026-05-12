/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { Calendar, CalendarClock, CalendarPlus, X } from 'lucide-react';
import { Button } from '@/components/ui/button';

interface GanttEmptyStateProps {
  loading: boolean;
  hasModel: boolean;
  /** When true, the active model has a spatial hierarchy — enables the CTA. */
  canGenerate?: boolean;
  /** Human-readable extraction error (last parser failure), if any. */
  extractionError?: string | null;
  onClose?: () => void;
  onGenerate?: () => void;
}

export function GanttEmptyState({
  loading,
  hasModel,
  canGenerate,
  extractionError,
  onClose,
  onGenerate,
}: GanttEmptyStateProps) {
  return (
    <div className="relative h-full w-full flex flex-col items-center justify-center text-center p-8 gap-3 text-muted-foreground">
      {onClose && (
        <Button
          size="icon-sm"
          variant="ghost"
          className="absolute top-2 right-2"
          onClick={onClose}
          aria-label="Close"
        >
          <X className="h-4 w-4" />
        </Button>
      )}
      <div className="relative">
        <Calendar className="h-12 w-12" strokeWidth={1} />
        <CalendarClock className="h-6 w-6 absolute -bottom-1 -right-1 text-primary" strokeWidth={1.5} />
      </div>
      {!hasModel ? (
        <>
          <h3 className="text-sm font-semibold text-foreground">Load a model with IfcTasks</h3>
          <p className="text-xs max-w-sm">
            Open an IFC file containing <span className="font-mono">IfcTask</span> or
            <span className="font-mono"> IfcWorkSchedule</span> entities to see the construction
            schedule here.
          </p>
        </>
      ) : loading ? (
        <p className="text-xs">Extracting schedule…</p>
      ) : extractionError ? (
        <>
          <h3 className="text-sm font-semibold text-destructive">Schedule extraction failed</h3>
          <p className="text-xs max-w-md text-muted-foreground">
            <span className="font-mono text-destructive">{extractionError}</span>
            <br />
            Re-open the model or inspect the browser console for details.
          </p>
          {canGenerate && onGenerate && (
            <div className="flex flex-col items-center gap-2 pt-2">
              <Button size="sm" variant="outline" onClick={onGenerate} className="gap-2">
                <CalendarPlus className="h-4 w-4" />
                Generate a schedule instead
              </Button>
            </div>
          )}
        </>
      ) : (
        <>
          <h3 className="text-sm font-semibold text-foreground">No schedule found</h3>
          <p className="text-xs max-w-md">
            This model doesn&apos;t define any <span className="font-mono">IfcTask</span>,
            <span className="font-mono"> IfcWorkSchedule</span>, or
            <span className="font-mono"> IfcRelSequence</span> entities. The Gantt panel powers
            itself from those entities and the products they control via
            <span className="font-mono"> IfcRelAssignsToProcess</span>.
          </p>
          {canGenerate && onGenerate && (
            <div className="flex flex-col items-center gap-2 pt-2">
              <Button size="sm" onClick={onGenerate} className="gap-2">
                <CalendarPlus className="h-4 w-4" />
                Generate schedule
              </Button>
              <p className="text-xs text-muted-foreground max-w-xs">
                Build a schedule by storey, building, or element-Z height slice.
              </p>
            </div>
          )}
        </>
      )}
    </div>
  );
}
