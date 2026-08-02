/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * useScheduleFileImport — GanttPanel's "Import schedule…" file-input handler
 * (issue #1890), split out to keep GanttPanel.tsx under the ~400-line budget
 * (AGENTS.md).
 *
 * Reads an MSPDI/CSV file the user picked, decodes it (sniffing a UTF-16
 * BOM), parses it via `importScheduleFromText`, and commits the result
 * through the same `commitGeneratedSchedule` path "Generate schedule" uses.
 *
 * Importing REPLACES the schedule currently in memory and wipes undo/redo
 * history unconditionally, so a clobber confirmation is staged here
 * (`pendingImport`) whenever there is real work to lose — hand-edited
 * changes, or tasks read from the model itself (`expressId > 0`). A fresh or
 * purely-generated-but-untouched schedule is replaced without asking.
 */

import { useCallback, useRef, useState } from 'react';
import { useViewerStore } from '@/store';
import { resolveScheduleSourceModelId } from '@/store/slices/schedule-edit-helpers';
import type { useIfc } from '@/hooks/useIfc';
import { toast } from '@/components/ui/toast';
import { importScheduleFromText, type ScheduleImportResult } from './import/index.js';
import { decodeScheduleFileBytes } from './import/decode-text.js';

type IfcModels = ReturnType<typeof useIfc>['models'];

// A schedule import (CSV or MSPDI XML) is plain text; 20 MB comfortably
// covers even a large multi-thousand-task MSPDI export (which is verbose —
// one XML element per field) while still catching a pathological file
// before it's handed to the DOM parser / row-by-row CSV scan.
const MAX_IMPORT_FILE_BYTES = 20 * 1024 * 1024;

export interface PendingScheduleImport {
  result: ScheduleImportResult;
  fileName: string;
}

export function useScheduleFileImport(models: IfcModels, activeModelId: string | null) {
  const commitGeneratedSchedule = useViewerStore(s => s.commitGeneratedSchedule);
  const importFileInputRef = useRef<HTMLInputElement>(null);

  // A schedule import that would clobber real work is staged here until the
  // user confirms (see `applyScheduleImport` / the caller's confirm banner).
  const [pendingImport, setPendingImport] = useState<PendingScheduleImport | null>(null);

  const applyScheduleImport = useCallback((result: ScheduleImportResult, fileName: string) => {
    // Same commit path GenerateScheduleDialog uses: attribute the
    // schedule to the active model (or '__legacy__' for single-model
    // sessions with no explicit active id) and let the store's dirty
    // tracking take it from there.
    const sourceModelId = resolveScheduleSourceModelId(models, activeModelId, '__legacy__');
    commitGeneratedSchedule(result.extraction, sourceModelId);
    // Deliberately NOT calling setAnimationEnabled(true) here: the 4D
    // animator paints per bound IFC product, and an imported schedule binds
    // no products (see import/build.ts's module doc comment) — enabling it
    // would be a guaranteed no-op.

    const taskWord = result.taskCount === 1 ? 'task' : 'tasks';
    const seqWord = result.sequenceCount === 1 ? 'dependency' : 'dependencies';
    const summary =
      `Imported ${result.taskCount} ${taskWord}, ${result.sequenceCount} ${seqWord} from "${fileName}". ` +
      'Tasks are not linked to IFC elements yet — assign them manually or with a script.';
    if (result.warnings.length > 0) {
      // Don't swallow warnings — lead with the count, then the first
      // couple of messages so the user knows what to check. The full list
      // always goes to the console (same grouped-log pattern
      // GenerateScheduleDialog uses for its own debug dump) so nothing is
      // lost to the short toast preview.
      const preview = result.warnings.slice(0, 2).map(w => w.message).join(' ');
      toast.info(`${summary} ${result.warnings.length} warning${result.warnings.length === 1 ? '' : 's'}: ${preview}`);
      try {
        /* eslint-disable no-console */
        console.groupCollapsed(
          `%c[Schedule import] ${result.warnings.length} warning(s) from "${fileName}"`,
          'color:#e0a72e;font-weight:bold',
        );
        for (const w of result.warnings) {
          console.warn(`[${w.code}]${w.line !== undefined ? ` line ${w.line}:` : ''} ${w.message}`);
        }
        console.groupEnd();
        /* eslint-enable no-console */
      } catch (err) {
        // eslint-disable-next-line no-console
        console.warn('[Schedule import] Warning log failed (non-fatal):', err);
      }
    } else {
      toast.success(summary);
    }
  }, [models, activeModelId, commitGeneratedSchedule]);

  const confirmPendingImport = useCallback(() => {
    if (!pendingImport) return;
    applyScheduleImport(pendingImport.result, pendingImport.fileName);
    setPendingImport(null);
  }, [pendingImport, applyScheduleImport]);

  const cancelPendingImport = useCallback(() => setPendingImport(null), []);

  const handleImportFileChange = useCallback(
    (
      e: React.ChangeEvent<HTMLInputElement>,
      scheduleData: { tasks: { expressId: number }[] } | null,
      scheduleIsEdited: boolean,
    ) => {
      const file = e.target.files?.[0];
      e.target.value = '';
      if (!file) return;

      // Plain size guard ahead of parsing — not a defense against XXE/
      // billion-laughs (the browser DOM parser isn't vulnerable that way),
      // just a UX/perf backstop against a pathologically large drop.
      if (file.size > MAX_IMPORT_FILE_BYTES) {
        const mb = (file.size / (1024 * 1024)).toFixed(1);
        toast.error(`"${file.name}" is ${mb} MB, over the ${MAX_IMPORT_FILE_BYTES / (1024 * 1024)} MB import limit.`);
        return;
      }

      const reader = new FileReader();
      reader.onload = () => {
        // Read as bytes (not readAsText) so a UTF-16 BOM can be sniffed:
        // readAsText assumes UTF-8, so Excel's UTF-16LE "Unicode Text"
        // export "succeeds" but silently decodes into NUL-byte-laced
        // garbage.
        if (!(reader.result instanceof ArrayBuffer)) {
          toast.error(`Could not read "${file.name}".`);
          return;
        }
        const text = decodeScheduleFileBytes(reader.result);
        let result: ScheduleImportResult;
        try {
          result = importScheduleFromText(file.name, text);
        } catch (err) {
          // Parser errors are written to be user-facing (see
          // import/mspdi.ts, import/csv.ts) — surface the message unchanged
          // rather than a generic "import failed".
          const message = err instanceof Error ? err.message : String(err);
          toast.error(`Could not import "${file.name}": ${message}`);
          return;
        }

        const hasValuableSchedule = !!scheduleData && scheduleData.tasks.length > 0
          && (scheduleIsEdited || scheduleData.tasks.some(t => t.expressId > 0));
        if (hasValuableSchedule) {
          setPendingImport({ result, fileName: file.name });
          return;
        }
        applyScheduleImport(result, file.name);
      };
      reader.onerror = () => {
        toast.error(`Could not read "${file.name}".`);
      };
      reader.readAsArrayBuffer(file);
    },
    [applyScheduleImport],
  );

  return { importFileInputRef, pendingImport, handleImportFileChange, confirmPendingImport, cancelPendingImport };
}
