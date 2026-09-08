/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * BCF (BIM Collaboration Format) state slice
 *
 * Manages BCF topics, comments, and viewpoints.
 */

import type { StateCreator } from 'zustand';
import type {
  BCFProject,
  BCFTopic,
  BCFComment,
  BCFViewpoint,
} from '@ifc-lite/bcf';

// ============================================================================
// Types
// ============================================================================

export interface BCFSliceState {
  /** Current BCF project */
  bcfProject: BCFProject | null;
  /** Currently active topic GUID */
  activeTopicId: string | null;
  /** Currently active viewpoint GUID */
  activeViewpointId: string | null;
  /** BCF panel visibility */
  bcfPanelVisible: boolean;
  /** Loading state */
  bcfLoading: boolean;
  /** Error message */
  bcfError: string | null;
  /** Default author for new topics/comments */
  bcfAuthor: string;
  /** Whether 3D overlay markers are shown in the viewport */
  bcfOverlayVisible: boolean;
}

export interface BCFSlice extends BCFSliceState {
  // Project actions
  setBcfProject: (project: BCFProject | null) => void;
  clearBcfProject: () => void;

  // Topic actions
  setActiveTopic: (topicId: string | null) => void;
  addTopic: (topic: BCFTopic) => void;
  updateTopic: (topicId: string, updates: Partial<BCFTopic>) => void;
  deleteTopic: (topicId: string) => void;

  // Comment actions
  addComment: (topicId: string, comment: BCFComment) => void;
  updateComment: (topicId: string, commentGuid: string, updates: Partial<BCFComment>) => void;
  deleteComment: (topicId: string, commentGuid: string) => void;

  // Viewpoint actions
  setActiveViewpoint: (viewpointId: string | null) => void;
  addViewpoint: (topicId: string, viewpoint: BCFViewpoint) => void;
  updateViewpoint: (topicId: string, viewpointGuid: string, updates: Partial<BCFViewpoint>) => void;
  deleteViewpoint: (topicId: string, viewpointGuid: string) => void;

  // UI actions
  setBcfPanelVisible: (visible: boolean) => void;
  toggleBcfPanel: () => void;
  setBcfLoading: (loading: boolean) => void;
  setBcfError: (error: string | null) => void;
  setBcfAuthor: (author: string) => void;
  setBcfOverlayVisible: (visible: boolean) => void;
  toggleBcfOverlay: () => void;

  // Utility getters
  getActiveTopic: () => BCFTopic | null;
  getActiveViewpoint: () => BCFViewpoint | null;
  getTopics: () => BCFTopic[];
}

// ============================================================================
// Initial State
// ============================================================================

const getDefaultBcfAuthor = (): string => {
  // Try to get from localStorage (may fail in private browsing)
  try {
    if (typeof localStorage !== 'undefined') {
      const stored = localStorage.getItem('bcf-author');
      if (stored) return stored;
    }
  } catch {
    // localStorage not available (private browsing, storage quota, etc.)
  }
  return 'user@example.com';
};

// ============================================================================
// Slice Creator
// ============================================================================

export const createBcfSlice: StateCreator<BCFSlice, [], [], BCFSlice> = (set, get) => ({
  // Initial state
  bcfProject: null,
  activeTopicId: null,
  activeViewpointId: null,
  bcfPanelVisible: false,
  bcfLoading: false,
  bcfError: null,
  bcfAuthor: getDefaultBcfAuthor(),
  bcfOverlayVisible: false,

  // Project actions
  setBcfProject: (bcfProject) => set({
    bcfProject,
    activeTopicId: null,
    activeViewpointId: null,
    bcfError: null,
  }),

  clearBcfProject: () => set({
    bcfProject: null,
    activeTopicId: null,
    activeViewpointId: null,
    bcfError: null,
  }),

  // Topic actions
  setActiveTopic: (activeTopicId) => set({
    activeTopicId,
    activeViewpointId: null, // Reset viewpoint when changing topic
  }),

  addTopic: (topic) => set((state) => {
    if (!state.bcfProject) return state;

    const newTopics = new Map(state.bcfProject.topics);
    newTopics.set(topic.guid, topic);

    return {
      bcfProject: {
        ...state.bcfProject,
        topics: newTopics,
      },
      activeTopicId: topic.guid, // Auto-select new topic
    };
  }),

  updateTopic: (topicId, updates) => set((state) => {
    if (!state.bcfProject) return state;

    const topic = state.bcfProject.topics.get(topicId);
    if (!topic) return state;

    const newTopics = new Map(state.bcfProject.topics);
    newTopics.set(topicId, {
      ...topic,
      ...updates,
      modifiedDate: new Date().toISOString(),
    });

    return {
      bcfProject: {
        ...state.bcfProject,
        topics: newTopics,
      },
    };
  }),

  deleteTopic: (topicId) => set((state) => {
    if (!state.bcfProject) return state;

    const newTopics = new Map(state.bcfProject.topics);
    newTopics.delete(topicId);

    return {
      bcfProject: {
        ...state.bcfProject,
        topics: newTopics,
      },
      // Clear active topic if it was deleted
      activeTopicId: state.activeTopicId === topicId ? null : state.activeTopicId,
      activeViewpointId: state.activeTopicId === topicId ? null : state.activeViewpointId,
    };
  }),

  // Comment actions
  addComment: (topicId, comment) => set((state) => {
    if (!state.bcfProject) return state;

    const topic = state.bcfProject.topics.get(topicId);
    if (!topic) return state;

    const newTopics = new Map(state.bcfProject.topics);
    newTopics.set(topicId, {
      ...topic,
      comments: [...topic.comments, comment],
      modifiedDate: new Date().toISOString(),
    });

    return {
      bcfProject: {
        ...state.bcfProject,
        topics: newTopics,
      },
    };
  }),

  updateComment: (topicId, commentGuid, updates) => set((state) => {
    if (!state.bcfProject) return state;

    const topic = state.bcfProject.topics.get(topicId);
    if (!topic) return state;

    const commentIndex = topic.comments.findIndex((c) => c.guid === commentGuid);
    if (commentIndex === -1) return state;

    const newComments = [...topic.comments];
    newComments[commentIndex] = {
      ...newComments[commentIndex],
      ...updates,
      modifiedDate: new Date().toISOString(),
    };

    const newTopics = new Map(state.bcfProject.topics);
    newTopics.set(topicId, {
      ...topic,
      comments: newComments,
      modifiedDate: new Date().toISOString(),
    });

    return {
      bcfProject: {
        ...state.bcfProject,
        topics: newTopics,
      },
    };
  }),

  deleteComment: (topicId, commentGuid) => set((state) => {
    if (!state.bcfProject) return state;

    const topic = state.bcfProject.topics.get(topicId);
    if (!topic) return state;

    const newTopics = new Map(state.bcfProject.topics);
    newTopics.set(topicId, {
      ...topic,
      comments: topic.comments.filter((c) => c.guid !== commentGuid),
      modifiedDate: new Date().toISOString(),
    });

    return {
      bcfProject: {
        ...state.bcfProject,
        topics: newTopics,
      },
    };
  }),

  // Viewpoint actions
  setActiveViewpoint: (activeViewpointId) => set({ activeViewpointId }),

  addViewpoint: (topicId, viewpoint) => set((state) => {
    if (!state.bcfProject) return state;

    const topic = state.bcfProject.topics.get(topicId);
    if (!topic) return state;

    const newTopics = new Map(state.bcfProject.topics);
    newTopics.set(topicId, {
      ...topic,
      viewpoints: [...topic.viewpoints, viewpoint],
      modifiedDate: new Date().toISOString(),
    });

    return {
      bcfProject: {
        ...state.bcfProject,
        topics: newTopics,
      },
      activeViewpointId: viewpoint.guid, // Auto-select new viewpoint
    };
  }),

  updateViewpoint: (topicId, viewpointGuid, updates) => set((state) => {
    if (!state.bcfProject) return state;

    const topic = state.bcfProject.topics.get(topicId);
    if (!topic) return state;

    const viewpointIndex = topic.viewpoints.findIndex((v) => v.guid === viewpointGuid);
    if (viewpointIndex === -1) return state;

    const newViewpoints = [...topic.viewpoints];
    newViewpoints[viewpointIndex] = {
      ...newViewpoints[viewpointIndex],
      ...updates,
    };

    const newTopics = new Map(state.bcfProject.topics);
    newTopics.set(topicId, {
      ...topic,
      viewpoints: newViewpoints,
      modifiedDate: new Date().toISOString(),
    });

    return {
      bcfProject: {
        ...state.bcfProject,
        topics: newTopics,
      },
    };
  }),

  deleteViewpoint: (topicId, viewpointGuid) => set((state) => {
    if (!state.bcfProject) return state;

    const topic = state.bcfProject.topics.get(topicId);
    if (!topic) return state;

    const newTopics = new Map(state.bcfProject.topics);
    newTopics.set(topicId, {
      ...topic,
      viewpoints: topic.viewpoints.filter((v) => v.guid !== viewpointGuid),
      modifiedDate: new Date().toISOString(),
    });

    return {
      bcfProject: {
        ...state.bcfProject,
        topics: newTopics,
      },
      // Clear active viewpoint if it was deleted
      activeViewpointId: state.activeViewpointId === viewpointGuid ? null : state.activeViewpointId,
    };
  }),

  // UI actions
  setBcfPanelVisible: (bcfPanelVisible) => set({ bcfPanelVisible }),

  toggleBcfPanel: () => set((state) => ({ bcfPanelVisible: !state.bcfPanelVisible })),

  setBcfLoading: (bcfLoading) => set({ bcfLoading }),

  setBcfError: (bcfError) => set({ bcfError }),

  setBcfAuthor: (bcfAuthor) => {
    // Persist to localStorage (may fail in private browsing)
    try {
      if (typeof localStorage !== 'undefined') {
        localStorage.setItem('bcf-author', bcfAuthor);
      }
    } catch {
      // localStorage not available
    }
    set({ bcfAuthor });
  },

  setBcfOverlayVisible: (bcfOverlayVisible) => set({ bcfOverlayVisible }),

  toggleBcfOverlay: () => set((state) => ({ bcfOverlayVisible: !state.bcfOverlayVisible })),

  // Utility getters
  getActiveTopic: () => {
    const state = get();
    if (!state.bcfProject || !state.activeTopicId) return null;
    return state.bcfProject.topics.get(state.activeTopicId) || null;
  },

  getActiveViewpoint: () => {
    const state = get();
    const topic = state.getActiveTopic();
    if (!topic || !state.activeViewpointId) return null;
    return topic.viewpoints.find((v) => v.guid === state.activeViewpointId) || null;
  },

  getTopics: () => {
    const state = get();
    if (!state.bcfProject) return [];
    return Array.from(state.bcfProject.topics.values());
  },
});
