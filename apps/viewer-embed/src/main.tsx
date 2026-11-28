/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Embed viewer entry point.
 *
 * Minimal entry that mounts the EmbedViewer component with no additional chrome.
 */

import React from 'react';
import ReactDOM from 'react-dom/client';
import { TooltipProvider } from '@/components/ui/tooltip';
import { EmbedViewer } from './components/EmbedViewer';
import { ErrorBoundary } from './components/ErrorBoundary';
import '@/index.css';
import { applyRuntimeConfig } from '@/lib/features/runtime-start';

// The same runtime start as the viewer, with every feature on except analytics:
// the embed runs inside third-party pages, which show no IFClite privacy
// notice, so it sends no product analytics and injects no page-view script.
applyRuntimeConfig({ version: 1, features: { default: 'all', disable: ['privacy.analytics', 'privacy.vercel-analytics'] } });

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <ErrorBoundary>
      <TooltipProvider delayDuration={300}>
        <EmbedViewer />
      </TooltipProvider>
    </ErrorBoundary>
  </React.StrictMode>
);
