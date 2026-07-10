/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Coordinates the "raise a BCF issue from a detected change" flow (#1199),
 * extracted from ComparePanel to keep it under the module-size house rule.
 *
 * Owns the create-form open/created state, captures a viewpoint (camera +
 * snapshot + selection) of the framed element for the form's preview, and
 * creates the topic + attaches the viewpoint on submit.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { useViewerStore } from '@/store';
import { useBCF } from '@/hooks/useBCF';
import { posthog } from '@/lib/analytics';
import { createBCFProject, createBCFTopic, type BCFTopic, type BCFViewpoint } from '@ifc-lite/bcf';

export interface BcfFromChangeController {
  formOpen: boolean;
  setFormOpen: (open: boolean) => void;
  createdTitle: string | null;
  setCreatedTitle: (title: string | null) => void;
  viewpoint: BCFViewpoint | null;
  capturingSnapshot: boolean;
  captureViewpoint: () => Promise<void>;
  submit: (data: Partial<BCFTopic>, options?: { includeSnapshot: boolean }) => Promise<void>;
}

/**
 * @param modelList loaded models, used to name the auto-created BCF project
 * @param selectedKey the focused change — resets the affordance when it changes
 */
export function useBcfFromChange(
  modelList: readonly { name?: string }[],
  selectedKey: string | null,
): BcfFromChangeController {
  const { createViewpointFromState, headerFilesForViewpoints } = useBCF();

  const [formOpen, setFormOpen] = useState(false);
  const [createdTitle, setCreatedTitle] = useState<string | null>(null);
  // Viewpoint (camera + snapshot + selection) previewed in the create form and
  // attached to the topic on submit.
  const [viewpoint, setViewpoint] = useState<BCFViewpoint | null>(null);
  const [capturingSnapshot, setCapturingSnapshot] = useState(false);
  // Guards the non-idempotent BCF create against a double-submit (#1208 review).
  const submitInFlight = useRef(false);

  // Reset the affordance whenever the focused change changes.
  useEffect(() => {
    setFormOpen(false);
    setCreatedTitle(null);
  }, [selectedKey]);

  // Capture the framed element's viewpoint for the form's preview / attachment.
  const captureViewpoint = useCallback(async () => {
    setCapturingSnapshot(true);
    try {
      const vp = await createViewpointFromState({
        includeSnapshot: true,
        includeSelection: true,
        includeHidden: false,
      });
      setViewpoint(vp);
    } catch (err) {
      console.error('[compare] failed to capture viewpoint for BCF', err);
    } finally {
      setCapturingSnapshot(false);
    }
  }, [createViewpointFromState]);

  // Grab a viewpoint when the create form opens (so the snapshot preview is
  // ready); drop it when the form closes.
  useEffect(() => {
    if (formOpen) {
      void captureViewpoint();
    } else {
      setViewpoint(null);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [formOpen]);

  // Create a topic in the BCF project (pre-filled from the change), attach the
  // previewed viewpoint, and stay in the compare view.
  const submit = useCallback(
    async (data: Partial<BCFTopic>, options?: { includeSnapshot: boolean }) => {
      if (submitInFlight.current) return;
      submitInFlight.current = true;
      try {
        const state = useViewerStore.getState();
        if (!state.bcfProject) {
          const first = modelList[0]?.name?.replace(/\.(ifc|ifczip)$/i, '') || 'Comparison';
          state.setBcfProject(createBCFProject({ name: `${first}_Issues` }));
        }
        // Resolve the viewpoint first so the topic's source-file Header can be
        // derived from the models its selection references before it is stored.
        let vp = options?.includeSnapshot === false ? null : viewpoint;
        if (options?.includeSnapshot !== false && !vp) {
          vp = await createViewpointFromState({
            includeSnapshot: true,
            includeSelection: true,
            includeHidden: false,
          });
        }
        const topic = createBCFTopic({
          title: data.title || 'Untitled',
          description: data.description,
          author: state.bcfAuthor,
          topicType: data.topicType,
          topicStatus: data.topicStatus ?? 'Open',
          priority: data.priority,
          assignedTo: data.assignedTo,
          dueDate: data.dueDate,
          labels: data.labels,
        });
        // Record the distinct source model(s) this topic touches (#1591 federation).
        const header = headerFilesForViewpoints(vp ? [vp] : [], topic.creationDate);
        if (header.length > 0) topic.header = header;
        useViewerStore.getState().addTopic(topic);
        if (vp) useViewerStore.getState().addViewpoint(topic.guid, vp);
        posthog.capture('bcf_topic_created', {
          source: 'compare',
          topic_type: topic.topicType,
          priority: topic.priority,
          has_viewpoint: Boolean(vp),
        });
        setFormOpen(false);
        setCreatedTitle(topic.title);
      } catch (error) {
        console.error('[compare] failed to create BCF issue from change', error);
      } finally {
        submitInFlight.current = false;
      }
    },
    [modelList, viewpoint, createViewpointFromState, headerFilesForViewpoints],
  );

  return {
    formOpen,
    setFormOpen,
    createdTitle,
    setCreatedTitle,
    viewpoint,
    capturingSnapshot,
    captureViewpoint,
    submit,
  };
}
