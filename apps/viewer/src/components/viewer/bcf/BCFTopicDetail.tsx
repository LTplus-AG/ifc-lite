/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * BCFTopicDetail - Topic detail view with comments, viewpoints, and editing.
 */

import React, { useCallback, useState, useMemo } from 'react';
import {
  X,
  MessageSquare,
  Camera,
  ChevronLeft,
  Send,
  Trash2,
  User,
  MousePointer2,
  Focus,
  EyeOff,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Badge } from '@/components/ui/badge';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Separator } from '@/components/ui/separator';
import type { BCFTopic, BCFViewpoint } from '@ifc-lite/bcf';
import { PriorityBadge, formatDate, formatDateTime, TOPIC_STATUSES } from './bcfHelpers';

// ============================================================================
// Types
// ============================================================================

export interface BCFTopicDetailProps {
  topic: BCFTopic;
  onBack: () => void;
  onAddComment: (text: string, viewpointGuid?: string) => void;
  onAddViewpoint: () => void;
  onActivateViewpoint: (viewpoint: BCFViewpoint) => void;
  onDeleteViewpoint: (viewpointGuid: string) => void;
  onUpdateStatus: (status: string) => void;
  onDeleteTopic: () => void;
  // Viewer state info for capture feedback
  selectionCount: number;
  hasIsolation: boolean;
  hasHiddenEntities: boolean;
}

// ============================================================================
// Component
// ============================================================================

export function BCFTopicDetail({
  topic,
  onBack,
  onAddComment,
  onAddViewpoint,
  onActivateViewpoint,
  onDeleteViewpoint,
  onUpdateStatus,
  onDeleteTopic,
  selectionCount,
  hasIsolation,
  hasHiddenEntities,
}: BCFTopicDetailProps) {
  const [commentText, setCommentText] = useState('');
  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false);
  const [selectedViewpointGuid, setSelectedViewpointGuid] = useState<string | null>(null);

  // Get the selected viewpoint for display
  const selectedViewpoint = useMemo(() => {
    if (!selectedViewpointGuid) return null;
    return topic.viewpoints.find(vp => vp.guid === selectedViewpointGuid) || null;
  }, [selectedViewpointGuid, topic.viewpoints]);

  const handleSubmitComment = useCallback(() => {
    if (commentText.trim()) {
      // Associate comment with selected viewpoint if one is selected
      onAddComment(commentText.trim(), selectedViewpointGuid || undefined);
      setCommentText('');
      setSelectedViewpointGuid(null); // Clear selection after commenting
    }
  }, [commentText, onAddComment, selectedViewpointGuid]);

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        handleSubmitComment();
      }
    },
    [handleSubmitComment]
  );

  return (
    <div className="flex flex-col h-full relative">
      {/* Header */}
      <div className="flex items-center gap-2 px-3 py-2 border-b border-border">
        <Button variant="ghost" size="sm" onClick={onBack}>
          <ChevronLeft className="h-4 w-4" />
        </Button>
        <h3 className="font-medium text-sm flex-1 truncate">{topic.title}</h3>
        <Button
          variant="ghost"
          size="sm"
          onClick={() => setShowDeleteConfirm(true)}
          className="text-destructive hover:text-destructive"
        >
          <Trash2 className="h-4 w-4" />
        </Button>
      </div>

      <ScrollArea className="flex-1">
        <div className="p-3 space-y-4">
          {/* Topic Info */}
          <div className="space-y-2">
            <div className="flex items-center gap-2 flex-wrap">
              <Select value={topic.topicStatus || 'Open'} onValueChange={onUpdateStatus}>
                <SelectTrigger className="h-7 w-auto">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {TOPIC_STATUSES.map((status) => (
                    <SelectItem key={status} value={status}>
                      {status}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <PriorityBadge priority={topic.priority} />
              {topic.topicType && (
                <Badge variant="outline" className="text-xs">
                  {topic.topicType}
                </Badge>
              )}
            </div>

            {topic.description && (
              <p className="text-sm text-muted-foreground">{topic.description}</p>
            )}

            <div className="text-xs text-muted-foreground space-y-1">
              <p>
                Created by {topic.creationAuthor} on{' '}
                {formatDateTime(topic.creationDate)}
              </p>
              {topic.assignedTo && <p>Assigned to: {topic.assignedTo}</p>}
              {topic.dueDate && <p>Due: {formatDate(topic.dueDate)}</p>}
            </div>
          </div>

          <Separator />

          {/* Viewpoints */}
          <div>
            <div className="flex items-center justify-between mb-2">
              <h4 className="text-sm font-medium">Viewpoints</h4>
              <Button variant="outline" size="sm" onClick={onAddViewpoint}>
                <Camera className="h-3 w-3 mr-1" />
                Capture
              </Button>
            </div>

            {/* Capture info - what will be included */}
            {(selectionCount > 0 || hasIsolation || hasHiddenEntities) && (
              <div className="mb-2 p-2 bg-muted/50 rounded-md text-xs text-muted-foreground">
                <p className="font-medium mb-1">Capture will include:</p>
                <ul className="space-y-0.5">
                  {selectionCount > 0 && (
                    <li className="flex items-center gap-1">
                      <MousePointer2 className="h-3 w-3" />
                      {selectionCount} selected {selectionCount === 1 ? 'object' : 'objects'}
                    </li>
                  )}
                  {hasIsolation && (
                    <li className="flex items-center gap-1">
                      <Focus className="h-3 w-3" />
                      Isolated objects (others hidden)
                    </li>
                  )}
                  {hasHiddenEntities && !hasIsolation && (
                    <li className="flex items-center gap-1">
                      <EyeOff className="h-3 w-3" />
                      Hidden objects
                    </li>
                  )}
                </ul>
              </div>
            )}

            {topic.viewpoints.length === 0 ? (
              <p className="text-xs text-muted-foreground">No viewpoints captured</p>
            ) : (
              <div className="space-y-2">
                {topic.viewpoints.map((vp) => {
                  const isSelected = selectedViewpointGuid === vp.guid;
                  const commentCount = topic.comments.filter(c => c.viewpointGuid === vp.guid).length;
                  return (
                    <div
                      key={vp.guid}
                      className={`rounded-md overflow-hidden border-2 transition-colors ${
                        isSelected ? 'border-primary bg-primary/5' : 'border-border'
                      }`}
                    >
                      {/* Snapshot */}
                      <div className="relative group">
                        {vp.snapshot ? (
                          <img
                            src={vp.snapshot}
                            alt="Viewpoint"
                            className="w-full object-contain cursor-pointer hover:opacity-90 transition-opacity"
                            onClick={() => onActivateViewpoint(vp)}
                          />
                        ) : (
                          <div
                            className="w-full aspect-video bg-muted flex items-center justify-center cursor-pointer hover:bg-muted/80 transition-colors min-h-[120px]"
                            onClick={() => onActivateViewpoint(vp)}
                          >
                            <Camera className="h-6 w-6 text-muted-foreground" />
                          </div>
                        )}
                        {/* Delete button - hover only */}
                        <Button
                          variant="destructive"
                          size="icon"
                          className="absolute top-1 right-1 h-6 w-6 opacity-0 group-hover:opacity-100 transition-opacity"
                          onClick={(e) => {
                            e.stopPropagation();
                            onDeleteViewpoint(vp.guid);
                          }}
                        >
                          <Trash2 className="h-3 w-3" />
                        </Button>
                      </div>
                      {/* Action bar - always visible */}
                      <div className="flex items-center justify-between px-2 py-1.5 bg-muted/30">
                        <Button
                          variant={isSelected ? 'default' : 'ghost'}
                          size="sm"
                          className="h-7 text-xs gap-1"
                          onClick={() => setSelectedViewpointGuid(isSelected ? null : vp.guid)}
                        >
                          <MessageSquare className="h-3 w-3" />
                          {commentCount > 0 ? `${commentCount} comment${commentCount > 1 ? 's' : ''}` : 'Comment'}
                        </Button>
                        <Button
                          variant="ghost"
                          size="sm"
                          className="h-7 text-xs"
                          onClick={() => onActivateViewpoint(vp)}
                        >
                          Go to view
                        </Button>
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </div>

          <Separator />

          {/* Comments */}
          <div>
            <h4 className="text-sm font-medium mb-2">
              Comments ({topic.comments.length})
            </h4>

            <div className="space-y-3">
              {topic.comments.map((comment) => {
                // Find associated viewpoint if any
                const associatedViewpoint = comment.viewpointGuid
                  ? topic.viewpoints.find(vp => vp.guid === comment.viewpointGuid)
                  : null;
                return (
                  <div
                    key={comment.guid}
                    className="bg-muted/50 rounded-md p-2 text-sm"
                  >
                    {/* Show associated viewpoint thumbnail if present */}
                    {associatedViewpoint?.snapshot && (
                      <div
                        className="mb-2 rounded overflow-hidden border border-border cursor-pointer hover:opacity-80 transition-opacity"
                        onClick={() => onActivateViewpoint(associatedViewpoint)}
                      >
                        <img
                          src={associatedViewpoint.snapshot}
                          alt="Associated viewpoint"
                          className="w-full max-h-24 object-contain bg-muted"
                        />
                      </div>
                    )}
                    <div className="flex items-center gap-2 mb-1 text-xs text-muted-foreground">
                      <User className="h-3 w-3" />
                      <span>{comment.author.split('@')[0]}</span>
                      <span>-</span>
                      <span>{formatDateTime(comment.date)}</span>
                      {comment.viewpointGuid && (
                        <span className="flex items-center gap-0.5">
                          <Camera className="h-3 w-3" />
                        </span>
                      )}
                    </div>
                    <p className="whitespace-pre-wrap">{comment.comment}</p>
                  </div>
                );
              })}
            </div>
          </div>
        </div>
      </ScrollArea>

      {/* Comment Input */}
      <div className="border-t border-border p-3">
        {/* Show selected viewpoint indicator */}
        {selectedViewpoint && (
          <div className="flex items-center gap-2 mb-2 p-2 bg-primary/10 rounded-md">
            {selectedViewpoint.snapshot && (
              <img
                src={selectedViewpoint.snapshot}
                alt="Selected viewpoint"
                className="w-12 h-10 object-contain rounded bg-muted"
              />
            )}
            <div className="flex-1 min-w-0">
              <p className="text-xs text-muted-foreground">Commenting on viewpoint</p>
            </div>
            <Button
              variant="ghost"
              size="icon"
              className="h-6 w-6 shrink-0"
              onClick={() => setSelectedViewpointGuid(null)}
            >
              <X className="h-3 w-3" />
            </Button>
          </div>
        )}
        <div className="flex gap-2">
          <Input
            placeholder={selectedViewpoint ? "Add comment on viewpoint..." : "Add a comment..."}
            value={commentText}
            onChange={(e) => setCommentText(e.target.value)}
            onKeyDown={handleKeyDown}
            className="flex-1"
          />
          <Button size="icon" onClick={handleSubmitComment} disabled={!commentText.trim()}>
            <Send className="h-4 w-4" />
          </Button>
        </div>
      </div>

      {/* Delete Confirmation */}
      {showDeleteConfirm && (
        <div className="absolute inset-0 bg-background/90 flex items-center justify-center p-4">
          <div className="bg-card border rounded-lg p-4 max-w-xs">
            <h4 className="font-medium mb-2">Delete Topic?</h4>
            <p className="text-sm text-muted-foreground mb-4">
              This will permanently delete this topic and all its comments and viewpoints.
            </p>
            <div className="flex gap-2 justify-end">
              <Button variant="outline" size="sm" onClick={() => setShowDeleteConfirm(false)}>
                Cancel
              </Button>
              <Button
                variant="destructive"
                size="sm"
                onClick={() => {
                  onDeleteTopic();
                  setShowDeleteConfirm(false);
                }}
              >
                Delete
              </Button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
