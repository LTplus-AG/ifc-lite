/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import type { AppearancePdfControls, AppearancePdfPasswordPrompt } from './pdf-controls.js';
import type { AppearanceScope, AppearanceDraftSettings, AppearanceSourceOption } from '@/lib/appearance/draft-types.js';
export type { AppearanceScope, AppearanceDraftSettings, AppearanceSourceOption } from '@/lib/appearance/draft-types.js';
export interface AppearancePanelViewProps {
  /** Advertise PDF upload only once a controller provides document ingestion. */
  allowPdf?: boolean;
  pdf?: AppearancePdfControls;
  pdfPassword?: AppearancePdfPasswordPrompt;
  models: ReadonlyArray<{ id: string; name: string }>;
  modelId: string | null;
  onModelChange(id: string): void;
  sources: readonly AppearanceSourceOption[];
  sourceId: string | null;
  onSourceChange(id: string): void;
  onRemoveSource?(id: string): void;
  onUpload(file: File): void;
  sourceBusy?: boolean;
  sourceHelp?: string;
  scope: AppearanceScope;
  onScopeChange(scope: AppearanceScope): void;
  classes: ReadonlyArray<{ value: string; label: string }>;
  types: ReadonlyArray<{ id: number; name: string }>;
  selectionCount: number;
  affectedCount: number;
  excludedCount: number;
  exclusions?: readonly string[];
  onUseSupported?(): void;
  settings: AppearanceDraftSettings;
  onSettingsChange(patch: Partial<AppearanceDraftSettings>): void;
  status: 'idle' | 'preparing' | 'ready' | 'applying' | 'stale' | 'error';
  statusMessage?: string;
  unavailableReason?: string;
  canApply: boolean;
  canDiscard: boolean;
  hasPreview: boolean;
  showingOriginal: boolean;
  onCompareChange(original: boolean): void;
  onApply(): void;
  onDiscard(): void;
}
