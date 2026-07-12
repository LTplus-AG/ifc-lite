/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Review comments as BCF topics (08-review.md §8.6) for a (candidate,
 * registry ref) pair: open the PR object, comment on the selected entity
 * with an optional captured viewpoint, read the thread, and export it as
 * plain BCF for foreign tools. Topics are entity-bound by composition
 * path (the IFC GUID) via the layerStackPathToId bridge — expressIds are
 * synthetic per parse and never persisted.
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import { Download, MessageSquarePlus, RefreshCw } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { toast } from '@/components/ui/toast';
import { useViewerStore } from '@/store';
import { useBCF } from '@/hooks/useBCF';
import {
  addTopicToProject,
  addViewpointToTopic,
  createBCFProject,
  createBCFTopic,
  writeBCF,
  type BCFViewpoint,
} from '@ifc-lite/bcf';
import { downloadBlob } from '@/lib/export/download';
import type { LayerRegistryClient, RegistryReviewSummary, RegistryReviewTopic } from '@/lib/layers/registry-client';
import { ensureCandidateOnRegistry } from '@/lib/layers/merge';
import { getBrowserLayerStore } from '@/lib/layers/browser-store';
import { pathTail } from '@/lib/layers/stack';

function TopicRow({ topic, onSelect }: { topic: RegistryReviewTopic; onSelect: (entity: string) => void }) {
  return (
    <button
      type="button"
      onClick={() => onSelect(topic.entity)}
      className="rounded border bg-card/40 px-1.5 py-1 text-left hover:bg-muted/60"
      title="Select the commented entity in 3D"
    >
      <span className="block truncate text-[11px] font-medium">{topic.title}</span>
      {topic.description && (
        <span className="block truncate text-[10px] text-muted-foreground">{topic.description}</span>
      )}
      <span className="block text-[10px] text-muted-foreground">
        {pathTail(topic.entity)}
        {topic.componentKey ? ` · ${topic.componentKey}` : ''} · {topic.author ?? 'anonymous'} ·{' '}
        {topic.createdAt.slice(0, 10)}
        {topic.viewpoint ? ' · viewpoint' : ''}
      </span>
    </button>
  );
}

export function LayerReviewSection({
  client,
  candidateId,
  refName,
}: {
  client: LayerRegistryClient;
  candidateId: string;
  refName: string;
}) {
  const { createViewpointFromState } = useBCF();
  const selectedEntityIds = useViewerStore((s) => s.selectedEntityIds);
  const activeEntityId = useViewerStore((s) => s.selectedEntityId);
  const pathToId = useViewerStore((s) => s.layerStackPathToId);

  const [review, setReview] = useState<RegistryReviewSummary | null>(null);
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [withViewpoint, setWithViewpoint] = useState(true);
  const [busy, setBusy] = useState(false);

  // The commented entity is the ACTIVE 3D selection (last-selected wins,
  // matching the selection slice), translated back to its composition
  // path (path == IFC GUID); fall back to the set for single-select.
  const selectedPath = useMemo(() => {
    const target = activeEntityId ?? [...(selectedEntityIds ?? [])][0];
    if (target === undefined || target === null || !pathToId) return null;
    for (const [path, id] of pathToId) {
      if (id === target) return path;
    }
    return null;
  }, [activeEntityId, selectedEntityIds, pathToId]);

  const refresh = useCallback(async () => {
    try {
      const { reviews } = await client.listReviews();
      const latest = reviews
        .filter((r) => r.layerId === candidateId && r.into === refName)
        .reduce<RegistryReviewSummary | null>(
          (acc, r) => (acc === null || r.openedAt >= acc.openedAt ? r : acc),
          null,
        );
      setReview(latest);
    } catch {
      setReview(null);
    }
  }, [client, candidateId, refName]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const openReview = useCallback(async () => {
    setBusy(true);
    try {
      // A freshly published local candidate is not on the registry yet;
      // the reviews route 404s unknown layer ids. Same push-first step
      // the preview/merge paths take (idempotent re-push).
      await ensureCandidateOnRegistry(client, await getBrowserLayerStore(), candidateId);
      await client.openReview({ layer_id: candidateId, into: refName });
      await refresh();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }, [client, candidateId, refName, refresh]);

  const postComment = useCallback(async () => {
    if (!review || !selectedPath || title.trim().length === 0) return;
    setBusy(true);
    try {
      let viewpoint: Record<string, unknown> | undefined;
      if (withViewpoint) {
        const vp = await createViewpointFromState({
          includeSnapshot: true,
          includeSelection: true,
          includeHidden: false,
        });
        // snapshotData is a Uint8Array (not JSON); the data-URL `snapshot`
        // field carries the image across the wire instead.
        const { snapshotData: _drop, ...serializable } = vp as BCFViewpoint & { snapshotData?: Uint8Array };
        viewpoint = serializable as unknown as Record<string, unknown>;
      }
      await client.postTopic(review.id, {
        title: title.trim(),
        ...(description.trim().length > 0 ? { description: description.trim() } : {}),
        entity: selectedPath,
        ...(viewpoint !== undefined ? { viewpoint } : {}),
      });
      setTitle('');
      setDescription('');
      await refresh();
      toast.success('Review comment posted.');
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }, [review, selectedPath, title, description, withViewpoint, createViewpointFromState, client, refresh]);

  const selectEntity = useCallback(
    (entity: string) => {
      const id = pathToId?.get(entity);
      if (id !== undefined) useViewerStore.getState().setSelectedEntityIds([id]);
    },
    [pathToId],
  );

  const exportBcf = useCallback(async () => {
    if (!review || !(review.topics?.length)) return;
    setBusy(true);
    try {
      const project = createBCFProject({ name: `review-${review.id.slice(0, 8)}` });
      for (const t of review.topics) {
        const topic = createBCFTopic({
          title: t.title,
          ...(t.description !== undefined ? { description: t.description } : {}),
          author: t.author ?? 'anonymous',
        });
        topic.guid = t.guid;
        topic.creationDate = t.createdAt;
        addTopicToProject(project, topic);
        if (t.viewpoint) addViewpointToTopic(topic, t.viewpoint as unknown as BCFViewpoint);
      }
      downloadBlob(await writeBCF(project), `review-${review.id.slice(0, 8)}.bcfzip`);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }, [review]);

  return (
    <div className="flex flex-col gap-1 rounded border bg-card/40 px-1.5 py-1">
      <div className="flex items-center gap-1 text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
        <span>Review</span>
        {review && <span className="normal-case">({review.status})</span>}
        <Button
          variant="ghost"
          size="sm"
          className="ml-auto h-5 px-1"
          onClick={() => void refresh()}
          aria-label="Refresh review"
        >
          <RefreshCw className="size-3" aria-hidden />
        </Button>
        {review && (review.topics?.length ?? 0) > 0 && (
          <Button
            variant="ghost"
            size="sm"
            className="h-5 gap-0.5 px-1 text-[10px]"
            onClick={() => void exportBcf()}
            disabled={busy}
            aria-label="Export review comments as BCF"
          >
            <Download className="size-3" aria-hidden />
            .bcf
          </Button>
        )}
      </div>
      {!review && (
        <Button size="sm" variant="outline" className="h-6 self-start px-2 text-[11px]" disabled={busy} onClick={() => void openReview()}>
          Open review
        </Button>
      )}
      {review && (
        <>
          {(review.topics ?? []).map((topic) => (
            <TopicRow key={topic.guid} topic={topic} onSelect={selectEntity} />
          ))}
          <input
            type="text"
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            placeholder={selectedPath ? `Comment on ${pathTail(selectedPath)}` : 'Select an entity in 3D to comment'}
            aria-label="Review comment title"
            className="h-6 rounded border bg-background px-1.5 text-[11px] placeholder:text-muted-foreground/60"
          />
          <textarea
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            rows={2}
            placeholder="Description (optional)"
            aria-label="Review comment description"
            className="resize-y rounded border bg-background px-1.5 py-1 text-[11px] placeholder:text-muted-foreground/60"
          />
          <div className="flex items-center gap-1.5">
            <label className="flex items-center gap-1 text-[10px] text-muted-foreground">
              <input
                type="checkbox"
                checked={withViewpoint}
                onChange={(e) => setWithViewpoint(e.target.checked)}
              />
              viewpoint
            </label>
            <Button
              size="sm"
              className="ml-auto h-6 gap-1 px-2 text-[11px]"
              disabled={busy || !selectedPath || title.trim().length === 0}
              onClick={() => void postComment()}
            >
              <MessageSquarePlus className="size-3" aria-hidden />
              Comment
            </Button>
          </div>
        </>
      )}
    </div>
  );
}
