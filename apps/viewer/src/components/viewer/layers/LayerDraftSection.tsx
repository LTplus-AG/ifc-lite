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
import { publishCollabDraft, publishViewerDraft } from '@/lib/layers/publish';
import { pendingCompositionMutations } from '@/lib/layers/pending';
import { Users } from 'lucide-react';

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

export function LayerDraftSection() {
  const { addIfcxOverlays } = useIfc();
  // mutationVersion drives the pending count; layerStack drives eligibility.
  const mutationVersion = useViewerStore((s) => s.mutationVersion);
  const stackSize = useViewerStore((s) => s.layerStack.length);
  const collabSession = useViewerStore((s) => s.collabSession);
  const collabDraftBaseline = useViewerStore((s) => s.collabDraftBaseline);
  const collabPeers = useViewerStore((s) => s.collabPeers);
  const [intent, setIntent] = useState('');
  const [author, setAuthor] = useState(storedAuthor);
  const [busy, setBusy] = useState(false);

  const pendingCount = useMemo(() => {
    void mutationVersion;
    return pendingCompositionMutations().length;
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
        mutations: pendingCompositionMutations(),
        pathOf: (expressId) => idToPath.get(expressId),
        intent: trimmedIntent,
        authorPrincipal: trimmedAuthor,
        refName: DEFAULT_LOCAL_REF,
      });
      if (result.unresolved.length > 0 || result.skippedCount > 0) {
        // A partial publish must not recompose OR clear: the federation
        // reload resets viewer state and clearAllMutations would drop the
        // very edits (unresolved identity / no layer representation) we
        // promise to keep. The layer is on the ref; stack it after the
        // leftovers are dealt with (re-publishing folds idempotently).
        const parts = [
          result.unresolved.length > 0
            ? `${result.unresolved.length} edited ${result.unresolved.length === 1 ? 'entity' : 'entities'} had no stable identity`
            : null,
          result.skippedCount > 0
            ? `${result.skippedCount} edit${result.skippedCount === 1 ? '' : 's'} had no layer representation`
            : null,
        ].filter(Boolean);
        toast.info(
          `Published to '${DEFAULT_LOCAL_REF}', but ${parts.join(' and ')} and stayed out. Pending edits were kept; the layer was not stacked.`,
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

  const publishSession = useCallback(async () => {
    const state = useViewerStore.getState();
    const session = state.collabSession;
    const baseline = state.collabDraftBaseline;
    const trimmedIntent = intent.trim();
    const trimmedAuthor = author.trim() || 'viewer-user';
    if (!session || !baseline || !trimmedIntent) return;
    window.localStorage.setItem(AUTHOR_STORAGE_KEY, trimmedAuthor);
    setBusy(true);
    try {
      const store = await getBrowserLayerStore();
      const result = await publishCollabDraft({
        store,
        doc: session.doc,
        baseline,
        stackFiles: state.layerStack.map((e) => e.file),
        intent: trimmedIntent,
        authorPrincipal: trimmedAuthor,
        // Anyone present since the baseline may have edits in the doc —
        // including peers who already left.
        hybrid: state.collabPeers.length > 0 || state.collabPeersSinceBaseline,
        refName: DEFAULT_LOCAL_REF,
      });
      // The published layer absorbed everything since the fork point;
      // move the fork forward so the next publish is delta-only. Local
      // pending mutations are part of that layer, so clear them too.
      useViewerStore.getState().resetCollabDraftBaseline();
      useViewerStore.getState().clearAllMutations();
      const json = JSON.stringify(result.file);
      const fileName = `${trimmedIntent.slice(0, 40).replace(/[^\w-]+/g, '-') || 'session-layer'}.ifcx`;
      await addIfcxOverlays([new File([json], fileName, { type: 'application/json' })]);
      setIntent('');
      toast.success(
        `Published session draft ${result.layerId.slice(0, 15)}… to '${DEFAULT_LOCAL_REF}' (${result.opCount} ops).`,
      );
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }, [intent, author, addIfcxOverlays]);

  if (stackSize === 0) return null;

  const sessionReady = collabSession !== null && collabDraftBaseline !== null;

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
      {pendingCount === 0 && !sessionReady ? (
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
            {pendingCount > 0 && (
              <Button
                size="sm"
                className="h-7 gap-1 px-2 text-[11px]"
                disabled={busy || intent.trim().length === 0}
                onClick={() => void publish()}
              >
                <UploadCloud className="size-3" aria-hidden />
                {busy ? 'Publishing…' : 'Publish'}
              </Button>
            )}
          </div>
          {pendingCount > 0 && (
            <p className="text-[10px] text-muted-foreground">
              Freezes the pending edits as a content-addressed layer on the local ref
              &apos;{DEFAULT_LOCAL_REF}&apos; and stacks it onto the composition.
            </p>
          )}
          {sessionReady && (
            <>
              <Button
                size="sm"
                variant="outline"
                className="h-7 gap-1 self-start px-2 text-[11px]"
                disabled={busy || intent.trim().length === 0}
                onClick={() => void publishSession()}
              >
                <Users className="size-3" aria-hidden />
                {busy ? 'Publishing…' : 'Publish session edits'}
              </Button>
              <p className="text-[10px] text-muted-foreground">
                Freezes the live session&apos;s Y.Doc edits since {collabPeers.length > 0 ? 'joining' : 'the last publish'}
                {collabPeers.length > 0
                  ? ` — including ${collabPeers.length} peer${collabPeers.length === 1 ? "'s" : "s'"} edits (author kind: hybrid)`
                  : ''}
                .
              </p>
            </>
          )}
        </div>
      )}
    </div>
  );
}
