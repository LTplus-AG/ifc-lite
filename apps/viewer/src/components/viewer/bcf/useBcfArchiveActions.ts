/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The BCF panel's archive I/O: import a .bcf/.bcfzip through the hidden file
 * input and export the current project. Extracted from BCFPanel (module size).
 *
 * C-2: Import lets the latest picked file win (an earlier, slower read is
 * discarded); Export writes one archive per press burst.
 */

import { useCallback, useRef, type ChangeEvent } from 'react';
import { writeBCF, type BCFProject } from '@ifc-lite/bcf';
import { useViewerStore } from '@/store';
import { useTranslation } from '@/i18n';
import { posthog, trackExportCompleted } from '@/lib/analytics';
import { bcfExportFilename, sanitizeFilename } from '@/lib/export/download';
import { publishBcfArchive } from '@/lib/bcf-drafts/archive-activity';
import { useSingleFlight } from '@/hooks/useSingleFlight';
import { readBCFWithDiagnostics, warnIfNoModelLoaded, warnIfImportTruncated, warnIfUnsupportedVersion } from './bcfImportGuidance';

export function useBcfArchiveActions(bcfProject: BCFProject | null, getDefaultProjectName: () => string) {
  const { t } = useTranslation();
  const fileInputRef = useRef<HTMLInputElement>(null);
  const setBcfProject = useViewerStore((s) => s.setBcfProject);
  const setBcfLoading = useViewerStore((s) => s.setBcfLoading);
  const setBcfError = useViewerStore((s) => s.setBcfError);
  const importFlight = useSingleFlight();
  const exportFlight = useSingleFlight();

  // Import BCF file
  const releaseImport = importFlight.release;
  const runImport = importFlight.run;
  const handleImportFile = useCallback(async (file: File | null | undefined) => {
    if (!file) return;
    if (fileInputRef.current) fileInputRef.current.value = '';
    releaseImport();
    await runImport(async (isCurrent) => {
      try {
        setBcfLoading(true);
        setBcfError(null);
        const { project, readWarningCount, versionWarning } = await readBCFWithDiagnostics(file);
        if (!isCurrent()) return;
        setBcfProject(project);
        warnIfNoModelLoaded(useViewerStore.getState().models.size);
        warnIfImportTruncated(readWarningCount);
        warnIfUnsupportedVersion(versionWarning);
      } catch (error) {
        console.error('Failed to import BCF:', error);
        if (isCurrent()) setBcfError(error instanceof Error ? error.message : t('bcf.panel.importError'));
      } finally {
        if (isCurrent()) setBcfLoading(false);
      }
    });
  }, [releaseImport, runImport, setBcfProject, setBcfLoading, setBcfError]);

  const handleImport = useCallback(async (e: ChangeEvent<HTMLInputElement>) => {
    await handleImportFile(e.target.files?.[0]);
  }, [handleImportFile]);

  // Safari only opens a file picker from inside the user's click, so the
  // click opens the hidden input directly, with no await before it (#8802).
  const handleImportClick = useCallback(() => {
    fileInputRef.current?.click();
  }, []);

  // Export BCF file
  const runExport = exportFlight.run;
  const handleExport = useCallback(async () => {
    if (!bcfProject) return;
    await runExport(async () => {
      try {
        setBcfLoading(true);
        setBcfError(null);
        const fileName = sanitizeFilename(bcfProject.name || getDefaultProjectName(), { fallback: 'topics' });
        await publishBcfArchive(bcfProject.name?.trim() || fileName, bcfExportFilename(fileName), () => writeBCF(bcfProject));
        trackExportCompleted({ format: 'bcfzip', surface: 'bcf_panel', topic_count: bcfProject.topics.size });
        posthog.capture('bcf_exported', { topic_count: bcfProject.topics.size });
      } catch (error) {
        console.error('Failed to export BCF:', error);
        setBcfError(error instanceof Error ? error.message : t('bcf.panel.exportError'));
      } finally {
        setBcfLoading(false);
      }
    });
  }, [runExport, bcfProject, setBcfLoading, setBcfError, getDefaultProjectName]);

  return { fileInputRef, handleImport, handleImportClick, handleExport, exporting: exportFlight.busy };
}
