/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * BCFPanel - BIM Collaboration Format issue management panel
 *
 * Provides:
 * - Topic list with filtering
 * - Topic detail view with comments
 * - Viewpoint thumbnails with activation
 * - Create/edit topics and comments
 * - Import/export BCF files
 */

import React, { useCallback, useEffect, useState, useMemo, useRef } from 'react';
import {
  X,
  MessageSquare,
  Upload,
  Download,
  User,
  MapPin,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Badge } from '@/components/ui/badge';
import { useViewerStore } from '@/store';
import type { BCFTopic, BCFViewpoint } from '@ifc-lite/bcf';
import {
  readBCF,
  writeBCF,
  createBCFProject,
  createBCFTopic,
  createBCFComment,
} from '@ifc-lite/bcf';
import { useBCF } from '@/hooks/useBCF';
import { BCFTopicList } from './bcf/BCFTopicList';
import { BCFTopicDetail } from './bcf/BCFTopicDetail';
import { BCFCreateTopicForm } from './bcf/BCFCreateTopicForm';
import { openGenericFileDialog } from '@/services/file-dialog';
import { claimNextDesktopPanelAction, subscribeDesktopPanelActions } from '@/services/desktop-panel-actions';

// ============================================================================
// Main BCF Panel Component
// ============================================================================

interface BCFPanelProps {
  onClose: () => void;
}

export function BCFPanel({ onClose }: BCFPanelProps) {
  const fileInputRef = useRef<HTMLInputElement>(null);

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
  const setBcfLoading = useViewerStore((s) => s.setBcfLoading);
  const bcfOverlayVisible = useViewerStore((s) => s.bcfOverlayVisible);
  const toggleBcfOverlay = useViewerStore((s) => s.toggleBcfOverlay);

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
  const hasIsolation = isolatedEntities !== null && isolatedEntities.size > 0;
  const hasHiddenEntities = hiddenEntities.size > 0;
  const setBcfError = useViewerStore((s) => s.setBcfError);
  const models = useViewerStore((s) => s.models);

  // BCF hook for camera/snapshot integration
  const { createViewpointFromState, applyViewpoint, zoomToTopic, canZoomToTopic } = useBCF();

  // Local state
  const [statusFilter, setStatusFilter] = useState('all');
  const [showCreateForm, setShowCreateForm] = useState(false);
  const [showAuthorDialog, setShowAuthorDialog] = useState(false);
  const [tempAuthor, setTempAuthor] = useState(bcfAuthor);

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
      return `BCF_Issues_${date}`;
    }
    // Use first model's name (without extension) + "_Issues"
    const firstModel = models.values().next().value;
    if (firstModel?.name) {
      const baseName = firstModel.name.replace(/\.(ifc|ifczip)$/i, '');
      return `${baseName}_Issues`;
    }
    return `BCF_Issues_${new Date().toISOString().split('T')[0]}`;
  }, [models]);

  // Initialize project if needed
  const ensureProject = useCallback(() => {
    if (!bcfProject) {
      setBcfProject(createBCFProject({ name: getDefaultProjectName() }));
    }
  }, [bcfProject, setBcfProject, getDefaultProjectName]);

  // Import BCF file
  const handleImportFile = useCallback(async (file: File | null | undefined) => {
    if (!file) return;

    try {
      setBcfLoading(true);
      setBcfError(null);
      const project = await readBCF(file);
      setBcfProject(project);
    } catch (error) {
      console.error('Failed to import BCF:', error);
      setBcfError(error instanceof Error ? error.message : 'Failed to import BCF file');
    } finally {
      setBcfLoading(false);
      if (fileInputRef.current) {
        fileInputRef.current.value = '';
      }
    }
  }, [setBcfProject, setBcfLoading, setBcfError]);

  const handleImport = useCallback(async (e: React.ChangeEvent<HTMLInputElement>) => {
    await handleImportFile(e.target.files?.[0]);
  }, [handleImportFile]);

  const importFromDialog = useCallback(async (): Promise<boolean> => {
    const file = await openGenericFileDialog({
      title: 'Import BCF File',
      filters: [
        { name: 'BCF Files', extensions: ['bcfzip', 'bcf'] },
        { name: 'All Files', extensions: ['*'] },
      ],
    });
    if (file) {
      await handleImportFile(file);
      return true;
    }
    return false;
  }, [handleImportFile]);

  const handleImportClick = useCallback(async () => {
    const imported = await importFromDialog();
    if (imported) {
      return;
    }
    fileInputRef.current?.click();
  }, [importFromDialog]);

  // Export BCF file
  const handleExport = useCallback(async () => {
    if (!bcfProject) return;

    try {
      setBcfLoading(true);
      const blob = await writeBCF(bcfProject);
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      // Use project name, or generate from model name, or date-based fallback
      const fileName = bcfProject.name || getDefaultProjectName();
      a.download = `${fileName}.bcfzip`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
    } catch (error) {
      console.error('Failed to export BCF:', error);
      setBcfError(error instanceof Error ? error.message : 'Failed to export BCF file');
    } finally {
      setBcfLoading(false);
    }
  }, [bcfProject, setBcfLoading, setBcfError, getDefaultProjectName]);

  // Create new topic
  const handleCreateTopic = useCallback(
    (data: Partial<BCFTopic>) => {
      ensureProject();
      const topic = createBCFTopic({
        title: data.title || 'Untitled',
        description: data.description,
        author: bcfAuthor,
        topicType: data.topicType,
        topicStatus: 'Open',
        priority: data.priority,
      });
      addTopic(topic);
      setShowCreateForm(false);
    },
    [ensureProject, bcfAuthor, addTopic]
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

  // Capture viewpoint from current viewer state
  const handleCaptureViewpoint = useCallback(async () => {
    if (!activeTopicId) return;

    // Create viewpoint from current camera, section plane, and selection state
    const viewpoint = await createViewpointFromState({
      includeSnapshot: true,
      includeSelection: true,
      includeHidden: true,
    });

    if (viewpoint) {
      addViewpoint(activeTopicId, viewpoint);
    } else {
      console.warn('[BCFPanel] Failed to capture viewpoint - no camera available');
    }
  }, [activeTopicId, addViewpoint, createViewpointFromState]);

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

  useEffect(() => {
    const drainDesktopActions = () => {
      if (claimNextDesktopPanelAction('bcf-import')) {
        void importFromDialog();
      }
      if (claimNextDesktopPanelAction('bcf-export')) {
        void handleExport();
      }
    };

    drainDesktopActions();
    return subscribeDesktopPanelActions(drainDesktopActions);
  }, [handleExport, importFromDialog]);

  return (
    <div className="flex flex-col h-full bg-background">
      {/* Header */}
      <div className="flex items-center justify-between px-3 py-2 border-b border-border">
        <div className="flex items-center gap-2">
          <MessageSquare className="h-4 w-4" />
          <h2 className="font-medium text-sm">BCF Issues</h2>
          {topics.length > 0 && (
            <Badge variant="secondary" className="text-xs">
              {topics.length}
            </Badge>
          )}
        </div>
        <div className="flex items-center gap-1">
          <input
            ref={fileInputRef}
            type="file"
            accept=".bcf,.bcfzip"
            onChange={handleImport}
            className="hidden"
          />
          <Button
            variant="ghost"
            size="icon"
            className="h-7 w-7"
            onClick={() => { void handleImportClick(); }}
            title="Import BCF"
          >
            <Upload className="h-4 w-4" />
          </Button>
          <Button
            variant="ghost"
            size="icon"
            className="h-7 w-7"
            onClick={handleExport}
            disabled={!bcfProject || topics.length === 0}
            title="Export BCF"
          >
            <Download className="h-4 w-4" />
          </Button>
          <Button
            variant={bcfOverlayVisible ? 'secondary' : 'ghost'}
            size="icon"
            className="h-7 w-7"
            onClick={toggleBcfOverlay}
            title={bcfOverlayVisible ? 'Hide 3D markers' : 'Show 3D markers'}
          >
            <MapPin className="h-4 w-4" />
          </Button>
          <Button
            variant="ghost"
            size="icon"
            className="h-7 w-7"
            onClick={() => {
              setTempAuthor(bcfAuthor);
              setShowAuthorDialog(true);
            }}
            title="Set author"
          >
            <User className="h-4 w-4" />
          </Button>
          <Button variant="ghost" size="icon" className="h-7 w-7" onClick={onClose}>
            <X className="h-4 w-4" />
          </Button>
        </div>
      </div>

      {/* Content */}
      <div className="flex-1 overflow-hidden relative">
        {showCreateForm ? (
          <BCFCreateTopicForm
            onSubmit={handleCreateTopic}
            onCancel={() => setShowCreateForm(false)}
            author={bcfAuthor}
          />
        ) : activeTopic ? (
          <BCFTopicDetail
            topic={activeTopic}
            onBack={() => setActiveTopic(null)}
            onAddComment={handleAddComment}
            onAddViewpoint={handleCaptureViewpoint}
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
              <h4 className="font-medium mb-3">Set Author Email</h4>
              <Input
                value={tempAuthor}
                onChange={(e) => setTempAuthor(e.target.value)}
                placeholder="your@email.com"
                className="mb-4"
              />
              <div className="flex gap-2 justify-end">
                <Button variant="outline" size="sm" onClick={() => setShowAuthorDialog(false)}>
                  Cancel
                </Button>
                <Button size="sm" onClick={handleSaveAuthor}>
                  Save
                </Button>
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
