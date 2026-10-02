/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Boot half of ../lib/reload-resume.ts: after a stale-deployment reload,
 * reopen the models that were open (from the recent-files blob cache), or tell
 * the user which file to open again when its bytes are not cached.
 */

import { useEffect, useRef } from 'react';
import { toast } from '@/components/ui/toast';
import { useTranslation } from '@/i18n';
import { posthog } from '@/lib/analytics';
import { getCachedFile } from '@/lib/recent-files';
import { setOpenModelsSource, takeResumeIntent } from '@/lib/reload-resume';
import { useViewerStore } from '@/store';

export interface ReloadResumeDeps {
  readCached: (name: string) => Promise<File | null>;
  notify: (text: string, action: { label: string; onClick: () => void }) => void;
}

const defaultDeps: ReloadResumeDeps = {
  readCached: getCachedFile,
  notify: (text, action) => toast.info(text, action),
};

/**
 * Run once, when loading is possible (`ready`). `route` is the viewer's single
 * ingestion router (primary for one file, federation for several);
 * `openPicker` reopens the file dialog for the prompt's action.
 */
export function useReloadResume(
  ready: boolean,
  route: (files: File[]) => void,
  openPicker: () => void,
  deps: ReloadResumeDeps = defaultDeps,
): void {
  const { t } = useTranslation();
  const tRef = useRef(t);
  tRef.current = t;
  const done = useRef(false);
  const routeRef = useRef(route);
  routeRef.current = route;
  const pickerRef = useRef(openPicker);
  pickerRef.current = openPicker;

  useEffect(() => {
    setOpenModelsSource(() => useViewerStore.getState().models.values());
  }, []);

  useEffect(() => {
    if (!ready || done.current) return;
    done.current = true;
    const intent = takeResumeIntent();
    if (!intent) return;
    void (async () => {
      // The cache is keyed by name, so a cached blob is only THIS file when its
      // size matches too; another file of the same name is prompted, not loaded.
      const cached = await Promise.all(intent.files.map(async (entry) => {
        if (!intent.reopen) return null;
        const file = await deps.readCached(entry.name).catch((err: unknown) => {
          console.warn('[reload-resume] could not read a cached model for the resume', err);
          return null;
        });
        return file && file.size === entry.size ? file : null;
      }));
      const files = cached.filter((file): file is File => file !== null);
      const missing = intent.files.filter((_, i) => cached[i] === null);
      if (files.length > 0) routeRef.current(files);
      if (missing.length > 0) {
        const list = missing.map(({ name }) => `"${name}"`).join(', ');
        deps.notify(
          tRef.current('viewerShell.staleDeployment.reopenPrompt', { files: list }),
          { label: tRef.current('viewerShell.staleDeployment.reopenAction'), onClick: () => pickerRef.current() },
        );
      }
      // Counts and a fixed enum only; never the names.
      posthog.capture('stale_reload_resumed', {
        reopened_count: files.length,
        prompted_count: missing.length,
        auto_reopen: intent.reopen,
      });
    })();
  }, [ready, deps]);
}
