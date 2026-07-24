/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { useState, useCallback, useEffect, useRef } from 'react';
import type { PluginManifest, PluginPreference, ConnectionTestResult } from '@ifc-lite/plugin-api';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { CheckCircle2, XCircle, Loader2, Trash2 } from 'lucide-react';

interface SourceSettingsDialogProps {
  manifest: PluginManifest;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSave: (values: Record<string, string>) => void;
  onTestConnection?: (values: Record<string, string>) => Promise<ConnectionTestResult>;
  onForget?: () => void;
  initialValues?: Record<string, string>;
}

export function SourceSettingsDialog({
  manifest,
  open,
  onOpenChange,
  onSave,
  onTestConnection,
  onForget,
  initialValues = {},
}: SourceSettingsDialogProps) {
  const [values, setValues] = useState<Record<string, string>>(initialValues);
  const [testResult, setTestResult] = useState<ConnectionTestResult | null>(null);
  const [testing, setTesting] = useState(false);

  // Re-seed the form only when the dialog transitions closed -> open. Keying
  // the effect on `initialValues` identity wiped in-progress typing whenever
  // the parent re-rendered with a freshly built object.
  const initialValuesRef = useRef(initialValues);
  initialValuesRef.current = initialValues;
  const wasOpenRef = useRef(false);
  useEffect(() => {
    if (open && !wasOpenRef.current) {
      setValues(initialValuesRef.current);
      setTestResult(null);
    }
    wasOpenRef.current = open;
  }, [open]);

  const updateValue = useCallback((name: string, value: string) => {
    setValues((prev) => ({ ...prev, [name]: value }));
    setTestResult(null);
  }, []);

  const handleTest = useCallback(async () => {
    if (!onTestConnection) return;
    setTesting(true);
    try {
      const result = await onTestConnection(values);
      setTestResult(result);
    } catch (err) {
      setTestResult({
        ok: false,
        message: err instanceof Error ? err.message : String(err),
      });
    } finally {
      setTesting(false);
    }
  }, [onTestConnection, values]);

  const handleSave = useCallback(() => {
    onSave(values);
    onOpenChange(false);
  }, [onSave, onOpenChange, values]);

  const handleForget = useCallback(() => {
    onForget?.();
    setValues({});
    setTestResult(null);
    onOpenChange(false);
  }, [onForget, onOpenChange]);

  // Default-aware: a required pref whose manifest declares a default is
  // satisfied by that default (which is also what the field displays).
  const requiredMissing = manifest.preferences
    .filter((p) => p.required)
    .some((p) => !(values[p.name] ?? p.default)?.trim());

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>{manifest.title} Settings</DialogTitle>
        </DialogHeader>

        <div className="flex flex-col gap-4 py-2">
          {manifest.preferences.map((pref) => (
            <PreferenceField
              key={pref.name}
              pref={pref}
              // Defaults are merged into the initial values by the parent, so
              // what is displayed is always what will be saved and validated.
              value={values[pref.name] ?? pref.default ?? ''}
              onChange={(v) => updateValue(pref.name, v)}
            />
          ))}

          <p className="text-xs text-muted-foreground">
            Saved values are stored in this browser's local storage,
            unencrypted. Treat them as revocable, not secret.
          </p>

          {testResult && (
            <div
              className={`flex items-center gap-2 rounded-md px-3 py-2 text-sm ${
                testResult.ok
                  ? 'bg-green-500/10 text-green-700 dark:text-green-400'
                  : 'bg-red-500/10 text-red-700 dark:text-red-400'
              }`}
            >
              {testResult.ok ? (
                <CheckCircle2 className="h-4 w-4 shrink-0" />
              ) : (
                <XCircle className="h-4 w-4 shrink-0" />
              )}
              <span>{testResult.message}</span>
            </div>
          )}
        </div>

        <DialogFooter className="gap-2 sm:gap-0">
          {onForget && (
            <Button
              variant="ghost"
              className="mr-auto text-destructive hover:text-destructive"
              onClick={handleForget}
            >
              <Trash2 className="mr-2 h-4 w-4" />
              Forget saved values
            </Button>
          )}
          {onTestConnection && (
            <Button
              variant="outline"
              onClick={handleTest}
              disabled={testing || requiredMissing}
            >
              {testing && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
              Test connection
            </Button>
          )}
          <Button onClick={handleSave} disabled={requiredMissing}>
            Save
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function PreferenceField({
  pref,
  value,
  onChange,
}: {
  pref: PluginPreference;
  value: string;
  onChange: (value: string) => void;
}) {
  return (
    <div className="flex flex-col gap-1.5">
      <Label htmlFor={`pref-${pref.name}`}>
        {pref.title}
        {pref.required && <span className="ml-1 text-red-500">*</span>}
      </Label>
      {pref.description && (
        <p className="text-xs text-muted-foreground">{pref.description}</p>
      )}
      <Input
        id={`pref-${pref.name}`}
        type={pref.type === 'password' ? 'password' : 'text'}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={pref.type === 'password' ? '••••••••' : undefined}
      />
    </div>
  );
}
