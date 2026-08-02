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
 *
 * The size guard, clobber decision, and toast wording below are pulled out
 * as pure functions (`exceedsImportSizeLimit`, `shouldConfirmClobber`,
 * `describeImportOutcome`) so they can be pinned by unit tests without
 * rendering the hook — FileReader/DOM event plumbing is not worth mocking
 * just to exercise decision logic that doesn't touch either.
 */

import { useCallback, useRef, useState } from 'react';
import { useViewerStore } from '@/store';
import { resolveScheduleSourceModelId } from '@/store/slices/schedule-edit-helpers';
import type { useIfc } from '@/hooks/useIfc';
import { toast } from '@/components/ui/toast';
import { sanitizeFilename } from '@/lib/export/download.js';
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

/** Whether `fileSizeBytes` is over the import limit — pulled out for testing. */
export function exceedsImportSizeLimit(fileSizeBytes: number, maxBytes: number = MAX_IMPORT_FILE_BYTES): boolean {
  return fileSizeBytes > maxBytes;
}

/** User-facing message for a file rejected by {@link exceedsImportSizeLimit}. */
export function formatSizeLimitError(fileName: string, fileSizeBytes: number, maxBytes: number = MAX_IMPORT_FILE_BYTES): string {
  const mb = (fileSizeBytes / (1024 * 1024)).toFixed(1);
  return `"${fileName}" is ${mb} MB, over the ${maxBytes / (1024 * 1024)} MB import limit.`;
}

/**
 * The browser hands `File#name` back verbatim -- control characters, RTL
 * override characters, or an implausibly long OS filename can all end up in
 * it. Every user-facing surface this hook writes to (toasts, the console
 * warning group, the clobber-confirm banner) goes through this first, via
 * the same `sanitizeFilename` every other "Save/Import as ..." path in the
 * app already uses (`@/lib/export/download.ts`). Pulled out as a one-line
 * pure function so the sanitisation itself is pinned by a unit test without
 * rendering the hook, matching the module doc comment's stated pattern.
 */
export function sanitizeImportFileName(fileName: string): string {
  return sanitizeFilename(fileName, { fallback: 'schedule', maxLength: 120 });
}

/**
 * Whether an import should be staged behind a clobber confirmation rather
 * than applied immediately: true whenever the schedule currently in the
 * panel carries real work — hand edits, or tasks read from the model
 * itself (`expressId > 0`) — that a straight replace would discard.
 */
export function shouldConfirmClobber(
  scheduleData: { tasks: { expressId: number }[] } | null,
  scheduleIsEdited: boolean,
): boolean {
  return !!scheduleData && scheduleData.tasks.length > 0
    && (scheduleIsEdited || scheduleData.tasks.some(t => t.expressId > 0));
}

export interface ImportOutcome {
  /** Which toast variant to show. */
  kind: 'success' | 'warning';
  /** Full toast message (already includes the warning-count preview, if any). */
  message: string;
}

/**
 * Build the post-import toast wording. Separated from the actual `toast.*`
 * call (and from the always-logged full warning list, which stays in the
 * hook — console grouping isn't worth pulling into a pure function) so the
 * two outcomes — clean import vs. import-with-warnings — are each pinned by
 * a direct assertion on the returned string instead of a mocked toast.
 */
export function describeImportOutcome(result: ScheduleImportResult, fileName: string): ImportOutcome {
  const taskWord = result.taskCount === 1 ? 'task' : 'tasks';
  const seqWord = result.sequenceCount === 1 ? 'dependency' : 'dependencies';
  const summary =
    `Imported ${result.taskCount} ${taskWord}, ${result.sequenceCount} ${seqWord} from "${fileName}". ` +
    'Tasks are not linked to IFC elements yet — assign them manually or with a script.';
  if (result.warnings.length === 0) return { kind: 'success', message: summary };
  const preview = result.warnings.slice(0, 2).map(w => w.message).join(' ');
  return {
    kind: 'warning',
    message: `${summary} ${result.warnings.length} warning${result.warnings.length === 1 ? '' : 's'}: ${preview}`,
  };
}

export function useScheduleFileImport(models: IfcModels, activeModelId: string | null) {
  const commitGeneratedSchedule = useViewerStore(s => s.commitGeneratedSchedule);
  const importFileInputRef = useRef<HTMLInputElement>(null);

  // A schedule import that would clobber real work is staged here until the
  // user confirms (see `applyScheduleImport` / the caller's confirm banner).
  const [pendingImport, setPendingImport] = useState<PendingScheduleImport | null>(null);

  // Monotonic token guarding against the stale-read race: FileReader is
  // async, so if the user picks a second file before the first one's
  // onload fires, a slow first read landing AFTER the fast second one
  // would silently clobber it. Each file selection bumps the token before
  // starting the read; onload checks it's still current before acting.
  const importSeqRef = useRef(0);

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

    const outcome = describeImportOutcome(result, fileName);
    if (outcome.kind === 'warning') {
      // Don't swallow warnings — lead with the count, then the first
      // couple of messages so the user knows what to check. The full list
      // always goes to the console (same grouped-log pattern
      // GenerateScheduleDialog uses for its own debug dump) so nothing is
      // lost to the short toast preview.
      toast.info(outcome.message);
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
      toast.success(outcome.message);
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

      // Starting a new selection retires whatever confirmation banner is
      // currently showing: `importSeqRef` below only guards the async FILE
      // READ against a stale result landing late, but `pendingImport` is
      // otherwise untouched by a fresh pick. Without this, picking file A
      // (triggering the clobber-confirm banner), then picking file B before
      // answering it, would bump the seq and parse B correctly, but confirm
      // would still apply A's stale `pendingImport` — the exact file the
      // user just replaced their selection with. Clearing it here, before
      // any read starts, makes a new pick unconditionally retire the old
      // banner regardless of how the read that follows resolves.
      setPendingImport(null);

      // See sanitizeImportFileName's doc comment. The real, unsanitized
      // `file.name` still goes to `importScheduleFromText` below -- format
      // sniffing and the deterministic GlobalId seed are meant to key off
      // the actual file, not the display name.
      const displayFileName = sanitizeImportFileName(file.name);

      // Plain size guard ahead of parsing — not a defense against XXE/
      // billion-laughs (the browser DOM parser isn't vulnerable that way),
      // just a UX/perf backstop against a pathologically large drop.
      if (exceedsImportSizeLimit(file.size)) {
        toast.error(formatSizeLimitError(displayFileName, file.size));
        return;
      }

      const seq = ++importSeqRef.current;

      const reader = new FileReader();
      reader.onload = () => {
        // Stale read: a later file selection has already bumped the token
        // past this read's. Whatever this read produces is no longer what
        // the user picked — silently ignore it rather than racing the
        // newer selection's result.
        if (seq !== importSeqRef.current) return;

        // Read as bytes (not readAsText) so a UTF-16 BOM can be sniffed:
        // readAsText assumes UTF-8, so Excel's UTF-16LE "Unicode Text"
        // export "succeeds" but silently decodes into NUL-byte-laced
        // garbage.
        if (!(reader.result instanceof ArrayBuffer)) {
          toast.error(`Could not read "${displayFileName}".`);
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
          toast.error(`Could not import "${displayFileName}": ${message}`);
          return;
        }

        if (shouldConfirmClobber(scheduleData, scheduleIsEdited)) {
          setPendingImport({ result, fileName: displayFileName });
          return;
        }
        applyScheduleImport(result, displayFileName);
      };
      reader.onerror = () => {
        if (seq !== importSeqRef.current) return;
        toast.error(`Could not read "${displayFileName}".`);
      };
      reader.readAsArrayBuffer(file);
    },
    [applyScheduleImport],
  );

  return { importFileInputRef, pendingImport, handleImportFileChange, confirmPendingImport, cancelPendingImport };
}
