/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Entry and removal for one provider's BYOK credential.
 *
 * One form, one draft per box, one Save. That is the point of the file: the
 * Anthropic credential is a key AND (sometimes) a workspace id, and while the
 * workspace box had its own separate Save, the ordinary first run — paste both,
 * press the Save you can see — stored the key, said "key saved", and dropped
 * the id on the floor while leaving it on screen. The request then failed with
 * the very error this feature exists to explain, telling the user to add an id
 * their Settings appeared to already hold.
 *
 * So the form commits what is on screen. An empty key box means "keep the
 * stored key" — it is a replace field that starts blank, not a request to clear
 * anything. A workspace box the user did not touch lets `keyWriteUpdates`'s
 * clear-on-replace rule stand; one they did touch wins over it.
 */

import { useEffect, useRef, useState } from 'react';
import { Check, Eye, EyeOff, Trash2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { toast } from '@/components/ui/toast';
import { clearProvider, saveCredential } from '@/services/api-keys';
import { isPlainAsciiWorkspaceId } from '@/lib/llm/anthropic-client';
import { looksLikeProviderKey, maskKey, type BYOKProvider } from '@/lib/llm/clipboard-detect';

/**
 * What the save actually did, as words. A pure function so the four cases are
 * readable at a glance and testable without rendering.
 */
function saveToast(label: string, wroteKey: boolean, clearedWorkspaceId: boolean): string {
  if (wroteKey && clearedWorkspaceId) {
    return 'Anthropic key saved — Workspace ID cleared, re-enter it if the new key needs one';
  }
  if (wroteKey) return `${label} key saved`;
  return clearedWorkspaceId ? 'Workspace ID cleared' : 'Workspace ID saved';
}

/** The presentation bits of the caller's provider table that this form needs. */
export interface CredentialFormMeta {
  label: string;
  keyPrefix: string;
  placeholder: string;
}

interface ByokCredentialFormProps {
  provider: BYOKProvider;
  meta: CredentialFormMeta;
  savedKey: string;
  /** Always '' for providers without a workspace concept. */
  savedWorkspaceId: string;
}

/** Both credential boxes share this so they stay identical by construction. */
const INPUT_CLASS =
  'w-full rounded-md border border-input bg-background px-3 py-1.5 text-sm font-mono '
  + 'focus:outline-none focus:ring-1 focus:ring-ring';

export function ByokCredentialForm({
  provider,
  meta,
  savedKey,
  savedWorkspaceId,
}: ByokCredentialFormProps) {
  const [keyDraft, setKeyDraft] = useState('');
  const [workspaceDraft, setWorkspaceDraft] = useState(savedWorkspaceId);
  // Touched, not merely different. Someone rotating a key inside the same
  // workspace may retype the id they already have to be explicit; comparing
  // values would call that untouched and let clear-on-replace discard it.
  const [workspaceTouched, setWorkspaceTouched] = useState(false);
  const [show, setShow] = useState(false);
  const keyRef = useRef<HTMLInputElement>(null);

  // Autofocus so the user's Cmd+V lands here straight after returning from the
  // provider console. Re-runs on tab switch.
  useEffect(() => {
    keyRef.current?.focus();
  }, [provider]);

  const trimmedKey = keyDraft.trim();
  const trimmedWorkspace = workspaceDraft.trim();
  const keyMatchesProvider = looksLikeProviderKey(provider, keyDraft);
  const keyValid = trimmedKey.length === 0 || keyMatchesProvider;
  const wantsWorkspace = provider === 'anthropic';
  // What the save offers for the workspace box, and whether that changes
  // anything — one condition, not two that can drift apart.
  const workspaceOffered = wantsWorkspace && workspaceTouched ? trimmedWorkspace : undefined;
  const workspaceEdited = workspaceOffered !== undefined && workspaceOffered !== savedWorkspaceId;
  const workspaceClean = isPlainAsciiWorkspaceId(trimmedWorkspace);
  const canSave = keyValid && workspaceClean && (trimmedKey.length > 0 || workspaceEdited);

  const handleSave = () => {
    if (!canSave) return;
    // Describe what the write DID, never a second copy of the rule that decided
    // it: re-deriving announced a cleared workspace id to users who never had
    // one, and a key save to users who only emptied the workspace box.
    const next = saveCredential(provider, { apiKey: keyDraft, workspaceId: workspaceOffered });
    setKeyDraft('');
    if (wantsWorkspace) setWorkspaceDraft(next.anthropicWorkspaceId);
    setWorkspaceTouched(false);
    toast.success(saveToast(
      meta.label,
      trimmedKey.length > 0,
      Boolean(savedWorkspaceId) && !next.anthropicWorkspaceId,
    ));
  };

  const handleClear = () => {
    const hadWorkspaceId = Boolean(savedWorkspaceId);
    clearProvider(provider);
    setKeyDraft('');
    setWorkspaceDraft('');
    setWorkspaceTouched(false);
    toast.success(
      hadWorkspaceId
        ? 'Anthropic key and Workspace ID removed'
        : `${meta.label} key removed`,
    );
  };

  return (
    <div className="space-y-4">
      {/* Paste-driven key entry, autofocused on mount. */}
      <div className="space-y-1.5">
        <label className="text-xs font-medium" htmlFor={`byok-${provider}-input`}>
          {savedKey ? 'Replace existing key' : 'Paste your key'}
        </label>
        <div className="relative">
          <input
            ref={keyRef}
            id={`byok-${provider}-input`}
            type={show ? 'text' : 'password'}
            value={keyDraft}
            onChange={(e) => setKeyDraft(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') handleSave(); }}
            placeholder={meta.placeholder}
            autoComplete="off"
            spellCheck={false}
            className={`${INPUT_CLASS} pr-8`}
          />
          <button
            type="button"
            onClick={() => setShow(!show)}
            className="absolute right-2 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
            aria-label={show ? 'Hide key' : 'Show key'}
          >
            {show ? <EyeOff className="h-3.5 w-3.5" /> : <Eye className="h-3.5 w-3.5" />}
          </button>
        </div>
        {keyValid && trimmedKey.length > 0 && trimmedKey !== savedKey && (
          <p className="text-[11px] text-emerald-600 dark:text-emerald-400 flex items-center gap-1">
            <Check className="h-3 w-3" />
            Looks like a {meta.label} key (<code className="font-mono">{maskKey(trimmedKey)}</code>).
          </p>
        )}
        {!keyValid && (
          <p className="text-[11px] text-destructive">
            That doesn&apos;t look like a {meta.label} key (expected prefix{' '}
            <code className="font-mono">{meta.keyPrefix}</code>).
          </p>
        )}
      </div>

      {wantsWorkspace && (
        <div className="space-y-1.5">
          <label className="text-xs font-medium" htmlFor="byok-anthropic-workspace">
            Workspace ID <span className="font-normal text-muted-foreground">— optional</span>
          </label>
          <input
            id="byok-anthropic-workspace"
            type="text"
            aria-invalid={!workspaceClean}
            aria-describedby="byok-anthropic-workspace-hint"
            value={workspaceDraft}
            onChange={(e) => { setWorkspaceDraft(e.target.value); setWorkspaceTouched(true); }}
            onKeyDown={(e) => { if (e.key === 'Enter') handleSave(); }}
            placeholder="wrkspc_..."
            autoComplete="off"
            spellCheck={false}
            className={INPUT_CLASS}
          />
          {workspaceClean ? (
            <p id="byok-anthropic-workspace-hint" className="text-[11px] text-muted-foreground">
              Only needed if your key reaches more than one workspace — Anthropic then rejects
              every request until one is named. A key created for a single workspace needs
              nothing here.
            </p>
          ) : (
            <p id="byok-anthropic-workspace-hint" className="text-[11px] text-destructive">
              That contains a character that doesn&apos;t belong in a workspace ID — usually an
              invisible one picked up while copying. Retype it, or paste it again.
            </p>
          )}
        </div>
      )}

      <Button size="sm" onClick={handleSave} disabled={!canSave}>
        Save
      </Button>

      {savedKey && (
        <div className="flex items-center justify-between gap-3 rounded-md border p-3 text-xs">
          <div className="flex items-center gap-2 text-muted-foreground">
            <Check className="h-3.5 w-3.5 text-emerald-500" />
            Configured: <code className="font-mono text-foreground">{maskKey(savedKey)}</code>
          </div>
          <Button variant="ghost" size="sm" className="h-7 px-2 text-xs" onClick={handleClear}>
            <Trash2 className="mr-1 h-3 w-3" />
            Remove
          </Button>
        </div>
      )}
    </div>
  );
}
