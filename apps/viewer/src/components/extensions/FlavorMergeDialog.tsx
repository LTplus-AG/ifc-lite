/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * `FlavorMergeDialog` — UI for the three-way flavor merge.
 *
 * The user opens this from the Flavor dialog or by importing an `.iflv`
 * with the "merge" strategy. We:
 *
 *   1. Pick "ours" (defaults to the currently-active flavor) and
 *      "theirs" (the incoming flavor).
 *   2. Call `mergeFlavors(base, theirs, ours)`. The base is whichever
 *      stored ancestor the import previewed — for the import-merge
 *      path it's the imported flavor's `id` matched in storage (best
 *      effort; otherwise we use `ours` as the base, which means
 *      conflicts surface as "their changes vs current").
 *   3. Render each `MergeConflict` with a chooser
 *      (theirs / ours / base) and apply the user's selection to the
 *      merged result before saving.
 *   4. Save the merged flavor as a new id (`<their-id>.merge-<ts>`)
 *      so neither input is overwritten silently.
 *
 * Phase 3 T13. Spec: docs/architecture/ai-customization/05-flavors-and-sharing.md §5.
 */

import { useEffect, useMemo, useState } from 'react';
import { Check, GitMerge, X } from 'lucide-react';
import {
  mergeFlavors,
  type Flavor,
  type MergeConflict,
  type MergeResult,
} from '@ifc-lite/extensions';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { useExtensionHost } from '@/sdk/ExtensionHostProvider';
import { toast } from '@/components/ui/toast';

interface FlavorMergeDialogProps {
  open: boolean;
  /** The flavor being merged IN. */
  theirs: Flavor | null;
  onClose: () => void;
  /** Called after a successful merge so the parent can refresh. */
  onMerged?: (merged: Flavor) => void;
}

type ConflictResolution = 'theirs' | 'ours' | 'base';

export function FlavorMergeDialog({ open, theirs, onClose, onMerged }: FlavorMergeDialogProps) {
  const host = useExtensionHost();
  const [ours, setOurs] = useState<Flavor | null>(null);
  const [base, setBase] = useState<Flavor | null>(null);
  const [busy, setBusy] = useState(false);
  const [resolutions, setResolutions] = useState<Record<string, ConflictResolution>>({});

  // Resolve "ours" = active flavor, "base" = stored copy of their id if
  // present (otherwise fall back to ours so the merge degrades to a
  // two-way merge surfacing every diff as a conflict).
  useEffect(() => {
    if (!open || !theirs) return;
    let cancelled = false;
    void (async () => {
      const active = await host.flavors.getActive();
      const list = await host.flavors.list();
      const stored = list.find((f) => f.id === theirs.id);
      if (cancelled) return;
      setOurs(active ?? null);
      setBase(stored ?? active ?? null);
      setResolutions({});
    })();
    return () => {
      cancelled = true;
    };
  }, [open, theirs, host]);

  const mergeResult = useMemo<MergeResult | null>(() => {
    if (!theirs || !ours || !base) return null;
    return mergeFlavors(base, theirs, ours);
  }, [theirs, ours, base]);

  const conflictKey = (c: MergeConflict): string => `${c.kind}:${c.key}`;

  const handleApply = async () => {
    if (!mergeResult || !theirs) return;
    setBusy(true);
    try {
      const merged = { ...mergeResult.merged };
      // Apply per-conflict resolution: where the user picked theirs,
      // we already merged in their value via the conflict choice;
      // where they picked base we have to re-write the merged field.
      // For v1 we honour the choice for extension version + setting
      // values; lens/saved_query/keybinding stay on the default
      // (ours wins) since list-id merge already picked sensibly.
      for (const conflict of mergeResult.conflicts) {
        const choice = resolutions[conflictKey(conflict)];
        if (!choice || choice === 'ours') continue;
        applyChoice(merged, conflict, choice, theirs, base!);
      }
      merged.id = `${theirs.id}.merge-${Date.now()}`;
      merged.updatedAt = new Date().toISOString();
      await host.flavors.put(merged, 'three-way merge');
      toast.success(`Merged into ${merged.id}`);
      onMerged?.(merged);
      onClose();
    } catch (err) {
      toast.error(`Merge failed: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setBusy(false);
    }
  };

  if (!theirs) return null;

  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <GitMerge className="h-4 w-4" />
            Merge flavor
          </DialogTitle>
        </DialogHeader>

        {!ours || !base ? (
          <div className="text-sm text-muted-foreground">
            No active flavor — switch to a flavor first, then retry the merge.
          </div>
        ) : !mergeResult ? (
          <div className="text-sm text-muted-foreground">Computing merge…</div>
        ) : mergeResult.conflicts.length === 0 ? (
          <div className="space-y-3">
            <div className="text-sm">
              Clean merge — no conflicts between{' '}
              <span className="font-medium">{theirs.name}</span> and{' '}
              <span className="font-medium">{ours.name}</span>.
            </div>
            <div className="flex justify-end gap-2">
              <Button variant="ghost" size="sm" onClick={onClose} disabled={busy}>Cancel</Button>
              <Button size="sm" onClick={() => void handleApply()} disabled={busy}>
                <Check className="mr-1 h-3.5 w-3.5" />
                Save merged flavor
              </Button>
            </div>
          </div>
        ) : (
          <div className="space-y-3">
            <div className="text-xs text-muted-foreground">
              {mergeResult.conflicts.length} conflict
              {mergeResult.conflicts.length === 1 ? '' : 's'} between{' '}
              <span className="font-medium">{theirs.name}</span> (theirs) and{' '}
              <span className="font-medium">{ours.name}</span> (ours).
            </div>

            <ul className="divide-y border rounded max-h-[420px] overflow-y-auto">
              {mergeResult.conflicts.map((conflict) => {
                const key = conflictKey(conflict);
                const choice = resolutions[key] ?? 'ours';
                return (
                  <li key={key} className="px-3 py-2 space-y-1.5">
                    <div className="flex items-center gap-2 text-xs">
                      <code className="font-mono uppercase text-[10px] bg-muted rounded px-1.5 py-0.5">
                        {conflict.kind}
                      </code>
                      <span className="font-mono text-[11px] break-all">{conflict.key}</span>
                    </div>
                    <div className="grid grid-cols-3 gap-2 text-[11px]">
                      <ResolutionChip
                        label="Theirs"
                        value={conflict.theirs}
                        active={choice === 'theirs'}
                        onClick={() => setResolutions((r) => ({ ...r, [key]: 'theirs' }))}
                      />
                      <ResolutionChip
                        label="Ours"
                        value={conflict.ours}
                        active={choice === 'ours'}
                        onClick={() => setResolutions((r) => ({ ...r, [key]: 'ours' }))}
                      />
                      {conflict.base !== undefined && (
                        <ResolutionChip
                          label="Base"
                          value={conflict.base}
                          active={choice === 'base'}
                          onClick={() => setResolutions((r) => ({ ...r, [key]: 'base' }))}
                        />
                      )}
                    </div>
                  </li>
                );
              })}
            </ul>

            <div className="flex items-center justify-end gap-2 pt-1">
              <Button variant="ghost" size="sm" onClick={onClose} disabled={busy}>
                <X className="mr-1 h-3.5 w-3.5" />
                Cancel
              </Button>
              <Button size="sm" onClick={() => void handleApply()} disabled={busy}>
                <Check className="mr-1 h-3.5 w-3.5" />
                Save merged flavor
              </Button>
            </div>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}

function ResolutionChip({
  label,
  value,
  active,
  onClick,
}: {
  label: string;
  value: unknown;
  active: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`text-left rounded border px-2 py-1.5 transition-colors ${
        active
          ? 'border-primary bg-primary/10'
          : 'border-muted bg-muted/30 hover:bg-muted/50'
      }`}
    >
      <div className="text-[10px] uppercase tracking-wide font-semibold text-muted-foreground">
        {label}
      </div>
      <div className="font-mono text-[10px] mt-0.5 break-all line-clamp-3">
        {formatValue(value)}
      </div>
    </button>
  );
}

function formatValue(value: unknown): string {
  if (value === null || value === undefined) return '—';
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  try {
    return JSON.stringify(value);
  } catch {
    return '(unserialisable)';
  }
}

/**
 * Best-effort application of a non-default conflict choice onto a
 * merged flavor. Covers the kinds where post-merge fixup is
 * straightforward; complex shapes (lenses, queries, keybindings)
 * already use list-id resolution at merge time.
 */
function applyChoice(
  merged: Flavor,
  conflict: MergeConflict,
  choice: 'theirs' | 'base',
  theirs: Flavor,
  base: Flavor,
): void {
  const source = choice === 'theirs' ? theirs : base;
  switch (conflict.kind) {
    case 'extension_version':
    case 'extension_capabilities': {
      const src = source.extensions.find((e) => e.id === conflict.key);
      if (!src) return;
      const idx = merged.extensions.findIndex((e) => e.id === conflict.key);
      if (idx >= 0) {
        merged.extensions[idx] = src;
      } else {
        merged.extensions = [...merged.extensions, src];
      }
      break;
    }
    case 'setting': {
      merged.settings = { ...merged.settings, [conflict.key]: source.settings[conflict.key] };
      break;
    }
    case 'lens': {
      const src = source.lenses.find((l) => l.id === conflict.key);
      if (!src) return;
      const idx = merged.lenses.findIndex((l) => l.id === conflict.key);
      if (idx >= 0) merged.lenses[idx] = src;
      break;
    }
    case 'saved_query': {
      const src = source.savedQueries.find((q) => q.id === conflict.key);
      if (!src) return;
      const idx = merged.savedQueries.findIndex((q) => q.id === conflict.key);
      if (idx >= 0) merged.savedQueries[idx] = src;
      break;
    }
    case 'keybinding': {
      const [command, key] = conflict.key.split('@');
      const src = source.keybindings.find((k) => k.command === command && k.key === key);
      if (!src) return;
      const idx = merged.keybindings.findIndex((k) => k.command === command && k.key === key);
      if (idx >= 0) merged.keybindings[idx] = src;
      break;
    }
  }
}
