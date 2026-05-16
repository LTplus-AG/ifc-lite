/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * `FlavorListView` — list/activate/delete/export the user's flavors.
 *
 * Sits inside `FlavorDialog`; pure presentational component. Receives
 * the list + per-row callbacks; the dialog owns the data fetching,
 * busy state, and outgoing actions.
 */

import { Download, RefreshCcw, Upload, X } from 'lucide-react';
import type { Flavor } from '@ifc-lite/extensions';
import { Button } from '@/components/ui/button';

interface FlavorListViewProps {
  flavors: readonly Flavor[];
  activeId: string | undefined;
  busy: boolean;
  onActivate(id: string): void;
  onExport(id: string): void;
  onDelete(id: string): void;
  onImportClick(): void;
  onReset(): void;
}

export function FlavorListView({
  flavors,
  activeId,
  busy,
  onActivate,
  onExport,
  onDelete,
  onImportClick,
  onReset,
}: FlavorListViewProps) {
  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between">
        <div className="text-xs text-muted-foreground">
          Flavors bundle your extensions, lenses, queries, and layout. Switch to
          isolate experiments; export to share or back up.
        </div>
        <div className="flex items-center gap-1 shrink-0">
          <Button size="sm" variant="outline" onClick={onImportClick} disabled={busy}>
            <Upload className="mr-1 h-3.5 w-3.5" />
            Import
          </Button>
          <Button size="sm" variant="ghost" onClick={onReset} disabled={busy}>
            <RefreshCcw className="mr-1 h-3.5 w-3.5" />
            Reset
          </Button>
        </div>
      </div>

      {flavors.length === 0 ? (
        <div className="rounded border bg-muted/30 px-4 py-6 text-center text-xs text-muted-foreground">
          No flavors yet. Click <span className="font-medium">Reset</span> to create
          the baseline, or <span className="font-medium">Import</span> a `.iflv`.
        </div>
      ) : (
        <ul className="divide-y border rounded">
          {flavors.map((flavor) => {
            const isActive = flavor.id === activeId;
            return (
              <li
                key={flavor.id}
                className={`flex items-start gap-3 px-3 py-2 ${isActive ? 'bg-primary/5' : ''}`}
              >
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2">
                    <span className="text-sm font-medium">{flavor.name}</span>
                    {isActive && (
                      <span className="text-[10px] uppercase tracking-wide bg-primary/20 text-primary rounded px-1.5 py-0.5 font-semibold">
                        Active
                      </span>
                    )}
                  </div>
                  <div className="text-[11px] text-muted-foreground font-mono break-all">
                    {flavor.id}
                  </div>
                  {flavor.description && (
                    <div className="text-[11px] text-muted-foreground mt-0.5">
                      {flavor.description}
                    </div>
                  )}
                  <div className="text-[10px] text-muted-foreground mt-0.5">
                    {flavor.extensions.length} ext · {flavor.lenses.length} lens ·{' '}
                    {flavor.savedQueries.length} qry · updated{' '}
                    {new Date(flavor.updatedAt).toLocaleDateString()}
                  </div>
                </div>
                <div className="flex items-center gap-1 shrink-0">
                  {!isActive && (
                    <Button
                      size="sm"
                      variant="ghost"
                      onClick={() => onActivate(flavor.id)}
                      disabled={busy}
                    >
                      Activate
                    </Button>
                  )}
                  <Button
                    size="icon"
                    variant="ghost"
                    onClick={() => onExport(flavor.id)}
                    disabled={busy}
                    aria-label={`Export ${flavor.id}`}
                  >
                    <Download className="h-3.5 w-3.5" />
                  </Button>
                  {!isActive && (
                    <Button
                      size="icon"
                      variant="ghost"
                      onClick={() => onDelete(flavor.id)}
                      disabled={busy}
                      aria-label={`Delete ${flavor.id}`}
                    >
                      <X className="h-3.5 w-3.5" />
                    </Button>
                  )}
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
