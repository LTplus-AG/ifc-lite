/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * BCFCreateTopicForm - Topic create/edit form for the BCF panel.
 *
 * Exposes the full BCF topic field set (type, status, priority, assignee, due
 * date, labels) plus an optional viewpoint snapshot preview. The snapshot
 * section only appears when the parent wires snapshot capture (`onCaptureSnapshot`),
 * since the image comes from the live WebGPU canvas the parent owns.
 *
 * Reused for editing: pass `initialTopic` to seed every field from an existing
 * topic and set `heading`/`submitLabel` to relabel the form (#1461).
 */

import React, { useCallback, useState } from 'react';
import { X, Camera, RefreshCw, Loader2, ImageOff } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import type { BCFTopic } from '@ifc-lite/bcf';
import { TOPIC_TYPES, TOPIC_STATUSES, PRIORITIES } from './bcfHelpers';

// ============================================================================
// Types
// ============================================================================

export interface BCFCreateTopicFormProps {
  onSubmit: (topic: Partial<BCFTopic>, options?: { includeSnapshot: boolean }) => void;
  onCancel: () => void;
  author: string;
  /** Pre-fill the title (e.g. when raising an issue from a detected change). */
  initialTitle?: string;
  /** Pre-fill the description. */
  initialDescription?: string;
  /**
   * Seed every field from an existing topic to edit it in place (#1461). Takes
   * precedence over `initialTitle`/`initialDescription`. Pair with `heading`
   * and `submitLabel` to relabel the form for editing.
   */
  initialTopic?: BCFTopic | null;
  /** Heading shown at the top of the form (default "New Topic"). */
  heading?: string;
  /** Submit button label (default "Create Topic"). */
  submitLabel?: string;
  /**
   * Snapshot preview as a data URL. When this OR `onCaptureSnapshot` is provided
   * the form shows a viewpoint-snapshot section with an "attach" toggle.
   */
  snapshot?: string | null;
  /** (Re)capture the viewpoint snapshot from the current view. */
  onCaptureSnapshot?: () => void;
  /** True while a snapshot capture is in flight (shows a spinner, disables recapture). */
  capturingSnapshot?: boolean;
}

// ============================================================================
// Component
// ============================================================================

export function BCFCreateTopicForm({
  onSubmit,
  onCancel,
  author: _author,
  initialTitle = '',
  initialDescription = '',
  initialTopic = null,
  heading = 'New Topic',
  submitLabel = 'Create Topic',
  snapshot,
  onCaptureSnapshot,
  capturingSnapshot = false,
}: BCFCreateTopicFormProps) {
  // Keep the original ISO due date so an edit that doesn't touch the date can
  // round-trip it intact (the date input only sees YYYY-MM-DD). (#1461)
  const initialDueDate = initialTopic?.dueDate;
  const [title, setTitle] = useState(initialTopic?.title ?? initialTitle);
  const [description, setDescription] = useState(initialTopic?.description ?? initialDescription);
  const [topicType, setTopicType] = useState(initialTopic?.topicType ?? 'Issue');
  const [topicStatus, setTopicStatus] = useState(initialTopic?.topicStatus ?? 'Open');
  const [priority, setPriority] = useState(initialTopic?.priority ?? 'Medium');
  const [assignedTo, setAssignedTo] = useState(initialTopic?.assignedTo ?? '');
  // `<input type="date">` wants a bare YYYY-MM-DD; topics may carry a full ISO timestamp.
  const [dueDate, setDueDate] = useState((initialDueDate ?? '').split('T')[0]);
  const [labels, setLabels] = useState((initialTopic?.labels ?? []).join(', '));
  const [includeSnapshot, setIncludeSnapshot] = useState(true);

  // Snapshot is offered only when the parent can capture it from the canvas.
  const snapshotCapable = Boolean(onCaptureSnapshot);

  const handleSubmit = useCallback(
    (e: React.FormEvent) => {
      e.preventDefault();
      if (!title.trim()) return;
      const parsedLabels = labels
        .split(',')
        .map((l) => l.trim())
        .filter(Boolean);
      onSubmit(
        {
          title: title.trim(),
          description: description.trim() || undefined,
          topicType,
          topicStatus,
          priority,
          assignedTo: assignedTo.trim() || undefined,
          // Round-trip the original ISO timestamp when the date is unchanged, so
          // editing another field doesn't drop an imported topic's time/offset.
          dueDate:
            dueDate && initialDueDate && dueDate === initialDueDate.split('T')[0]
              ? initialDueDate
              : dueDate || undefined,
          labels: parsedLabels.length ? parsedLabels : undefined,
        },
        { includeSnapshot: snapshotCapable && includeSnapshot },
      );
    },
    [title, description, topicType, topicStatus, priority, assignedTo, dueDate, labels, includeSnapshot, snapshotCapable, initialDueDate, onSubmit],
  );

  return (
    <form onSubmit={handleSubmit} className="p-3 space-y-4">
      <div className="flex items-center justify-between">
        <h3 className="font-medium">{heading}</h3>
        <Button variant="ghost" size="sm" type="button" aria-label="Close" onClick={onCancel}>
          <X className="h-4 w-4" />
        </Button>
      </div>

      <div className="space-y-2">
        <Label htmlFor="title">Title *</Label>
        <Input
          id="title"
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          placeholder="Brief description of the issue"
          required
        />
      </div>

      <div className="space-y-2">
        <Label htmlFor="description">Description</Label>
        <textarea
          id="description"
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          placeholder="Detailed description (optional)"
          className="w-full min-h-[80px] px-3 py-2 text-sm rounded-md border border-input bg-background"
        />
      </div>

      {/* Viewpoint snapshot — only when the parent provides canvas capture. */}
      {snapshotCapable && (
        <div className="space-y-2">
          <div className="flex items-center justify-between">
            <Label className="flex items-center gap-1.5 cursor-pointer select-none">
              <input
                type="checkbox"
                checked={includeSnapshot}
                onChange={(e) => setIncludeSnapshot(e.target.checked)}
              />
              <Camera className="h-3.5 w-3.5" />
              Attach snapshot
            </Label>
            {includeSnapshot && (
              <Button
                variant="ghost"
                size="sm"
                type="button"
                className="h-7 px-2 text-xs gap-1.5"
                onClick={onCaptureSnapshot}
                disabled={capturingSnapshot}
              >
                {capturingSnapshot ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <RefreshCw className="h-3.5 w-3.5" />}
                Recapture
              </Button>
            )}
          </div>
          {includeSnapshot && (
            <div className="rounded-md border border-border overflow-hidden bg-muted/40 aspect-video flex items-center justify-center">
              {capturingSnapshot && !snapshot ? (
                <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
              ) : snapshot ? (
                <img src={snapshot} alt="Viewpoint snapshot" className="w-full h-full object-contain" />
              ) : (
                <div className="flex flex-col items-center gap-1 text-muted-foreground text-xs">
                  <ImageOff className="h-5 w-5" />
                  No snapshot captured
                </div>
              )}
            </div>
          )}
        </div>
      )}

      <div className="grid grid-cols-2 gap-3">
        <div className="space-y-2">
          <Label>Type</Label>
          <Select value={topicType} onValueChange={setTopicType}>
            <SelectTrigger>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {TOPIC_TYPES.map((type) => (
                <SelectItem key={type} value={type}>
                  {type}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>

        <div className="space-y-2">
          <Label>Status</Label>
          <Select value={topicStatus} onValueChange={setTopicStatus}>
            <SelectTrigger>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {TOPIC_STATUSES.map((s) => (
                <SelectItem key={s} value={s}>
                  {s}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>

        <div className="space-y-2">
          <Label>Priority</Label>
          <Select value={priority} onValueChange={setPriority}>
            <SelectTrigger>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {PRIORITIES.map((p) => (
                <SelectItem key={p} value={p}>
                  {p}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>

        <div className="space-y-2">
          <Label htmlFor="dueDate">Due date</Label>
          <Input id="dueDate" type="date" value={dueDate} onChange={(e) => setDueDate(e.target.value)} />
        </div>
      </div>

      <div className="space-y-2">
        <Label htmlFor="assignedTo">Assignee</Label>
        <Input
          id="assignedTo"
          value={assignedTo}
          onChange={(e) => setAssignedTo(e.target.value)}
          placeholder="name@example.com"
        />
      </div>

      <div className="space-y-2">
        <Label htmlFor="labels">Labels</Label>
        <Input
          id="labels"
          value={labels}
          onChange={(e) => setLabels(e.target.value)}
          placeholder="Comma-separated (e.g. architecture, urgent)"
        />
      </div>

      <div className="flex gap-2 justify-end pt-2">
        <Button variant="outline" type="button" onClick={onCancel}>
          Cancel
        </Button>
        <Button type="submit" disabled={!title.trim()}>
          {submitLabel}
        </Button>
      </div>
    </form>
  );
}
