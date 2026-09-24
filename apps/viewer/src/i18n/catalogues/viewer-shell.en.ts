/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The viewer shell's own top-level chrome (#4918 slice 5): the lazy-chunk
 * error boundary's fallback (`ChunkErrorBoundary.tsx`, one of the components
 * root's five literals), the stale-deployment notice
 * (`StaleDeploymentNotice.tsx`) and the shared `ui/dialog.tsx` primitive's
 * screen-reader-only close label.
 */
export const viewerShellEn = {
  'viewerShell.chunkError.loadFailed': '{label} could not be loaded',
  'viewerShell.chunkError.crashed': '{label} stopped working',
  'viewerShell.chunkError.loadFailedDetail': 'This usually means the app was updated while your tab was open.',
  'viewerShell.chunkError.crashedDetail': 'An unexpected error stopped it from rendering.',
  'viewerShell.chunkError.reload': 'Reload',
  'viewerShell.staleDeployment.notice': 'A new version of the viewer is available — reload to continue.',
  'viewerShell.chunkLabel.appearancePanel': 'Appearance panel',
  'viewerShell.chunkLabel.chartsPanel': 'Charts panel',
  'viewerShell.chunkLabel.flowPanel': 'Flow panel',
  'viewerShell.chunkLabel.documentPanel': 'Document panel',
  'viewerShell.chunkLabel.layersPanel': 'Layers panel',
  'viewerShell.chunkLabel.mcpPage': 'MCP page',
  'viewerShell.chunkLabel.mcpPlayground': 'MCP playground',
  'viewerShell.chunkLabel.rteGpuWitness': 'RTE GPU witness',

  'viewerShell.dialog.close': 'Close',
} as const;
