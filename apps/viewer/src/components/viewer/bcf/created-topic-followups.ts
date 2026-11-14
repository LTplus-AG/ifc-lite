/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * What follows a BCF topic create once the topic is committed. The create is
 * done at that point, so nothing here may fail it (the form has closed and a
 * second press must not create the topic again): attaching the viewpoint
 * reports its own failure, and analytics are best-effort.
 */

import type { BCFTopic, BCFViewpoint } from '@ifc-lite/bcf';
import { toast } from '@/components/ui/toast';
import { posthog } from '@/lib/analytics';

export interface CreatedTopicFollowups {
  addViewpoint: (topicGuid: string, viewpoint: BCFViewpoint) => void;
  /** The create still belongs to an open panel; a closed one shows nothing. */
  isCurrent: () => boolean;
  /** The user-facing message for a viewpoint that could not be attached. */
  viewpointFailed: (message: string) => string;
}

export function finishCreatedTopic(topic: BCFTopic, viewpoint: BCFViewpoint | null, followups: CreatedTopicFollowups): void {
  if (viewpoint) {
    try { followups.addViewpoint(topic.guid, viewpoint); }
    catch (error) {
      console.error('[BCFPanel] Adding the viewpoint to the new topic failed', error);
      if (followups.isCurrent()) toast.error(followups.viewpointFailed(error instanceof Error ? error.message : String(error)));
    }
  }
  try {
    posthog.capture('bcf_topic_created', {
      topic_type: topic.topicType,
      priority: topic.priority,
      has_description: Boolean(topic.description),
      has_viewpoint: Boolean(viewpoint),
    });
  } catch (error) { console.warn('[BCFPanel] Analytics for the new topic failed', error); }
}
