/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * BCF server connection dialog: sign in to a BCF API (OpenCDE) server (a
 * known public one or a custom URL, via password grant, pasted access
 * token, or client credentials — see BCFServerConnectForm), pick a
 * project, and pull its topics into the BCF panel. Read path only — topics
 * load into the same in-memory `BCFProject` the file import uses, so the
 * whole existing BCF UI works on server data unchanged.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { CheckCircle2, CloudDownload, Loader2, LogOut, XCircle } from 'lucide-react';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { toast } from '@/components/ui/toast';
import { useViewerStore } from '@/store';
import { posthog } from '@/lib/analytics';
import type { BcfProjectDto, BcfSyncProgress } from '@ifc-lite/bcf-api';
import {
  clearBcfServerConfig,
  listBcfServerProjects,
  loadBcfServerConfig,
  pullBcfServerProject,
  subscribeBcfServer,
  type BcfServerConfig,
} from '@/services/bcf-server';
import { BCFServerConnectForm } from './BCFServerConnectForm';

interface BCFServerDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

export function BCFServerDialog({ open, onOpenChange }: BCFServerDialogProps) {
  const setBcfProject = useViewerStore((s) => s.setBcfProject);
  const setBcfAuthor = useViewerStore((s) => s.setBcfAuthor);
  const setBcfError = useViewerStore((s) => s.setBcfError);

  const [config, setConfig] = useState<BcfServerConfig | null>(null);
  const [initialServerUrl, setInitialServerUrl] = useState('');
  const [initialUsername, setInitialUsername] = useState('');
  const [projects, setProjects] = useState<BcfProjectDto[] | null>(null);
  const [selectedProjectId, setSelectedProjectId] = useState('');
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState<BcfSyncProgress | null>(null);
  const [error, setError] = useState<string | null>(null);
  // Number of local topics the next pull would replace; non-null means the
  // user must confirm before we overwrite them (they may be unexported).
  const [replaceCount, setReplaceCount] = useState<number | null>(null);

  // A project-list or topic-pull request can outlive the connection it was
  // issued for (disconnect, or another tab signing in mid-flight). Results
  // carrying a stale generation are dropped so they can never pair the new
  // connection with the old account's data.
  const sessionGenerationRef = useRef(0);
  const loadProjects = useCallback(async () => {
    const generation = ++sessionGenerationRef.current;
    try {
      const list = await listBcfServerProjects();
      if (generation !== sessionGenerationRef.current) return;
      setProjects(list);
      setSelectedProjectId((current) => {
        if (current && list.some((p) => p.project_id === current)) return current;
        return list[0]?.project_id ?? '';
      });
    } catch (err) {
      if (generation !== sessionGenerationRef.current) return;
      setProjects([]);
      setError(err instanceof Error ? err.message : String(err));
    }
  }, []);

  const configRef = useRef(config);
  configRef.current = config;

  const applySavedConnection = useCallback((saved: BcfServerConfig | null) => {
    const previous = configRef.current;
    const identityChanged =
      !saved ||
      !previous ||
      previous.serverUrl !== saved.serverUrl ||
      previous.userId !== saved.userId ||
      previous.clientId !== saved.clientId;
    setConfig(saved);
    if (!identityChanged) return;
    sessionGenerationRef.current += 1;
    setProjects(null);
    setSelectedProjectId(saved?.projectId ?? '');
    setError(null);
    setProgress(null);
    setReplaceCount(null);
    setBusy(false);
    if (saved) void loadProjects();
  }, [loadProjects]);

  // Re-seed from the saved connection only on the closed -> open transition,
  // so parent re-renders never wipe in-progress typing.
  const wasOpenRef = useRef(false);
  useEffect(() => {
    if (open && !wasOpenRef.current) {
      const saved = loadBcfServerConfig();
      setConfig(saved);
      setInitialServerUrl(saved?.serverUrl ?? '');
      setInitialUsername(saved?.userId ?? '');
      setProjects(null);
      setSelectedProjectId(saved?.projectId ?? '');
      setError(null);
      setProgress(null);
      setReplaceCount(null);
      if (saved) void loadProjects();
    }
    wasOpenRef.current = open;
  }, [open, loadProjects]);

  useEffect(() => {
    if (!open) return;
    return subscribeBcfServer(() => {
      applySavedConnection(loadBcfServerConfig());
    });
  }, [open, applySavedConnection]);

  const handleSignedIn = useCallback(
    (next: BcfServerConfig) => {
      setConfig(next);
      setError(null);
      // Adopt the server identity as the BCF author only when it is
      // email-shaped — some servers return an opaque id here, and topics
      // authored under a GUID read as nobody in every other BCF tool.
      if (next.userId.includes('@')) setBcfAuthor(next.userId);
      void loadProjects();
    },
    [setBcfAuthor, loadProjects],
  );

  const handleDisconnect = useCallback(() => {
    sessionGenerationRef.current += 1;
    clearBcfServerConfig();
    setConfig(null);
    setProjects(null);
    setSelectedProjectId('');
    setError(null);
    setBusy(false);
  }, []);

  const handlePull = useCallback(async () => {
    const project = projects?.find((p) => p.project_id === selectedProjectId);
    if (!project) return;
    // Loading replaces the panel's project wholesale; local topics may be
    // unexported work, so overwriting them needs an explicit second click.
    const localTopics = useViewerStore.getState().bcfProject?.topics.size ?? 0;
    if (localTopics > 0 && replaceCount === null) {
      setReplaceCount(localTopics);
      return;
    }
    const generation = sessionGenerationRef.current;
    setReplaceCount(null);
    setBusy(true);
    setError(null);
    setBcfError(null);
    try {
      const result = await pullBcfServerProject(
        project.project_id,
        project.name ?? 'BCF project',
        (progress) => {
          if (generation !== sessionGenerationRef.current) return;
          setProgress(progress);
        },
      );
      if (generation !== sessionGenerationRef.current) return;
      setBcfProject(result.project);
      posthog.capture('bcf_server_synced', {
        topic_count: result.project.topics.size,
        warning_count: result.warnings.length,
      });
      if (result.warnings.length > 0) {
        console.warn('[bcf-server] sync warnings:', result.warnings);
        toast.info(
          `Loaded ${result.project.topics.size} topics (${result.warnings.length} items skipped — see console)`,
        );
      } else {
        toast.success(`Loaded ${result.project.topics.size} topics from the BCF server`);
      }
      onOpenChange(false);
    } catch (err) {
      if (generation !== sessionGenerationRef.current) return;
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      if (generation === sessionGenerationRef.current) {
        setBusy(false);
        setProgress(null);
      }
    }
  }, [projects, selectedProjectId, replaceCount, setBcfProject, setBcfError, onOpenChange]);

  const connected = config !== null;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>BCF Server</DialogTitle>
        </DialogHeader>

        {/* DialogContent is a grid; without min-w-0 this grid item sizes to
            the banner's nowrap min-content width and overflows the dialog
            instead of letting the span truncate. */}
        <div className="flex min-w-0 flex-col gap-4 py-2">
          {!connected ? (
            <BCFServerConnectForm
              initialServerUrl={initialServerUrl}
              initialUsername={initialUsername}
              onSignedIn={handleSignedIn}
            />
          ) : (
            <>
              <div className="flex min-w-0 items-center gap-2 rounded-md bg-green-500/10 px-3 py-2 text-sm text-green-700 dark:text-green-400">
                <CheckCircle2 className="h-4 w-4 shrink-0" />
                <span
                  className="min-w-0 truncate"
                  title={`Signed in as ${config.userId} · ${config.serverUrl}`}
                >
                  Signed in as {config.userId} · {config.serverUrl}
                </span>
              </div>
              <div className="flex flex-col gap-1.5">
                <Label id="bcf-server-project-label">Project</Label>
                {projects === null ? (
                  <div className="flex items-center gap-2 text-sm text-muted-foreground">
                    <Loader2 className="h-4 w-4 animate-spin" />
                    Loading projects…
                  </div>
                ) : projects.length === 0 ? (
                  <p className="text-sm text-muted-foreground">No projects available.</p>
                ) : (
                  <Select
                    value={selectedProjectId === '' ? undefined : selectedProjectId}
                    onValueChange={(value) => {
                      setSelectedProjectId(value);
                      setReplaceCount(null);
                    }}
                  >
                    <SelectTrigger aria-labelledby="bcf-server-project-label">
                      <SelectValue placeholder="Select a project…" />
                    </SelectTrigger>
                    <SelectContent>
                      {projects.map((project) => (
                        <SelectItem key={project.project_id} value={project.project_id}>
                          {project.name ?? project.project_id}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                )}
              </div>
              {progress && (
                <p className="text-xs text-muted-foreground" role="status">
                  {progress.phase === 'topics'
                    ? `Fetching topics… ${progress.loaded}`
                    : `Loading topic details… ${progress.loaded}${progress.total ? ` / ${progress.total}` : ''}`}
                </p>
              )}
              {replaceCount !== null && (
                <div className="rounded-md bg-amber-500/10 px-3 py-2 text-sm text-amber-700 dark:text-amber-400">
                  Loading will replace the {replaceCount} topic{replaceCount === 1 ? '' : 's'}{' '}
                  currently in the BCF panel. Export them first if they are not saved anywhere.
                </div>
              )}
              {error && (
                <div className="flex items-center gap-2 rounded-md bg-red-500/10 px-3 py-2 text-sm text-red-700 dark:text-red-400">
                  <XCircle className="h-4 w-4 shrink-0" />
                  <span className="min-w-0 break-words">{error}</span>
                </div>
              )}
            </>
          )}
        </div>

        {connected && (
          <DialogFooter className="gap-2 sm:gap-0">
            <Button
              variant="ghost"
              className="mr-auto text-destructive hover:text-destructive"
              onClick={handleDisconnect}
              disabled={busy}
            >
              <LogOut className="mr-2 h-4 w-4" />
              Disconnect
            </Button>
            <Button
              onClick={() => void handlePull()}
              disabled={busy || projects === null || !selectedProjectId}
            >
              {busy ? (
                <Loader2 className="mr-2 h-4 w-4 animate-spin" />
              ) : (
                <CloudDownload className="mr-2 h-4 w-4" />
              )}
              {replaceCount !== null ? 'Replace and load' : 'Load topics'}
            </Button>
          </DialogFooter>
        )}
      </DialogContent>
    </Dialog>
  );
}
