/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * BCFCreateTopicForm - New topic creation form for the BCF panel.
 */

import React, { useCallback, useState } from 'react';
import { X } from 'lucide-react';
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
import { TOPIC_TYPES, PRIORITIES } from './bcfHelpers';

// ============================================================================
// Types
// ============================================================================

export interface BCFCreateTopicFormProps {
  onSubmit: (topic: Partial<BCFTopic>) => void;
  onCancel: () => void;
  author: string;
  /** Pre-fill the title (e.g. when raising an issue from a detected change). */
  initialTitle?: string;
  /** Pre-fill the description. */
  initialDescription?: string;
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
}: BCFCreateTopicFormProps) {
  const [title, setTitle] = useState(initialTitle);
  const [description, setDescription] = useState(initialDescription);
  const [topicType, setTopicType] = useState('Issue');
  const [priority, setPriority] = useState('Medium');

  const handleSubmit = useCallback(
    (e: React.FormEvent) => {
      e.preventDefault();
      if (title.trim()) {
        onSubmit({
          title: title.trim(),
          description: description.trim() || undefined,
          topicType,
          priority,
        });
      }
    },
    [title, description, topicType, priority, onSubmit]
  );

  return (
    <form onSubmit={handleSubmit} className="p-3 space-y-4">
      <div className="flex items-center justify-between mb-2">
        <h3 className="font-medium">New Topic</h3>
        <Button variant="ghost" size="sm" type="button" onClick={onCancel}>
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
      </div>

      <div className="flex gap-2 justify-end pt-2">
        <Button variant="outline" type="button" onClick={onCancel}>
          Cancel
        </Button>
        <Button type="submit" disabled={!title.trim()}>
          Create Topic
        </Button>
      </div>
    </form>
  );
}
