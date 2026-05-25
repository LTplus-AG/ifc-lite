/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * `FlavorListView` — CRUD surface for the flavor library.
 *
 * Sits inside `FlavorDialog`; the dialog owns data fetching, busy
 * state, and outgoing actions. Each row supports the full management
 * loop a user actually needs:
 *
 *   - **Activate** (non-active rows)
 *   - **Capture into THIS flavor** — snapshot the live viewer state
 *     into that specific flavor, not just the active one
 *   - **Rename** (inline click-to-edit on the name)
 *   - **Duplicate** — clone the flavor with a fresh id
 *   - **Export** / **Delete**
 *
 * Header offers **New flavor** (empty, name it) and **Save current as
 * flavor** (snapshot from current viewer state, name it). Both flows
 * open an inline name input so the user never sees an empty list with
 * no path forward.
 */

import { useState } from 'react';
import { Camera, Copy, Download, FilePlus, Pencil, RefreshCcw, Upload, X, Check } from 'lucide-react';
import type { Flavor } from '@ifc-lite/extensions';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';

interface FlavorListViewProps {
  flavors: readonly Flavor[];
  activeId: string | undefined;
  busy: boolean;
  /** Count of lenses currently in viewer state — surfaces "you have N lenses uncaptured" hint. */
  liveLensCount: number;
  onActivate(id: string): void;
  onExport(id: string): void;
  onDelete(id: string): void;
  onImportClick(): void;
  onReset(): void;
  /** Snapshot current viewer state into a SPECIFIC flavor (not just active). */
  onCaptureInto(id: string): void;
  /** Rename a flavor. Caller validates. */
  onRename(id: string, name: string): void;
  /** Duplicate a flavor with a fresh id. */
  onDuplicate(id: string): void;
  /** Create a new flavor — empty body, user-provided name. Optional snapshot. */
  onCreate(opts: { name: string; snapshot: boolean }): void;
}

type Creating = null | { mode: 'empty' | 'snapshot'; name: string };

export function FlavorListView({
  flavors,
  activeId,
  busy,
  liveLensCount,
  onActivate,
  onExport,
  onDelete,
  onImportClick,
  onReset,
  onCaptureInto,
  onRename,
  onDuplicate,
  onCreate,
}: FlavorListViewProps) {
  const [creating, setCreating] = useState<Creating>(null);
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [renameValue, setRenameValue] = useState('');

  const startRename = (flavor: Flavor) => {
    setRenamingId(flavor.id);
    setRenameValue(flavor.name);
  };
  const commitRename = () => {
    if (renamingId && renameValue.trim().length > 0) {
      onRename(renamingId, renameValue.trim());
    }
    setRenamingId(null);
  };
  const cancelRename = () => setRenamingId(null);

  const submitCreate = () => {
    if (!creating || creating.name.trim().length === 0) return;
    onCreate({ name: creating.name.trim(), snapshot: creating.mode === 'snapshot' });
    setCreating(null);
  };

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between gap-2 flex-wrap">
        <div className="text-xs text-muted-foreground flex-1 min-w-[200px]">
          Flavors bundle your extensions, lenses, queries, and layout. Switch to
          isolate experiments; export to share or back up.
        </div>
        <div className="flex items-center gap-1 shrink-0">
          <Button
            size="sm"
            variant="default"
            onClick={() => setCreating({ mode: liveLensCount > 0 ? 'snapshot' : 'empty', name: '' })}
            disabled={busy || creating !== null}
            aria-label={liveLensCount > 0 ? 'Save current setup as a new flavor' : 'Create a new empty flavor'}
          >
            <FilePlus className="mr-1 h-3.5 w-3.5" />
            {liveLensCount > 0 ? 'Save current as flavor' : 'New flavor'}
          </Button>
          <Button size="sm" variant="outline" onClick={onImportClick} disabled={busy}>
            <Upload className="mr-1 h-3.5 w-3.5" />
            Import
          </Button>
          <Button size="sm" variant="ghost" onClick={onReset} disabled={busy} title="Recreate the Default baseline flavor">
            <RefreshCcw className="mr-1 h-3.5 w-3.5" />
            Reset
          </Button>
        </div>
      </div>

      {/* Inline name input — appears when user clicks "New flavor" or
          "Save current as flavor". Keeping it inline avoids a nested
          modal stack inside the Flavors dialog. */}
      {creating && (
        <div className="rounded-md border border-primary/30 bg-primary/5 px-3 py-2">
          <label className="text-xs font-medium block mb-1">
            {creating.mode === 'snapshot'
              ? `Name this flavor (will snapshot ${liveLensCount} lens${liveLensCount === 1 ? '' : 'es'})`
              : 'Name this new empty flavor'}
          </label>
          <div className="flex items-center gap-2">
            <Input
              autoFocus
              value={creating.name}
              onChange={(e) => setCreating({ ...creating, name: e.target.value })}
              onKeyDown={(e) => {
                if (e.key === 'Enter') submitCreate();
                if (e.key === 'Escape') setCreating(null);
              }}
              placeholder={creating.mode === 'snapshot' ? 'Cost estimating' : 'Empty workspace'}
              className="h-8 text-xs"
              disabled={busy}
            />
            {/* Snapshot/empty toggle so the user can switch mode without re-opening the form. */}
            <Button
              size="sm"
              variant="ghost"
              onClick={() => setCreating({
                ...creating,
                mode: creating.mode === 'snapshot' ? 'empty' : 'snapshot',
              })}
              disabled={busy || liveLensCount === 0}
              title={creating.mode === 'snapshot' ? 'Switch to empty flavor' : 'Switch to snapshot of current state'}
            >
              {creating.mode === 'snapshot' ? 'snapshot' : 'empty'}
            </Button>
            <Button size="sm" variant="default" onClick={submitCreate} disabled={busy || creating.name.trim().length === 0}>
              Create
            </Button>
            <Button size="sm" variant="ghost" onClick={() => setCreating(null)} disabled={busy}>
              Cancel
            </Button>
          </div>
        </div>
      )}

      {flavors.length === 0 ? (
        <div className="rounded border bg-muted/30 px-4 py-6 text-center text-xs text-muted-foreground">
          No flavors yet. Click <span className="font-medium">New flavor</span> above,
          <span className="font-medium"> Reset</span> for the baseline, or
          <span className="font-medium"> Import</span> a <code>.iflv</code>.
        </div>
      ) : (
        <ul className="divide-y border rounded">
          {flavors.map((flavor) => {
            const isActive = flavor.id === activeId;
            const isRenaming = renamingId === flavor.id;
            const hasUncaptured = isActive && liveLensCount > flavor.lenses.length;
            return (
              <li
                key={flavor.id}
                className={`flex items-start gap-3 px-3 py-2 ${isActive ? 'bg-primary/5' : ''}`}
              >
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2">
                    {isRenaming ? (
                      <>
                        <Input
                          autoFocus
                          value={renameValue}
                          onChange={(e) => setRenameValue(e.target.value)}
                          onKeyDown={(e) => {
                            if (e.key === 'Enter') commitRename();
                            if (e.key === 'Escape') cancelRename();
                          }}
                          className="h-7 text-sm"
                        />
                        <Button size="icon" variant="ghost" onClick={commitRename} aria-label="Save name">
                          <Check className="h-3.5 w-3.5" />
                        </Button>
                        <Button size="icon" variant="ghost" onClick={cancelRename} aria-label="Cancel rename">
                          <X className="h-3.5 w-3.5" />
                        </Button>
                      </>
                    ) : (
                      <>
                        <button
                          type="button"
                          onClick={() => startRename(flavor)}
                          className="text-sm font-medium hover:underline underline-offset-2 text-left truncate max-w-[14rem]"
                          aria-label={`Rename ${flavor.name}`}
                          title="Click to rename"
                        >
                          {flavor.name}
                        </button>
                        {isActive && (
                          <span className="text-[10px] uppercase tracking-wide bg-primary/20 text-primary rounded px-1.5 py-0.5 font-semibold">
                            Active
                          </span>
                        )}
                        {hasUncaptured && (
                          <span
                            className="text-[10px] uppercase tracking-wide bg-amber-500/20 text-amber-700 dark:text-amber-300 rounded px-1.5 py-0.5 font-semibold"
                            title={`${liveLensCount - flavor.lenses.length} lens(es) in viewer not yet captured`}
                          >
                            {liveLensCount - flavor.lenses.length} uncaptured
                          </span>
                        )}
                      </>
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
                <div className="flex items-center gap-0.5 shrink-0">
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
                    variant={hasUncaptured ? 'default' : 'ghost'}
                    onClick={() => onCaptureInto(flavor.id)}
                    disabled={busy}
                    aria-label={`Capture current viewer state into ${flavor.name}`}
                    title={hasUncaptured
                      ? `Save current viewer state into ${flavor.name} (${liveLensCount - flavor.lenses.length} new)`
                      : `Snapshot current viewer state into ${flavor.name}`}
                  >
                    <Camera className="h-3.5 w-3.5" />
                  </Button>
                  <Button
                    size="icon"
                    variant="ghost"
                    onClick={() => startRename(flavor)}
                    disabled={busy || isRenaming}
                    aria-label={`Rename ${flavor.name}`}
                    title="Rename"
                  >
                    <Pencil className="h-3.5 w-3.5" />
                  </Button>
                  <Button
                    size="icon"
                    variant="ghost"
                    onClick={() => onDuplicate(flavor.id)}
                    disabled={busy}
                    aria-label={`Duplicate ${flavor.name}`}
                    title="Duplicate"
                  >
                    <Copy className="h-3.5 w-3.5" />
                  </Button>
                  <Button
                    size="icon"
                    variant="ghost"
                    onClick={() => onExport(flavor.id)}
                    disabled={busy}
                    aria-label={`Export ${flavor.name}`}
                    title="Export as .iflv"
                  >
                    <Download className="h-3.5 w-3.5" />
                  </Button>
                  {!isActive && (
                    <Button
                      size="icon"
                      variant="ghost"
                      onClick={() => onDelete(flavor.id)}
                      disabled={busy}
                      aria-label={`Delete ${flavor.name}`}
                      title="Delete"
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
