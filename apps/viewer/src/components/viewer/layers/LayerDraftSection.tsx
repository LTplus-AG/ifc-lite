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
import { useTranslation } from '@/i18n';
import { useIfc } from '@/hooks/useIfc';
import { toast } from '@/components/ui/toast';
import { DEFAULT_LOCAL_REF } from '@/lib/layers/browser-store';
import { publishLocalLayerDraft } from '@/lib/layers/draft-workflow';
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
  const { t } = useTranslation();
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
    const trimmedIntent = intent.trim();
    const trimmedAuthor = author.trim() || 'viewer-user';
    if (!trimmedIntent) return;
    window.localStorage.setItem(AUTHOR_STORAGE_KEY, trimmedAuthor);
    setBusy(true);
    try {
      const outcome = await publishLocalLayerDraft('viewer', trimmedIntent, trimmedAuthor, { addIfcxOverlays});
      if (outcome.mode !== 'viewer') throw new Error('Unexpected native draft mode.');
      const result = outcome.result;
      if (result.unresolved.length > 0 || result.skippedCount > 0) {
        // A partial publish must not recompose OR clear: the federation
        // reload resets viewer state and clearAllMutations would drop the
        // very edits (unresolved identity / no layer representation) we
        // promise to keep. The layer is on the ref; stack it after the
        // leftovers are dealt with (re-publishing folds idempotently).
        const hasUnresolved = result.unresolved.length > 0;
        const hasSkipped = result.skippedCount > 0;
        const entityPhrase = t('layersPanel.draft.entityCountPhrase', {
          count: result.unresolved.length,
          countDisplay: String(result.unresolved.length),
        });
        const editPhrase = t('layersPanel.draft.editCountPhrase', {
          count: result.skippedCount,
          countDisplay: String(result.skippedCount),
        });
        const messageKey =
          hasUnresolved && hasSkipped
            ? 'layersPanel.draft.publishedPartialBoth'
            : hasUnresolved
              ? 'layersPanel.draft.publishedPartialUnresolved'
              : 'layersPanel.draft.publishedPartialSkipped';
        toast.info(t(messageKey, { ref: DEFAULT_LOCAL_REF, entityPhrase, editPhrase }));
        setIntent('');
        return;
      }
      setIntent('');
      toast.success(
        t('layersPanel.draft.publishedSuccess', {
          layerId: result.layerId.slice(0, 15),
          ref: DEFAULT_LOCAL_REF,
          opCount: result.opCount,
        }),
      );
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
      const outcome = await publishLocalLayerDraft('session', trimmedIntent, trimmedAuthor, { addIfcxOverlays});
      const result = outcome.result;
      setIntent('');
      toast.success(
        t('layersPanel.draft.publishedSessionSuccess', {
          layerId: result.layerId.slice(0, 15),
          ref: DEFAULT_LOCAL_REF,
          opCount: result.opCount,
        }),
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
      <div className="flex items-center gap-1.5 pb-1.5 text-2xs font-medium">
        <PenLine className="size-3" aria-hidden />
        <span>{t('layersPanel.draft.title')}</span>
        <span
          className={`ml-auto rounded-full border px-1.5 py-px text-2xs leading-none ${
            pendingCount > 0
              ? 'border-warn-border bg-warn-surface text-warn'
              : 'border-border text-muted-foreground'
          }`}
        >
          {t('layersPanel.draft.pendingBadge', { count: pendingCount, countDisplay: String(pendingCount) })}
        </span>
      </div>
      {pendingCount === 0 && !sessionReady ? (
        <p className="text-2xs text-muted-foreground">
          {t('layersPanel.draft.emptyPrompt')}
        </p>
      ) : (
        <div className="flex flex-col gap-1.5">
          <Input
            aria-label={t('layersPanel.draft.intentInputLabel')}
            value={intent}
            onChange={(e) => setIntent(e.target.value)}
            placeholder={t('layersPanel.draft.intentPlaceholder')}
            className="h-7 text-xs"
            disabled={busy}
          />
          <div className="flex items-center gap-1.5">
            <Input
              aria-label={t('layersPanel.draft.authorInputLabel')}
              value={author}
              onChange={(e) => setAuthor(e.target.value)}
              placeholder={t('layersPanel.draft.authorPlaceholder')}
              className="h-7 flex-1 text-xs"
              disabled={busy}
            />
            {pendingCount > 0 && (
              <Button
                size="sm"
                className="h-7 gap-1 px-2 text-2xs"
                disabled={busy || intent.trim().length === 0}
                onClick={() => void publish()}
              >
                <UploadCloud className="size-3" aria-hidden />
                {t(busy ? 'layersPanel.draft.publishing' : 'layersPanel.draft.publish')}
              </Button>
            )}
          </div>
          {pendingCount > 0 && (
            <p className="text-2xs text-muted-foreground">
              {t('layersPanel.draft.localRefNote', { ref: DEFAULT_LOCAL_REF })}
            </p>
          )}
          {sessionReady && (
            <>
              <Button
                size="sm"
                variant="outline"
                className="h-7 gap-1 self-start px-2 text-2xs"
                disabled={busy || intent.trim().length === 0}
                onClick={() => void publishSession()}
              >
                <Users className="size-3" aria-hidden />
                {t(busy ? 'layersPanel.draft.publishing' : 'layersPanel.draft.publishSessionEdits')}
              </Button>
              <p className="text-2xs text-muted-foreground">
                {collabPeers.length > 0
                  ? t('layersPanel.draft.sessionEditsSinceJoining', {
                      count: collabPeers.length,
                      countDisplay: String(collabPeers.length),
                    })
                  : t('layersPanel.draft.sessionEditsSinceLastPublish')}
              </p>
            </>
          )}
        </div>
      )}
    </div>
  );
}
