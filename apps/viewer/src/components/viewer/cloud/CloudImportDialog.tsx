/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Cloud import dialog — connect a cloud provider (Dropbox, Google Drive, …) and
 * pick an IFC file to load. Selecting a file downloads it directly from the
 * provider to the browser and hands the resulting `File` to the caller via
 * `onPick`, which wires into the existing `loadFile`/`addModel` pipeline.
 *
 * `onPick` is awaited: the caller's routing (`ingestExternalFile`) is async
 * and can genuinely fail after the download succeeds (a bad/unparseable
 * file), so the dialog only reports "Loaded" and closes once the loader has
 * actually finished — not the moment bytes arrive.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import {
  Cloud,
  Folder,
  FileBox,
  ChevronLeft,
  Loader2,
  RefreshCw,
  LogOut,
  Info,
} from 'lucide-react';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { ScrollArea } from '@/components/ui/scroll-area';
import { toast } from '@/components/ui/toast';
import { CloudNotConnectedError } from '@/services/cloud/types';
import type { CloudFileEntry, CloudProvider } from '@/services/cloud/types';

interface CloudImportDialogProps {
  open: boolean;
  onClose: () => void;
  /** Which cloud provider to browse (Dropbox, Google Drive, …). */
  provider: CloudProvider;
  /**
   * Hand the downloaded file to the loader (e.g. `ingestExternalFile`).
   * Awaited before reporting success/closing — see the file doc.
   */
  onPick: (file: File) => Promise<void>;
}

/** A readable breadcrumb step: a display name + the provider path/id to list. */
interface Crumb {
  name: string;
  path: string;
}

const ROOT_CRUMB: Crumb = { name: 'Home', path: '' };

function formatSize(bytes: number): string {
  if (!bytes) return '';
  const units = ['B', 'KB', 'MB', 'GB'];
  let n = bytes;
  let i = 0;
  while (n >= 1024 && i < units.length - 1) {
    n /= 1024;
    i++;
  }
  return `${n.toFixed(n >= 10 || i === 0 ? 0 : 1)} ${units[i]}`;
}

export function CloudImportDialog({ open, onClose, provider, onPick }: CloudImportDialogProps) {
  const [connected, setConnected] = useState(provider.isConnected());
  const [connecting, setConnecting] = useState(false);
  const [trail, setTrail] = useState<Crumb[]>([ROOT_CRUMB]);
  const [entries, setEntries] = useState<CloudFileEntry[]>([]);
  const [listing, setListing] = useState(false);
  const [downloadingId, setDownloadingId] = useState<string | null>(null);
  const [downloadPct, setDownloadPct] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);

  const currentPath = trail[trail.length - 1]?.path ?? '';

  // Guards against out-of-order `listFolder` responses: click a folder, then
  // "Up" before the first resolves, and without this the stale response
  // could overwrite `entries` after the newer (currently-displayed) request
  // already won, desyncing the list from the breadcrumb.
  const requestSeqRef = useRef(0);

  const load = useCallback(
    async (targetPath: string) => {
      const seq = ++requestSeqRef.current;
      setListing(true);
      setError(null);
      try {
        const items = await provider.listFolder(targetPath);
        if (requestSeqRef.current !== seq) return; // superseded by a newer request
        setEntries(items);
        setConnected(true);
      } catch (err) {
        if (requestSeqRef.current !== seq) return;
        if (err instanceof CloudNotConnectedError) {
          setConnected(false);
        } else {
          setError(err instanceof Error ? err.message : 'Failed to list folder');
        }
      } finally {
        if (requestSeqRef.current === seq) setListing(false);
      }
    },
    [provider],
  );

  // Reset to the root whenever the provider changes (e.g. switching tabs).
  useEffect(() => {
    setTrail([ROOT_CRUMB]);
    setEntries([]);
    setError(null);
    setConnected(provider.isConnected());
  }, [provider]);

  // Load the root folder when the dialog opens while already connected.
  useEffect(() => {
    if (open && connected && entries.length === 0 && !listing) {
      void load('');
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, connected, provider]);

  const handleConnect = useCallback(async () => {
    setConnecting(true);
    setError(null);
    try {
      await provider.connect();
      setConnected(true);
      setTrail([ROOT_CRUMB]);
      await load('');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Connection failed');
    } finally {
      setConnecting(false);
    }
  }, [provider, load]);

  const handleDisconnect = useCallback(async () => {
    // Clear local state up front: the user's intent to disconnect is
    // unambiguous and must not stay stuck "connected" behind a request that
    // rejects (network blip, a provider revoke() call throwing, …) — see
    // `provider.disconnect()`'s own contract, which isn't guaranteed to
    // never throw for every provider (e.g. Google's `revoke` call is a
    // real external SDK call).
    setConnected(false);
    setEntries([]);
    setTrail([ROOT_CRUMB]);
    try {
      await provider.disconnect();
    } catch (err) {
      console.warn(`[cloud-import] ${provider.id} disconnect request failed:`, err);
      toast.error(
        err instanceof Error
          ? `Disconnected locally, but: ${err.message}`
          : `${provider.label} disconnect request failed — you're signed out locally.`,
      );
    }
  }, [provider]);

  const enterFolder = useCallback(
    (entry: CloudFileEntry) => {
      setTrail((t) => [...t, { name: entry.name, path: entry.path }]);
      void load(entry.path);
    },
    [load],
  );

  const goUp = useCallback(() => {
    // Compute the next trail from the current value directly rather than
    // inside the `setTrail` updater: React (StrictMode, in dev) may invoke a
    // state updater function twice, and `load()` — which opens the Google
    // Picker for `BrowserGoogleDriveProvider` — must only ever run once per
    // click, not once per updater invocation.
    if (trail.length <= 1) return;
    const next = trail.slice(0, -1);
    setTrail(next);
    void load(next[next.length - 1].path);
  }, [trail, load]);

  const pickFile = useCallback(
    async (entry: CloudFileEntry) => {
      setDownloadingId(entry.id);
      setDownloadPct(entry.size ? 0 : null);
      try {
        const file = await provider.download(entry, (loaded, total) => {
          setDownloadPct(total ? Math.round((loaded / total) * 100) : null);
        });
        // Await the loader too — it's async and can genuinely fail after a
        // successful download (an unparseable file), so "Loaded" and the
        // dialog closing must wait for it to actually finish, not just for
        // the bytes to arrive.
        await onPick(file);
        toast.success(`Loaded ${entry.name} from ${provider.label}`);
        onClose();
      } catch (err) {
        if (err instanceof CloudNotConnectedError) {
          setConnected(false);
        } else {
          const message = err instanceof Error ? err.message : 'Download failed';
          toast.error(message);
          setError(message);
        }
      } finally {
        setDownloadingId(null);
        setDownloadPct(null);
      }
    },
    [provider, onPick, onClose],
  );

  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Cloud className="h-5 w-5" /> Import from {provider.label}
          </DialogTitle>
          <DialogDescription>
            Files download straight from {provider.label} to your browser — they never pass
            through ifclite servers.
          </DialogDescription>
        </DialogHeader>

        {!connected ? (
          <div className="flex flex-col items-center gap-4 py-8">
            <Cloud className="h-10 w-10 text-zinc-400" />
            <p className="text-sm text-zinc-500 text-center">
              Connect your {provider.label} account to browse and load IFC files.
            </p>
            <Button onClick={handleConnect} disabled={connecting}>
              {connecting ? <Loader2 className="h-4 w-4 animate-spin" /> : <Cloud className="h-4 w-4" />}
              {connecting ? 'Connecting…' : `Connect ${provider.label}`}
            </Button>
            {error && <p className="text-xs text-red-500 text-center">{error}</p>}
          </div>
        ) : (
          <>
            <div className="flex items-center justify-between gap-2">
              <div className="flex items-center gap-1 min-w-0">
                <Button
                  variant="ghost"
                  size="icon-sm"
                  onClick={goUp}
                  disabled={trail.length <= 1 || listing}
                  title="Up one folder"
                >
                  <ChevronLeft className="h-4 w-4" />
                </Button>
                <span className="text-xs text-zinc-500 truncate">
                  {trail.map((c) => c.name).join(' / ')}
                </span>
              </div>
              <div className="flex items-center gap-1">
                <Button variant="ghost" size="icon-sm" onClick={() => void load(currentPath)} disabled={listing} title="Refresh">
                  <RefreshCw className={`h-4 w-4 ${listing ? 'animate-spin' : ''}`} />
                </Button>
                <Button variant="ghost" size="icon-sm" onClick={() => void handleDisconnect()} title="Disconnect">
                  <LogOut className="h-4 w-4" />
                </Button>
              </div>
            </div>

            <ScrollArea className="h-72 rounded-md border border-zinc-200 dark:border-zinc-800">
              {listing ? (
                <div className="flex items-center justify-center h-72 text-zinc-500">
                  <Loader2 className="h-5 w-5 animate-spin" />
                </div>
              ) : entries.length === 0 ? (
                <div className="flex items-center justify-center h-72 text-sm text-zinc-500">
                  No IFC files or folders here.
                </div>
              ) : (
                <ul className="divide-y divide-zinc-100 dark:divide-zinc-800">
                  {entries.map((entry) => {
                    const isDownloading = downloadingId === entry.id;
                    if (entry.disabled) {
                      // Informational row (e.g. "SharePoint needs a work or
                      // school account") — not clickable, no file/folder affordance.
                      return (
                        <li key={entry.id}>
                          <div className="w-full flex items-center gap-3 px-3 py-2 text-left text-zinc-400 dark:text-zinc-500">
                            <Info className="h-4 w-4 shrink-0" />
                            <span className="flex-1 truncate text-sm">{entry.name}</span>
                          </div>
                        </li>
                      );
                    }
                    return (
                      <li key={entry.id}>
                        <button
                          type="button"
                          className="w-full flex items-center gap-3 px-3 py-2 text-left hover:bg-accent disabled:opacity-60"
                          disabled={downloadingId !== null}
                          onClick={() => (entry.isFolder ? enterFolder(entry) : void pickFile(entry))}
                        >
                          {entry.isFolder ? (
                            <Folder className="h-4 w-4 text-amber-500 shrink-0" />
                          ) : isDownloading ? (
                            <Loader2 className="h-4 w-4 animate-spin shrink-0" />
                          ) : (
                            <FileBox className="h-4 w-4 text-indigo-500 shrink-0" />
                          )}
                          <span className="flex-1 truncate text-sm">{entry.name}</span>
                          <span className="text-xs text-zinc-400 shrink-0">
                            {isDownloading
                              ? downloadPct !== null
                                ? `${downloadPct}%`
                                : 'Downloading…'
                              : formatSize(entry.size)}
                          </span>
                        </button>
                      </li>
                    );
                  })}
                </ul>
              )}
            </ScrollArea>
            {error && <p className="text-xs text-red-500">{error}</p>}
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}
