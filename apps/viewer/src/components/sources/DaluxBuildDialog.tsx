/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { useState, useCallback, useMemo } from "react";
import type {
  ConnectionTestResult,
  SourceFile as PluginSourceFile,
} from "@ifc-lite/plugin-api";
import { useSourceHost } from "@/services/sources/SourceHostProvider";
import { dispatchSourceDownload } from "@/services/sources/source-host";
import { SourceSettingsDialog } from "./SourceSettingsDialog";
import { SourceBrowser } from "./SourceBrowser";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { toast } from "@/components/ui/toast";
import { Cloud, KeyRound, CheckCircle2, X } from "lucide-react";

interface DaluxBuildDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

const DALUX_PREFS_KEY = "ifc-lite-source-prefs:dalux-build";

function loadDaluxPrefs(): Record<string, string> {
  try {
    const raw = localStorage.getItem(DALUX_PREFS_KEY);
    return raw ? (JSON.parse(raw) as Record<string, string>) : {};
  } catch {
    return {};
  }
}

function saveDaluxPrefs(values: Record<string, string>): void {
  localStorage.setItem(DALUX_PREFS_KEY, JSON.stringify(values));
}

type Step = "settings" | "browser";

export function DaluxBuildDialog({
  open,
  onOpenChange,
}: DaluxBuildDialogProps) {
  const sourceHost = useSourceHost();
  const daluxProvider = sourceHost.get("dalux-build");

  const [step, setStep] = useState<Step>("settings");
  const [showSettings, setShowSettings] = useState(false);
  const [prefs, setPrefs] = useState<Record<string, string>>(loadDaluxPrefs());
  const [downloading, setDownloading] = useState(false);

  const isConfigured = daluxProvider?.manifest.preferences
    .filter((p) => p.required)
    .every((p) => !!prefs[p.name]?.trim());

  const handleSettingsSave = useCallback(
    (values: Record<string, string>) => {
      saveDaluxPrefs(values);
      setPrefs(values);
      setShowSettings(false);
      const nowConfigured = daluxProvider?.manifest.preferences
        .filter((p) => p.required)
        .every((p) => !!values[p.name]?.trim());
      if (nowConfigured) {
        setStep("browser");
      }
    },
    [daluxProvider],
  );

  const handleTestConnection = useCallback(
    async (values: Record<string, string>): Promise<ConnectionTestResult> => {
      if (!daluxProvider)
        return { ok: false, message: "Dalux provider not found" };
      const ctx = sourceHost.createContext(daluxProvider.manifest, values);
      if (daluxProvider.testConnection) {
        return daluxProvider.testConnection(ctx);
      }
      return {
        ok: false,
        message: "Provider does not support connection testing",
      };
    },
    [daluxProvider, sourceHost],
  );

  const handleFilesSelected = useCallback(
    async ({
      projectId,
      files,
    }: {
      readonly projectId: string;
      readonly files: readonly PluginSourceFile[];
    }) => {
      if (!daluxProvider) return;
      const ctx = sourceHost.createContext(daluxProvider.manifest, prefs);

      setDownloading(true);
      try {
        // Download every selected file before dispatching, so the viewer
        // receives one batch and loads it as a single federated model
        // without bursting the Dalux API rate limit.
        const items = [];
        for (const f of files) {
          items.push({
            name: f.name,
            buffer: await daluxProvider.download(ctx, f.id),
            sourceFile: f,
            tag: sourceHost.createSourceTag(
              "dalux-build",
              projectId,
              f.containerId,
              f.id,
              f.currentRevisionId,
            ),
          });
        }
        dispatchSourceDownload(items);
        onOpenChange(false);
      } catch (err) {
        toast.error(
          err instanceof Error
            ? err.message
            : "Failed to download files from Dalux Build",
        );
      } finally {
        setDownloading(false);
      }
    },
    [daluxProvider, prefs, sourceHost, onOpenChange],
  );

  const handleBackToBrowser = useCallback(() => {
    setStep("browser");
  }, []);

  // Stable for the life of the dialog — SourceBrowser keys its initial
  // project fetch (and per-visit folder caches) off this reference, so
  // recreating it on every unrelated re-render (Dialog/Radix internals,
  // downloading state, etc.) would discard that work and refetch from
  // scratch, including the file area's full folder pagination.
  const browserCtx = useMemo(
    () => (daluxProvider ? sourceHost.createContext(daluxProvider.manifest, prefs) : null),
    [daluxProvider, prefs, sourceHost],
  );

  if (!daluxProvider) {
    return (
      <Dialog open={open} onOpenChange={onOpenChange}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Dalux Build</DialogTitle>
          </DialogHeader>
          <div className="py-8 text-center text-sm text-muted-foreground">
            Dalux Build provider not configured
          </div>
        </DialogContent>
      </Dialog>
    );
  }

  return (
    <>
      <Dialog
        open={open && step === "settings"}
        onOpenChange={(isOpen) => {
          if (!isOpen) {
            onOpenChange(false);
          } else {
            setShowSettings(true);
          }
        }}
      >
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <div className="flex items-center gap-3">
              <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-primary/10 text-primary">
                <Cloud className="h-5 w-5" />
              </div>
              <div>
                <DialogTitle>Dalux Build</DialogTitle>
                <DialogDescription>
                  Connect your account to browse and load IFC files.
                </DialogDescription>
              </div>
            </div>
          </DialogHeader>

          <div className="pt-2">
            {!isConfigured ? (
              <div className="space-y-3">
                <div className="flex items-start gap-2 rounded-md bg-amber-500/10 px-3 py-2 text-sm text-amber-700 dark:text-amber-400">
                  <KeyRound className="mt-0.5 h-4 w-4 shrink-0" />
                  <span>
                    You'll need a Dalux API key from a company admin to
                    connect.
                  </span>
                </div>
                <Button
                  onClick={() => setShowSettings(true)}
                  className="w-full"
                >
                  Connect Dalux Build
                </Button>
              </div>
            ) : (
              <div className="space-y-3">
                <div className="flex items-center gap-2 rounded-md bg-green-500/10 px-3 py-2 text-sm text-green-700 dark:text-green-400">
                  <CheckCircle2 className="h-4 w-4 shrink-0" />
                  <span>Connected</span>
                </div>
                <Button onClick={() => setStep("browser")} className="w-full">
                  Browse files
                </Button>
                <button
                  type="button"
                  onClick={() => setShowSettings(true)}
                  className="w-full text-center text-xs text-muted-foreground hover:text-foreground hover:underline"
                >
                  Change API key
                </button>
              </div>
            )}
          </div>
        </DialogContent>
      </Dialog>

      <Dialog
        open={open && step === "browser"}
        onOpenChange={(isOpen) => {
          if (!isOpen) onOpenChange(false);
        }}
      >
        <DialogContent
          hideCloseButton
          className="flex h-[85vh] max-h-[85vh] w-full max-w-3xl flex-col overflow-hidden p-0"
        >
          <div className="flex min-h-0 flex-1 flex-col">
            <div className="flex items-center justify-between border-b px-6 py-4">
              <div className="flex items-center gap-3">
                <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-primary/10 text-primary">
                  <Cloud className="h-4 w-4" />
                </div>
                <DialogTitle>Dalux Build</DialogTitle>
              </div>
              <Button
                variant="ghost"
                size="icon"
                onClick={() => onOpenChange(false)}
              >
                <X className="h-4 w-4" />
              </Button>
            </div>

            <div className="min-h-0 flex-1 overflow-hidden">
              {daluxProvider && browserCtx && (
                <SourceBrowser
                  provider={daluxProvider}
                  ctx={browserCtx}
                  onDownload={handleFilesSelected}
                  onBack={handleBackToBrowser}
                  busy={downloading}
                />
              )}
            </div>
          </div>
        </DialogContent>
      </Dialog>

      <SourceSettingsDialog
        manifest={daluxProvider.manifest}
        open={showSettings}
        onOpenChange={setShowSettings}
        onSave={handleSettingsSave}
        onTestConnection={handleTestConnection}
        initialValues={prefs}
      />
    </>
  );
}
