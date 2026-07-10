/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { useState, useCallback, useEffect } from 'react';
import type {
  FileSourceProvider,
  PluginContext,
  SourceProject,
  SourceContainer,
  SourceFile,
} from '@ifc-lite/plugin-api';
import { Button } from '@/components/ui/button';
import {
  ChevronLeft,
  Folder,
  FileBox,
  Download,
  Loader2,
  AlertCircle,
} from 'lucide-react';

interface SourceBrowserProps {
  provider: FileSourceProvider;
  ctx: PluginContext;
  onDownload: (files: SourceFile[]) => void;
  onBack: () => void;
}

type BrowseStep =
  | { kind: 'projects' }
  | { kind: 'containers'; projectId: string; projectName: string }
  | { kind: 'files'; projectId: string; containerId: string; containerName: string };

export function SourceBrowser({ provider, ctx, onDownload, onBack }: SourceBrowserProps) {
  const [step, setStep] = useState<BrowseStep>({ kind: 'projects' });
  const [projects, setProjects] = useState<SourceProject[]>([]);
  const [containers, setContainers] = useState<SourceContainer[]>([]);
  const [files, setFiles] = useState<SourceFile[]>([]);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async (fn: () => Promise<void>) => {
    setLoading(true);
    setError(null);
    try {
      await fn();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (step.kind === 'projects') {
      load(async () => {
        setProjects(await provider.listProjects(ctx));
      });
    }
  }, [step.kind, provider, ctx, load]);

  const openProject = useCallback(
    (p: SourceProject) => {
      setStep({ kind: 'containers', projectId: p.id, projectName: p.name });
      load(async () => {
        setContainers(await provider.listContainers(ctx, p.id));
      });
    },
    [provider, ctx, load],
  );

  const openContainer = useCallback(
    (c: SourceContainer, projectId: string) => {
      setStep({ kind: 'files', projectId, containerId: c.id, containerName: c.name });
      setSelected(new Set());
      load(async () => {
        setFiles(
          await provider.listFiles(ctx, c.id, {
            namePatterns: ['*.ifc', '*.ifcx', '*.ifc5'],
          }),
        );
      });
    },
    [provider, ctx, load],
  );

  const toggleSelect = useCallback((fileId: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(fileId)) next.delete(fileId);
      else next.add(fileId);
      return next;
    });
  }, []);

  const handleLoad = useCallback(() => {
    const toLoad = files.filter((f) => selected.has(f.id));
    if (toLoad.length > 0) onDownload(toLoad);
  }, [files, selected, onDownload]);

  const goBack = useCallback(() => {
    if (step.kind === 'files') {
      setStep({ kind: 'containers', projectId: step.projectId, projectName: '' });
      load(async () => {
        setContainers(await provider.listContainers(ctx, step.projectId));
      });
    } else if (step.kind === 'containers') {
      setStep({ kind: 'projects' });
    } else {
      onBack();
    }
  }, [step, provider, ctx, load, onBack]);

  return (
    <div className="flex h-full flex-col">
      <div className="flex items-center gap-2 border-b px-3 py-2">
        <Button variant="ghost" size="icon" className="h-7 w-7" onClick={goBack}>
          <ChevronLeft className="h-4 w-4" />
        </Button>
        <span className="text-sm font-medium">
          {step.kind === 'projects' && provider.manifest.title}
          {step.kind === 'containers' && step.projectName}
          {step.kind === 'files' && step.containerName}
        </span>
      </div>

      <div className="flex-1 overflow-y-auto">
        {loading && (
          <div className="flex items-center justify-center py-8">
            <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
          </div>
        )}

        {error && (
          <div className="flex items-center gap-2 px-3 py-4 text-sm text-red-600 dark:text-red-400">
            <AlertCircle className="h-4 w-4 shrink-0" />
            <span>{error}</span>
          </div>
        )}

        {!loading && !error && step.kind === 'projects' && (
          <ul className="divide-y">
            {projects.map((p) => (
              <li key={p.id}>
                <button
                  className="flex w-full items-center gap-2 px-3 py-2 text-left text-sm hover:bg-accent"
                  onClick={() => openProject(p)}
                >
                  <Folder className="h-4 w-4 text-muted-foreground" />
                  <span className="truncate">{p.name}</span>
                </button>
              </li>
            ))}
            {projects.length === 0 && (
              <li className="px-3 py-4 text-center text-sm text-muted-foreground">
                No projects found
              </li>
            )}
          </ul>
        )}

        {!loading && !error && step.kind === 'containers' && (
          <ul className="divide-y">
            {containers.map((c) => (
              <li key={c.id}>
                <button
                  className="flex w-full items-center gap-2 px-3 py-2 text-left text-sm hover:bg-accent"
                  onClick={() => openContainer(c, step.projectId)}
                >
                  <Folder className="h-4 w-4 text-muted-foreground" />
                  <span className="truncate">{c.name}</span>
                </button>
              </li>
            ))}
            {containers.length === 0 && (
              <li className="px-3 py-4 text-center text-sm text-muted-foreground">
                No file areas found
              </li>
            )}
          </ul>
        )}

        {!loading && !error && step.kind === 'files' && (
          <ul className="divide-y">
            {files.map((f) => (
              <li key={f.id}>
                <button
                  className="flex w-full items-center gap-2 px-3 py-2 text-left text-sm hover:bg-accent"
                  onClick={() => toggleSelect(f.id)}
                >
                  <input
                    type="checkbox"
                    className="pointer-events-none"
                    checked={selected.has(f.id)}
                    readOnly
                  />
                  <FileBox className="h-4 w-4 text-muted-foreground" />
                  <span className="truncate flex-1">{f.name}</span>
                  {f.sizeBytes != null && (
                    <span className="text-xs text-muted-foreground">
                      {formatBytes(f.sizeBytes)}
                    </span>
                  )}
                </button>
              </li>
            ))}
            {files.length === 0 && (
              <li className="px-3 py-4 text-center text-sm text-muted-foreground">
                No IFC files found
              </li>
            )}
          </ul>
        )}
      </div>

      {step.kind === 'files' && selected.size > 0 && (
        <div className="border-t px-3 py-2">
          <Button className="w-full" onClick={handleLoad}>
            <Download className="mr-2 h-4 w-4" />
            Load {selected.size} file{selected.size > 1 ? 's' : ''}
          </Button>
        </div>
      )}
    </div>
  );
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
