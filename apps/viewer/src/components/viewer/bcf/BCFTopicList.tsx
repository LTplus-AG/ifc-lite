/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * BCFTopicList - Topic list with filtering and sorting for the BCF panel.
 */

import React, { useCallback, useState, useMemo } from 'react';
import {
  Plus,
  MessageSquare,
  Camera,
  Filter,
  Edit2,
  User,
  Calendar,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { tourAnchor, TOUR_ANCHORS } from '@/lib/tours/anchors';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { ScrollArea } from '@/components/ui/scroll-area';
import type { BCFTopic } from '@ifc-lite/bcf';
import { StatusBadge, PriorityBadge, formatDate, TOPIC_STATUSES } from './bcfHelpers';

// ============================================================================
// Types
// ============================================================================

export interface BCFTopicListProps {
  topics: BCFTopic[];
  onSelectTopic: (topicId: string) => void;
  onCreateTopic: () => void;
  statusFilter: string;
  onStatusFilterChange: (status: string) => void;
  author: string;
  onSetAuthor: (author: string) => void;
}

// ============================================================================
// Component
// ============================================================================

export function BCFTopicList({
  topics,
  onSelectTopic,
  onCreateTopic,
  statusFilter,
  onStatusFilterChange,
  author,
  onSetAuthor,
}: BCFTopicListProps) {
  const [editingEmail, setEditingEmail] = useState(false);
  const [emailInput, setEmailInput] = useState(author);
  const isDefaultEmail = author === 'user@example.com';

  const handleSaveEmail = useCallback(() => {
    if (emailInput.trim() && emailInput.includes('@')) {
      onSetAuthor(emailInput.trim());
      setEditingEmail(false);
    }
  }, [emailInput, onSetAuthor]);
  const filteredTopics = useMemo(() => {
    if (!statusFilter || statusFilter === 'all') return topics;
    return topics.filter(
      (t) => t.topicStatus?.toLowerCase() === statusFilter.toLowerCase()
    );
  }, [topics, statusFilter]);

  // Sort by creation date (newest first)
  const sortedTopics = useMemo(() => {
    return [...filteredTopics].sort(
      (a, b) => new Date(b.creationDate).getTime() - new Date(a.creationDate).getTime()
    );
  }, [filteredTopics]);

  return (
    <div className="flex flex-col h-full">
      {/* Filter */}
      <div className="flex items-center gap-2 px-3 py-2 border-b border-border">
        <Filter className="h-4 w-4 text-muted-foreground" />
        <Select value={statusFilter} onValueChange={onStatusFilterChange}>
          <SelectTrigger className="h-8 flex-1">
            <SelectValue placeholder="All statuses" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All statuses</SelectItem>
            {TOPIC_STATUSES.map((status) => (
              <SelectItem key={status} value={status.toLowerCase()}>
                {status}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Button size="sm" variant="outline" onClick={onCreateTopic} {...tourAnchor(TOUR_ANCHORS.bcfNewTopic)}>
          <Plus className="h-4 w-4" />
        </Button>
      </div>

      {/* Topic List */}
      <ScrollArea className="flex-1">
        {sortedTopics.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-8 px-4 text-muted-foreground text-sm">
            <MessageSquare className="h-8 w-8 mb-2 opacity-50" />
            <p>No topics</p>
            <Button
              variant="link"
              size="sm"
              onClick={onCreateTopic}
              className="mt-1"
            >
              Create first topic
            </Button>

            {/* Email setup nudge */}
            <div className="mt-6 w-full max-w-xs">
              <div className="border border-border rounded-lg p-3 bg-muted/30">
                {editingEmail ? (
                  <div className="space-y-2">
                    <Label className="text-xs text-muted-foreground">Your email for BCF authorship</Label>
                    <Input
                      value={emailInput}
                      onChange={(e) => setEmailInput(e.target.value)}
                      placeholder="your@email.com"
                      className="h-8 text-sm"
                      onKeyDown={(e) => {
                        if (e.key === 'Enter') handleSaveEmail();
                        if (e.key === 'Escape') setEditingEmail(false);
                      }}
                      autoFocus
                    />
                    <div className="flex gap-2 justify-end">
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={() => {
                          setEmailInput(author);
                          setEditingEmail(false);
                        }}
                        className="h-7 text-xs"
                      >
                        Cancel
                      </Button>
                      <Button
                        size="sm"
                        onClick={handleSaveEmail}
                        disabled={!emailInput.trim() || !emailInput.includes('@')}
                        className="h-7 text-xs"
                      >
                        Save
                      </Button>
                    </div>
                  </div>
                ) : (
                  <div className="flex items-center justify-between gap-2">
                    <div className="flex-1 min-w-0">
                      <p className="text-xs text-muted-foreground mb-0.5">Author</p>
                      <p className={`text-sm truncate ${isDefaultEmail ? 'text-amber-600 dark:text-amber-400' : 'text-foreground'}`}>
                        {author}
                      </p>
                    </div>
                    <Button
                      variant={isDefaultEmail ? 'default' : 'ghost'}
                      size="sm"
                      onClick={() => {
                        setEmailInput(author);
                        setEditingEmail(true);
                      }}
                      className="h-7 text-xs shrink-0"
                    >
                      {isDefaultEmail ? 'Set email' : <Edit2 className="h-3 w-3" />}
                    </Button>
                  </div>
                )}
              </div>
              {isDefaultEmail && !editingEmail && (
                <p className="text-xs text-muted-foreground mt-2 text-center">
                  Set your email to identify your issues and comments
                </p>
              )}
            </div>
          </div>
        ) : (
          <div className="divide-y divide-border">
            {sortedTopics.map((topic) => (
              <button
                key={topic.guid}
                onClick={() => onSelectTopic(topic.guid)}
                className="w-full text-left p-3 hover:bg-accent/50 transition-colors"
              >
                <div className="flex items-start justify-between gap-2 mb-1">
                  <h4 className="font-medium text-sm line-clamp-1 flex-1">
                    {topic.title}
                  </h4>
                  <StatusBadge status={topic.topicStatus} />
                </div>
                {topic.description && (
                  <p className="text-xs text-muted-foreground line-clamp-2 mb-2">
                    {topic.description}
                  </p>
                )}
                <div className="flex items-center gap-2 text-xs text-muted-foreground">
                  <PriorityBadge priority={topic.priority} />
                  <span className="flex items-center gap-1">
                    <User className="h-3 w-3" />
                    {topic.creationAuthor.split('@')[0]}
                  </span>
                  <span className="flex items-center gap-1">
                    <Calendar className="h-3 w-3" />
                    {formatDate(topic.creationDate)}
                  </span>
                  {topic.comments.length > 0 && (
                    <span className="flex items-center gap-1">
                      <MessageSquare className="h-3 w-3" />
                      {topic.comments.length}
                    </span>
                  )}
                  {topic.viewpoints.length > 0 && (
                    <span className="flex items-center gap-1">
                      <Camera className="h-3 w-3" />
                      {topic.viewpoints.length}
                    </span>
                  )}
                </div>
              </button>
            ))}
          </div>
        )}
      </ScrollArea>
    </div>
  );
}
