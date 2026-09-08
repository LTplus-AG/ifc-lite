/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Shared constants, helper components, and utility functions for BCF panel components.
 */

import { useMemo } from 'react';
import { AlertCircle, CheckCircle, Clock } from 'lucide-react';
import { Badge } from '@/components/ui/badge';

// ============================================================================
// Constants
// ============================================================================

export const TOPIC_TYPES = ['Issue', 'Request', 'Comment', 'Error', 'Warning', 'Info'];
export const TOPIC_STATUSES = ['Open', 'In Progress', 'Resolved', 'Closed'];
export const PRIORITIES = ['High', 'Medium', 'Low'];

// ============================================================================
// Helper Components
// ============================================================================

export function StatusBadge({ status }: { status?: string }) {
  const variant = useMemo(() => {
    switch (status?.toLowerCase()) {
      case 'open':
        return 'default';
      case 'in progress':
        return 'secondary';
      case 'resolved':
      case 'closed':
        return 'outline';
      default:
        return 'default';
    }
  }, [status]);

  const Icon = useMemo(() => {
    switch (status?.toLowerCase()) {
      case 'open':
        return AlertCircle;
      case 'in progress':
        return Clock;
      case 'resolved':
      case 'closed':
        return CheckCircle;
      default:
        return AlertCircle;
    }
  }, [status]);

  return (
    <Badge variant={variant} className="text-xs gap-1">
      <Icon className="h-3 w-3" />
      {status || 'Open'}
    </Badge>
  );
}

export function PriorityBadge({ priority }: { priority?: string }) {
  const colorClass = useMemo(() => {
    switch (priority?.toLowerCase()) {
      case 'high':
        return 'bg-red-100 text-red-800 dark:bg-red-900 dark:text-red-200';
      case 'medium':
        return 'bg-yellow-100 text-yellow-800 dark:bg-yellow-900 dark:text-yellow-200';
      case 'low':
        return 'bg-green-100 text-green-800 dark:bg-green-900 dark:text-green-200';
      default:
        return '';
    }
  }, [priority]);

  if (!priority) return null;

  return (
    <Badge variant="outline" className={`text-xs ${colorClass}`}>
      {priority}
    </Badge>
  );
}

// ============================================================================
// Date Formatters
// ============================================================================

export function formatDate(isoDate: string | undefined): string {
  if (!isoDate) return '';
  const date = new Date(isoDate);
  if (isNaN(date.getTime())) return isoDate;
  return date.toLocaleDateString(undefined, {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
  });
}

export function formatDateTime(isoDate: string | undefined): string {
  if (!isoDate) return '';
  const date = new Date(isoDate);
  if (isNaN(date.getTime())) return isoDate;
  return date.toLocaleString(undefined, {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}
