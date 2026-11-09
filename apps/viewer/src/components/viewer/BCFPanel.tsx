/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * BCFPanel - BIM Collaboration Format topic management panel
 *
 * Provides:
 * - Topic list with filtering
 * - Topic detail view with comments
 * - Viewpoint thumbnails with activation
 * - Create/edit topics and comments
 * - Import/export BCF files
 */

import { useCallback, useEffect, useState, useMemo } from 'react';
import {
  Download,
  MessageSquare,
  Upload,
  User,
  MapPin,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { tourAnchor, TOUR_ANCHORS } from '@/lib/tours/anchors';
import { Input } from '@/components/ui/input';
import { Badge } from '@/components/ui/badge';
import { useViewerStore } from '@/store';
import { posthog } from '@/lib/analytics';
import { toast } from '@/components/ui/toast';
import { useTranslation } from '@/i18n';
import type { BCFTopic, BCFViewpoint } from '@ifc-lite/bcf';
import {
  createBCFProject,
  createBCFTopic,
  createBCFComment,
} from '@ifc-lite/bcf';
import { getGlobalRenderer, useBCF } from '@/hooks/useBCF';
import { BCFTopicList } from './bcf/BCFTopicList';
import { BCFTopicDetail } from './bcf/BCFTopicDetail';
import { BCFCreateTopicForm } from './bcf/BCFCreateTopicForm';
import { useBcfServerActions } from './bcf/BCFServerControl';
import { AnalysisPanel } from './analysis/AnalysisPanel';
import { useBcfArchiveActions } from './bcf/useBcfArchiveActions';
import { useSectionViewpointCapture } from '@/hooks/bcf/useSectionViewpointCapture';
import { useAsyncRun } from '@/hooks/useAsyncRun';
import { captureViewpointForCreate } from '@/hooks/bcf/capture-viewpoint-for-create';
// ============================================================================
// Main BCF Panel Component
// ============================================================================
interface BCFPanelProps {
  onClose: () => void;
}

export function BCFPanel({ onClose }: BCFPanelProps) {
  const { t } = useTranslation();
  // Store state
  const bcfProject = useViewerStore((s) => s.bcfProject);
  const setBcfProject = useViewerStore((s) => s.setBcfProject);
  const activeTopicId = useViewerStore((s) => s.activeTopicId);
  const setActiveTopic = useViewerStore((s) => s.setActiveTopic);
  const addTopic = useViewerStore((s) => s.addTopic);
  const updateTopic = useViewerStore((s) => s.updateTopic);
  const deleteTopic = useViewerStore((s) => s.deleteTopic);
  const addComment = useViewerStore((s) => s.addComment);
  const addViewpoint = useViewerStore((s) => s.addViewpoint);
  const deleteViewpoint = useViewerStore((s) => s.deleteViewpoint);
  const bcfAuthor = useViewerStore((s) => s.bcfAuthor);
  const setBcfAuthor = useViewerStore((s) => s.setBcfAuthor);
  const bcfOverlayVisible = useViewerStore((s) => s.bcfOverlayVisible);
  const toggleBcfOverlay = useViewerStore((s) => s.toggleBcfOverlay);
  const bcfServer = useBcfServerActions();

  // Viewer state for capture feedback
  const selectedEntityId = useViewerStore((s) => s.selectedEntityId);
  const selectedEntityIds = useViewerStore((s) => s.selectedEntityIds);
  const hiddenEntities = useViewerStore((s) => s.hiddenEntities);
  const isolatedEntities = useViewerStore((s) => s.isolatedEntities);

  // Computed capture state info
  const selectionCount = useMemo(() => {
    let count = selectedEntityId !== null ? 1 : 0;
    count += selectedEntityIds.size;
    if (selectedEntityId !== null && selectedEntityIds.has(selectedEntityId)) {
      count--; // Avoid double-counting
    }
    return count;
  }, [selectedEntityId, selectedEntityIds]);
  // `isolatedEntities` is meaningfully nullable (`Set<number> | null`):
  // `null` means no isolation channel is active, while a non-null Set --
  // EMPTY included -- means one is and currently matches nothing (the
  // convention `packages/renderer/src/entity-visibility.ts`'s
  // `isEntityVisible` already enforces). A `.size > 0` check would read an
  // active-but-empty isolate (reachable via `pinboardSlice.ts`'s
  // `addToBasket`/`removeFromBasket` aliasing two `EntityRef`s onto one
  // globalId, #4509) as "no isolation" and show "Hidden objects" -- or
  // nothing at all -- instead of correctly reflecting that isolation is
  // active. `useBCF.ts`'s `createViewpointFromState` has the same guard.
  const hasIsolation = isolatedEntities !== null;
  const hasHiddenEntities = hiddenEntities.size > 0;
  const setBcfError = useViewerStore((s) => s.setBcfError);
  const bcfError = useViewerStore((s) => s.bcfError);
  const bcfLoading = useViewerStore((s) => s.bcfLoading);
  const models = useViewerStore((s) => s.models);

  const { createViewpointFromState, headerFilesForViewpoints, applyViewpoint, zoomToTopic, canZoomToTopic } = useBCF({ restoreSectionOnUnmount: true });
  const sectionCapture = useSectionViewpointCapture(createViewpointFromState);
  // Local state
  const [statusFilter, setStatusFilter] = useState('all');
  const [showCreateForm, setShowCreateForm] = useState(false);
  // Editing the active topic's fields in place (reuses the create form). (#1461)
  const [showEditForm, setShowEditForm] = useState(false);
  const [showAuthorDialog, setShowAuthorDialog] = useState(false);
  const [tempAuthor, setTempAuthor] = useState(bcfAuthor);
  // Viewpoint previewed in the create form and attached to the new topic.
  const [createViewpoint, setCreateViewpoint] = useState<BCFViewpoint | null>(null);
  // C-2: each opening of the create form owns its capture and its submit; a
  // second submit is refused and an earlier opening's capture is discarded.
  const captureFlight = useAsyncRun();
  const createFlight = useAsyncRun();
  // Add Viewpoint (3D) and Capture 2D append to the active topic: one capture
  // at a time, so a double press cannot append two viewpoints.
  const viewpointFlight = useAsyncRun();

  // Get topics list
  const topics = useMemo(() => {
    if (!bcfProject) return [];
    return Array.from(bcfProject.topics.values());
  }, [bcfProject]);

  // Get active topic
  const activeTopic = useMemo(() => {
    if (!bcfProject || !activeTopicId) return null;
    return bcfProject.topics.get(activeTopicId) || null;
  }, [bcfProject, activeTopicId]);

  // Get a default project name from loaded models
  const getDefaultProjectName = useCallback(() => {
    if (models.size === 0) {
      // No models loaded, use date-based name
      const date = new Date().toISOString().split('T')[0];
      return `BCF_Topics_${date}`;
    }
    // Use first model's name (without extension) + "_Topics"
    const firstModel = models.values().next().value;
    if (firstModel?.name) {
      const baseName = firstModel.name.replace(/\.(ifc|ifczip)$/i, '');
      return `${baseName}_Topics`;
    }
    return `BCF_Topics_${new Date().toISOString().split('T')[0]}`;
  }, [models]);

  // Initialize project if needed
  const ensureProject = useCallback(() => {
    if (!bcfProject) {
      setBcfProject(createBCFProject({ name: getDefaultProjectName() }));
    }
  }, [bcfProject, setBcfProject, getDefaultProjectName]);

  // Import / export the BCF archive (C-2: import latest-wins, export single-flight).
  const { fileInputRef, handleImport, handleImportClick, handleExport, exporting } = useBcfArchiveActions(bcfProject, getDefaultProjectName);

  // Capture the current view (camera + snapshot + selection) for the create
  // form's preview and the new topic's attached viewpoint.
  const runCapture = captureFlight.start;
  const captureCreateViewpoint = useCallback(() => runCapture(async ({ isCurrent }) => {
    try {
      const vp = await createViewpointFromState({
        includeSnapshot: true,
        includeSelection: true,
        includeHidden: true,
      });
      if (isCurrent()) setCreateViewpoint(vp);
    } catch (err) {
      console.error('[BCFPanel] failed to capture viewpoint for new topic', err);
    }
  }), [runCapture, createViewpointFromState]);

  // A snapshot is offered only while a viewport can capture one: with no model
  // loaded the viewport is not mounted, and a topic is created without one.
  const canCaptureSnapshot = getGlobalRenderer() !== null;
  // Grab a viewpoint when the create form opens; drop it when it closes.
  useEffect(() => {
    if (showCreateForm) {
      void captureCreateViewpoint();
    } else {
      captureFlight.reset();
      createFlight.reset();
      setCreateViewpoint(null);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [showCreateForm]);

  // Close the edit form whenever the active topic changes (back, delete, or
  // selecting another topic) so it never reopens onto a different topic. (#1461)
  useEffect(() => {
    setShowEditForm(false);
  }, [activeTopicId]);

  const runCreate = createFlight.start;
  const handleCreateTopic = useCallback(
    (data: Partial<BCFTopic>, options?: { includeSnapshot: boolean }) => runCreate(async ({ isCurrent }) => {
      // Resolve the viewpoint first so the topic's source-file Header can be
      // derived from the models its selection references before it is stored.
      let viewpoint = options?.includeSnapshot === false ? null : createViewpoint;
      if (options?.includeSnapshot !== false && !viewpoint) {
        const captured = await captureViewpointForCreate(
          () => createViewpointFromState({ includeSnapshot: true, includeSelection: true, includeHidden: true }),
          isCurrent, t('bcf.panel.captureViewpointFailed'), 'BCFPanel');
        if (!captured.ok) return;
        viewpoint = captured.viewpoint;
      }
      // The form was closed while the viewpoint was resolving: create nothing,
      // not even the empty project.
      if (!isCurrent()) return;
      ensureProject();
      const topic = createBCFTopic({
        title: data.title || t('bcf.panel.untitledTopic'),
        description: data.description,
        author: bcfAuthor,
        topicType: data.topicType,
        topicStatus: data.topicStatus ?? 'Open',
        priority: data.priority,
        assignedTo: data.assignedTo,
        dueDate: data.dueDate,
        labels: data.labels,
      });
      // Record the distinct source model(s) this topic touches (#1591 federation).
      const header = headerFilesForViewpoints(viewpoint ? [viewpoint] : [], topic.creationDate);
      if (header.length > 0) topic.header = header;
      addTopic(topic);
      if (viewpoint) addViewpoint(topic.guid, viewpoint);
      posthog.capture('bcf_topic_created', {
        topic_type: topic.topicType,
        priority: topic.priority,
        has_description: Boolean(topic.description),
        has_viewpoint: Boolean(viewpoint),
      });
      setShowCreateForm(false);
    }),
    [runCreate, ensureProject, bcfAuthor, addTopic, addViewpoint, createViewpoint, createViewpointFromState, headerFilesForViewpoints]
  );

  // Add comment to topic (optionally associated with a viewpoint)
  const handleAddComment = useCallback(
    (text: string, viewpointGuid?: string) => {
      if (!activeTopicId) return;
      const comment = createBCFComment({
        author: bcfAuthor,
        comment: text,
        viewpointGuid, // Associate with viewpoint if provided
      });
      addComment(activeTopicId, comment);
    },
    [activeTopicId, bcfAuthor, addComment]
  );

  const runViewpoint = viewpointFlight.start;
  const handleCaptureViewpoint = useCallback(async () => {
    if (!activeTopicId) return;
    await runViewpoint(async () => {
      // Create viewpoint from current camera, section plane, and selection state
      let viewpoint: BCFViewpoint | null = null;
      try {
        viewpoint = await createViewpointFromState({
          includeSnapshot: true,
          includeSelection: true,
          includeHidden: true,
        });
      } catch (err) {
        console.error('[BCFPanel] failed to capture viewpoint for topic', err);
      }
      // The capture belongs to the topic it was pressed on, even if another is open now.
      if (viewpoint) {
        addViewpoint(activeTopicId, viewpoint);
      } else {
        toast.error(t('bcf.panel.captureViewpointFailed'));
      }
    });
  }, [runViewpoint, activeTopicId, addViewpoint, createViewpointFromState, t]);

  // Activate viewpoint - apply camera and state to viewer
  const handleActivateViewpoint = useCallback((viewpoint: BCFViewpoint) => {
    applyViewpoint(viewpoint, true); // Animate to viewpoint
  }, [applyViewpoint]);

  const handleZoomToTopic = useCallback(() => {
    if (!activeTopic) return;
    zoomToTopic(activeTopic);
  }, [activeTopic, zoomToTopic]);

  // Delete viewpoint
  const handleDeleteViewpoint = useCallback(
    (viewpointGuid: string) => {
      if (!activeTopicId) return;
      deleteViewpoint(activeTopicId, viewpointGuid);
    },
    [activeTopicId, deleteViewpoint]
  );

  // Update topic status
  const handleUpdateStatus = useCallback(
    (status: string) => {
      if (!activeTopicId) return;
      updateTopic(activeTopicId, { topicStatus: status, modifiedAuthor: bcfAuthor });
    },
    [activeTopicId, updateTopic, bcfAuthor]
  );

  // Edit the active topic's fields in place. Empty optional fields come back as
  // `undefined` from the form, which clears them on merge. (#1461)
  const handleEditTopic = useCallback(
    (data: Partial<BCFTopic>) => {
      if (!activeTopicId) return;
      updateTopic(activeTopicId, {
        title: data.title?.trim() || activeTopic?.title || t('bcf.panel.untitledTopic'),
        description: data.description,
        topicType: data.topicType,
        topicStatus: data.topicStatus,
        priority: data.priority,
        assignedTo: data.assignedTo,
        dueDate: data.dueDate,
        labels: data.labels,
        modifiedAuthor: bcfAuthor,
      });
      setShowEditForm(false);
      posthog.capture('bcf_topic_edited', { topic_type: data.topicType });
    },
    [activeTopicId, activeTopic, updateTopic, bcfAuthor]
  );

  // Delete topic
  const handleDeleteTopic = useCallback(() => {
    if (!activeTopicId) return;
    deleteTopic(activeTopicId);
    setActiveTopic(null);
  }, [activeTopicId, deleteTopic, setActiveTopic]);

  // Save author
  const handleSaveAuthor = useCallback(() => {
    if (tempAuthor.trim()) {
      setBcfAuthor(tempAuthor.trim());
    }
    setShowAuthorDialog(false);
  }, [tempAuthor, setBcfAuthor]);

  return (
    <AnalysisPanel
      icon={<MessageSquare />}
      title={t('bcf.panel.title')}
      badge={topics.length > 0 && (
        <Badge variant="secondary" className="text-xs">
          {topics.length}
        </Badge>
      )}
      onClose={onClose}
      error={bcfError}
      onDismissError={() => setBcfError(null)}
      progress={bcfLoading ? { label: t('bcf.panel.busy') } : null}
      actions={[
        { id: 'bcf-import', label: t('bcf.panel.importTitle'), icon: <Upload className="h-4 w-4" />, onSelect: handleImportClick },
        {
          id: 'bcf-export', label: t('bcf.panel.exportTitle'), icon: <Download className="h-4 w-4" />,
          disabled: !bcfProject || topics.length === 0 || exporting, onSelect: () => { void handleExport(); }, data: tourAnchor(TOUR_ANCHORS.bcfExport),
        },
        bcfServer.server,
        bcfServer.drafts,
        {
          // One constant name; `pressed` alone says whether markers are shown (#8802).
          id: 'bcf-markers', label: t('bcf.panel.showMarkers'),
          icon: <MapPin className="h-4 w-4" />, pressed: bcfOverlayVisible, onSelect: toggleBcfOverlay,
        },
        {
          id: 'bcf-author', label: t('bcf.panel.setAuthorTitle'), icon: <User className="h-4 w-4" />,
          onSelect: () => { setTempAuthor(bcfAuthor); setShowAuthorDialog(true); },
        },
      ]}
      dialogs={(
        <>
          <input
            ref={fileInputRef}
            type="file"
            accept=".bcf,.bcfzip"
            onChange={handleImport}
            className="hidden"
          />
          {bcfServer.dialogs}
        </>
      )}
    >
      {/* Content */}
      <div className="flex-1 overflow-hidden relative">
        {showCreateForm ? (
          // Scroll the form — the full field set + snapshot can exceed the panel.
          <div className="h-full overflow-auto">
            <BCFCreateTopicForm
              onSubmit={handleCreateTopic}
              onCancel={() => setShowCreateForm(false)}
              author={bcfAuthor}
              snapshot={createViewpoint?.snapshot ?? null}
              onCaptureSnapshot={canCaptureSnapshot ? () => void captureCreateViewpoint() : undefined}
              capturingSnapshot={captureFlight.busy}
              submitting={createFlight.busy}
            />
          </div>
        ) : showEditForm && activeTopic ? (
          // Edit the active topic's fields in place. No snapshot capture here -
          // viewpoints are managed from the detail view. (#1461)
          <div className="h-full overflow-auto">
            <BCFCreateTopicForm
              key={activeTopic.guid}
              onSubmit={handleEditTopic}
              onCancel={() => setShowEditForm(false)}
              author={bcfAuthor}
              initialTopic={activeTopic}
              heading={t('bcf.createForm.editTopicHeading')}
              submitLabel={t('bcf.createForm.saveChangesSubmitLabel')}
            />
          </div>
        ) : activeTopic ? (
          <BCFTopicDetail
            topic={activeTopic}
            onBack={() => setActiveTopic(null)}
            onEditTopic={() => setShowEditForm(true)}
            onAddComment={handleAddComment}
            onAddViewpoint={handleCaptureViewpoint}
            onAddSectionViewpoint={() => void runViewpoint(sectionCapture.capture)}
            capturingViewpoint={viewpointFlight.busy}
            sectionViewpointBlockReason={sectionCapture.disabledReason}
            onActivateViewpoint={handleActivateViewpoint}
            onDeleteViewpoint={handleDeleteViewpoint}
            onUpdateStatus={handleUpdateStatus}
            onZoomToTopic={handleZoomToTopic}
            canZoomToTopic={activeTopic ? canZoomToTopic(activeTopic) : false}
            onDeleteTopic={handleDeleteTopic}
            selectionCount={selectionCount}
            hasIsolation={hasIsolation}
            hasHiddenEntities={hasHiddenEntities}
          />
        ) : (
          <BCFTopicList
            projectName={bcfProject?.name}
            topics={topics}
            onSelectTopic={setActiveTopic}
            onCreateTopic={() => setShowCreateForm(true)}
            statusFilter={statusFilter}
            onStatusFilterChange={setStatusFilter}
            author={bcfAuthor}
            onSetAuthor={setBcfAuthor}
          />
        )}

        {/* Author Dialog */}
        {showAuthorDialog && (
          <div className="absolute inset-0 bg-background/90 flex items-center justify-center p-4">
            <div className="bg-card border rounded-lg p-4 w-full max-w-xs">
              <h4 className="font-medium mb-3">{t('bcf.panel.setAuthorHeading')}</h4>
              <Input aria-label={t('bcf.panel.authorEmailLabel')}
                value={tempAuthor}
                onChange={(e) => setTempAuthor(e.target.value)}
                placeholder={t('bcf.shared.emailPlaceholder')}
                className="mb-4"
              />
              <div className="flex gap-2 justify-end">
                <Button variant="outline" size="sm" onClick={() => setShowAuthorDialog(false)}>{t('bcf.shared.cancel')}</Button>
                <Button size="sm" onClick={handleSaveAuthor}>{t('bcf.shared.save')}</Button>
              </div>
            </div>
          </div>
        )}
      </div>
    </AnalysisPanel>
  );
}
