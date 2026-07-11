/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Draft section of the Layers panel (#1717 V2): pending viewer edits →
 * an immutable, content-addressed layer on the browser-local store, then
 * straight back into the live composition as the strongest overlay so
 * the published layer appears in the stack it just changed.
 */

import { useCallback, useMemo, useState } from 'react';
import { PenLine, UploadCloud } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { useViewerStore } from '@/store';
import { useIfc } from '@/hooks/useIfc';
import { toast } from '@/components/ui/toast';
import { getBrowserLayerStore, DEFAULT_LOCAL_REF } from '@/lib/layers/browser-store';
import { publishViewerDraft } from '@/lib/layers/publish';
import type { Mutation } from '@ifc-lite/mutations';

const AUTHOR_STORAGE_KEY = 'ifc-lite:layer-author';

function storedAuthor(): string {
  if (typeof window === 'undefined') return 'viewer-user';
  const stored = window.localStorage.getItem(AUTHOR_STORAGE_KEY);
  if (stored) return stored;
  // Authenticated registries bind the manifest author to the login
  // principal — seed from the collab identity so pushes have a chance
  // of matching it out of the box.
  const identity = useViewerStore.getState().collabIdentity?.name;
  return identity && identity.trim().length > 0 ? identity : 'viewer-user';
}

/**
 * Pending mutations of the FEDERATED composition only. Reads the UNDO
 * stacks, not the view's mutation history: the history is append-only
 * (undo applies inverse ops without removing the record), so publishing
 * from it would resurrect edits the user explicitly undid.
 *
 * Models outside the composition (a STEP model added alongside) have
 * their own overlapping expressId space — resolving those ids through
 * the composition's path bridge would publish onto unrelated entities,
 * so only models sharing the composed data store contribute. Georef
 * pseudo-mutations (entityId 0, georef.* attribute names) carry no
 * entity identity and are dropped.
 */
function pendingMutations(): Mutation[] {
  const state = useViewerStore.getState();
  const out: Mutation[] = [];
  for (const [modelId, model] of state.models) {
    if (model.ifcDataStore !== state.ifcDataStore) continue;
    for (const mutation of state.undoStacks.get(modelId) ?? []) {
      if (mutation.attributeName?.startsWith('georef.')) continue;
      out.push(mutation);
    }
  }
  return out;
}

export function LayerDraftSection() {
  const { addIfcxOverlays } = useIfc();
  // mutationVersion drives the pending count; layerStack drives eligibility.
  const mutationVersion = useViewerStore((s) => s.mutationVersion);
  const stackSize = useViewerStore((s) => s.layerStack.length);
  const [intent, setIntent] = useState('');
  const [author, setAuthor] = useState(storedAuthor);
  const [busy, setBusy] = useState(false);

  const pendingCount = useMemo(() => {
    void mutationVersion;
    return pendingMutations().length;
  }, [mutationVersion]);

  const publish = useCallback(async () => {
    const state = useViewerStore.getState();
    const trimmedIntent = intent.trim();
    const trimmedAuthor = author.trim() || 'viewer-user';
    if (!trimmedIntent) return;
    window.localStorage.setItem(AUTHOR_STORAGE_KEY, trimmedAuthor);
    setBusy(true);
    try {
      // Invert the composition bridge: expressId → path.
      const idToPath = new Map<number, string>();
      for (const [path, id] of state.layerStackPathToId ?? []) idToPath.set(id, path);

      const store = await getBrowserLayerStore();
      const result = publishViewerDraft({
        store,
        stackFiles: state.layerStack.map((e) => e.file),
        mutations: pendingMutations(),
        pathOf: (expressId) => idToPath.get(expressId),
        intent: trimmedIntent,
        authorPrincipal: trimmedAuthor,
        refName: DEFAULT_LOCAL_REF,
      });
      if (result.unresolved.length > 0) {
        // A partial publish must not recompose: the federation reload
        // resets viewer state, which would erase the very edits we
        // promise to keep. The layer is on the ref; stack it after the
        // identities are fixed (re-publishing folds idempotently).
        toast.info(
          `Published to '${DEFAULT_LOCAL_REF}', but ${result.unresolved.length} edited ${result.unresolved.length === 1 ? 'entity' : 'entities'} had no stable identity and stayed out. Pending edits were kept; the layer was not stacked.`,
        );
        setIntent('');
        return;
      }
      // The edits now live in the published layer; drop them as pending
      // BEFORE the recompose (the federation reload resets viewer state,
      // so nothing of value is lost by it).
      useViewerStore.getState().clearAllMutations();
      // Feed the published layer back into the live composition — the
      // federation reload recaptures the stack, so it shows up on top.
      const json = JSON.stringify(result.file);
      const fileName = `${trimmedIntent.slice(0, 40).replace(/[^\w-]+/g, '-') || 'layer'}.ifcx`;
      await addIfcxOverlays([new File([json], fileName, { type: 'application/json' })]);
      setIntent('');
      toast.success(`Published ${result.layerId.slice(0, 15)}… to '${DEFAULT_LOCAL_REF}' (${result.opCount} ops).`);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }, [intent, author, addIfcxOverlays]);

  if (stackSize === 0) return null;

  return (
    <div className="rounded-md border border-dashed bg-card/30 p-2">
      <div className="flex items-center gap-1.5 pb-1.5 text-[11px] font-medium">
        <PenLine className="size-3" aria-hidden />
        <span>Draft layer</span>
        <span
          className={`ml-auto rounded-full border px-1.5 py-px text-[10px] leading-none ${
            pendingCount > 0
              ? 'border-amber-500/30 bg-amber-500/10 text-amber-600 dark:text-amber-300'
              : 'border-border text-muted-foreground'
          }`}
        >
          {pendingCount} pending {pendingCount === 1 ? 'edit' : 'edits'}
        </span>
      </div>
      {pendingCount === 0 ? (
        <p className="text-[11px] text-muted-foreground">
          Edit properties in the model, then freeze the changes here as a new layer.
        </p>
      ) : (
        <div className="flex flex-col gap-1.5">
          <Input
            value={intent}
            onChange={(e) => setIntent(e.target.value)}
            placeholder="Intent, e.g. Set fire ratings for EG walls"
            className="h-7 text-xs"
            disabled={busy}
          />
          <div className="flex items-center gap-1.5">
            <Input
              value={author}
              onChange={(e) => setAuthor(e.target.value)}
              placeholder="Author"
              className="h-7 flex-1 text-xs"
              disabled={busy}
            />
            <Button
              size="sm"
              className="h-7 gap-1 px-2 text-[11px]"
              disabled={busy || intent.trim().length === 0}
              onClick={() => void publish()}
            >
              <UploadCloud className="size-3" aria-hidden />
              {busy ? 'Publishing…' : 'Publish'}
            </Button>
          </div>
          <p className="text-[10px] text-muted-foreground">
            Freezes the pending edits as a content-addressed layer on the local ref
            &apos;{DEFAULT_LOCAL_REF}&apos; and stacks it onto the composition.
          </p>
        </div>
      )}
    </div>
  );
}
