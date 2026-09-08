/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Save/reopen a portable federation setup (#3930).
 *
 * Mounted once from `useFileCommands` (same pattern as `ShareDialog`), so it
 * is reachable from the command palette regardless of which toolbar style is
 * active. Two hidden `<input type="file">`s drive the two-step "open" flow
 * (pick the saved `.federation.json`, then pick the local model files to
 * match against it); the review step never applies anything silently — every
 * slot is shown as matched, mismatched (same name, different content/size),
 * or missing before the user confirms.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { AlertTriangle, Anchor, Check, FileWarning } from 'lucide-react';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { toast } from '@/components/ui/toast';
import { useFederationSetup } from '@/hooks/useFederationSetup';
import {
  parseFederationSetupFile,
  type FederationSetupFile,
  type FederationSetupSlotMatch,
} from '@/lib/federation/federationSetupFile';

const EVENT_SAVE = 'ifc-lite:save-federation-setup';
const EVENT_OPEN = 'ifc-lite:open-federation-setup';

function confidenceBadge(match: FederationSetupSlotMatch): { label: string; icon: typeof Check; tone: string } {
  switch (match.confidence) {
    case 'content':
      return { label: 'Matched', icon: Check, tone: 'text-emerald-600 dark:text-emerald-400' };
    case 'name-size':
      return { label: 'Matched (by name)', icon: Check, tone: 'text-emerald-600 dark:text-emerald-400' };
    case 'name-only':
      return { label: 'Same name, different file', icon: FileWarning, tone: 'text-amber-600 dark:text-amber-400' };
    case 'none':
      return { label: 'Missing', icon: AlertTriangle, tone: 'text-red-600 dark:text-red-400' };
  }
}

export function FederationSetupControls() {
  const { exportFederationSetup, matchFederationSetup, applyFederationSetup } = useFederationSetup();

  const setupFileInputRef = useRef<HTMLInputElement>(null);
  const modelFilesInputRef = useRef<HTMLInputElement>(null);
  const [pendingSetup, setPendingSetup] = useState<FederationSetupFile | null>(null);
  const [matches, setMatches] = useState<FederationSetupSlotMatch[] | null>(null);
  const [applying, setApplying] = useState(false);

  const handleSave = useCallback(() => {
    void exportFederationSetup().then((result) => {
      if (!result.ok) toast.error(result.error);
      else toast.success('Federation setup saved.');
    });
  }, [exportFederationSetup]);

  useEffect(() => {
    const onSave = () => handleSave();
    const onOpen = () => setupFileInputRef.current?.click();
    window.addEventListener(EVENT_SAVE, onSave);
    window.addEventListener(EVENT_OPEN, onOpen);
    return () => {
      window.removeEventListener(EVENT_SAVE, onSave);
      window.removeEventListener(EVENT_OPEN, onOpen);
    };
  }, [handleSave]);

  const handleSetupFileSelected = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;
    void file.text().then((text) => {
      const result = parseFederationSetupFile(text);
      if (!result.ok) {
        toast.error(`Not a valid federation setup file: ${result.error}`);
        return;
      }
      setPendingSetup(result.setup);
      toast.info(
        `Loaded a setup with ${result.setup.slots.length} model slot${result.setup.slots.length === 1 ? '' : 's'} — now pick the model file(s) to match against it.`,
      );
      modelFilesInputRef.current?.click();
    });
  }, []);

  const handleModelFilesSelected = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(e.target.files ?? []);
    e.target.value = '';
    if (!pendingSetup || files.length === 0) return;
    void matchFederationSetup(pendingSetup, files).then(setMatches);
  }, [pendingSetup, matchFederationSetup]);

  const closeReview = useCallback(() => {
    setMatches(null);
    setPendingSetup(null);
  }, []);

  const handleApply = useCallback(() => {
    if (!matches) return;
    setApplying(true);
    void applyFederationSetup(matches).then((result) => {
      setApplying(false);
      closeReview();
      if (result.outcome === 'failed') {
        toast.error('Could not restore the federation setup — none of the saved models were found.');
        return;
      }
      const parts: string[] = [`Restored ${result.restoredCount}/${result.totalSlots} model(s)`];
      if (result.missingSlots.length > 0) parts.push(`missing: ${result.missingSlots.join(', ')}`);
      if (result.mismatchedSlots.length > 0) parts.push(`same name, different content: ${result.mismatchedSlots.join(', ')}`);
      if (result.anchorMissing) parts.push('alignment anchor could not be restored');
      const message = parts.join(' — ');
      if (result.outcome === 'restored' && !result.anchorMissing) toast.success(message);
      else toast.error(message);
    });
  }, [matches, applyFederationSetup, closeReview]);

  return (
    <>
      <input
        ref={setupFileInputRef}
        type="file"
        accept=".json,application/json"
        className="hidden"
        onChange={handleSetupFileSelected}
      />
      <input
        ref={modelFilesInputRef}
        type="file"
        multiple
        className="hidden"
        onChange={handleModelFilesSelected}
      />
      <Dialog open={matches !== null} onOpenChange={(open) => { if (!open) closeReview(); }}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Reopen federation setup</DialogTitle>
            <DialogDescription>
              Review how each saved model slot matched your local files before restoring.
            </DialogDescription>
          </DialogHeader>
          <div className="max-h-80 overflow-y-auto space-y-1">
            {matches?.map((match) => {
              const badge = confidenceBadge(match);
              const Icon = badge.icon;
              return (
                <div
                  key={match.slotIndex}
                  className="flex items-center gap-2 px-2 py-1.5 border border-zinc-200 dark:border-zinc-800 rounded text-sm"
                >
                  {match.slot.anchor && <Anchor className="h-3.5 w-3.5 text-amber-600 dark:text-amber-400 shrink-0" />}
                  <span className="truncate flex-1">{match.slot.name}</span>
                  <span className={`inline-flex items-center gap-1 text-xs ${badge.tone}`}>
                    <Icon className="h-3.5 w-3.5" />
                    {badge.label}
                  </span>
                </div>
              );
            })}
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={closeReview} disabled={applying}>Cancel</Button>
            <Button
              onClick={handleApply}
              disabled={applying || !matches?.some((m) => m.file !== null)}
            >
              {applying ? 'Restoring…' : 'Restore federation'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}

export default FederationSetupControls;
