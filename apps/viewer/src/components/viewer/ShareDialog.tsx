/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Share dialog (M1 scaffolding, plan §2.1).
 *
 * Accountless, link-based sharing: pick an access level, mint a room token,
 * copy the link. The role is baked into the token and enforced on the
 * collab-server (plan §3). "Live now" reflects `session.presence`.
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import { Check, Copy, Link2, Users } from 'lucide-react';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { useViewerStore } from '@/store';
import type { CollabRole } from '@/store/slices/collabSlice';
import { buildShareUrl, mintRoomId, mintRoomToken } from '@/lib/collab/share-link';

interface ShareDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

const ROLE_OPTIONS: ReadonlyArray<{ role: CollabRole; label: string; hint: string }> = [
  { role: 'viewer', label: 'View', hint: 'See the model, cursors, and comments' },
  { role: 'commenter', label: 'Comment', hint: 'Also add issues and markups' },
  { role: 'editor', label: 'Edit', hint: 'Also change properties and geometry' },
];

export function ShareDialog({ open, onOpenChange }: ShareDialogProps) {
  const models = useViewerStore((s) => s.models);
  const activeModelId = useViewerStore((s) => s.activeModelId);
  const collabRoomId = useViewerStore((s) => s.collabRoomId);
  const collabPeers = useViewerStore((s) => s.collabPeers);
  const collabIdentity = useViewerStore((s) => s.collabIdentity);
  const startCollab = useViewerStore((s) => s.startCollab);

  const [role, setRole] = useState<CollabRole>('editor');
  const [link, setLink] = useState<string>('');
  const [busy, setBusy] = useState(false);
  const [copied, setCopied] = useState(false);

  const modelName = useMemo(() => {
    if (activeModelId) {
      const m = models.get(activeModelId);
      if (m?.name) return m.name;
    }
    const first = models.values().next().value;
    return first?.name ?? 'this model';
  }, [models, activeModelId]);

  const hasModel = models.size > 0;

  // Re-mint the link whenever the dialog opens or the role changes, joining the
  // room as owner (admin) so presence is live while the dialog is open.
  useEffect(() => {
    if (!open || !hasModel) return;
    let cancelled = false;
    setBusy(true);
    setCopied(false);
    (async () => {
      const roomId = collabRoomId ?? mintRoomId();
      try {
        if (!collabRoomId) {
          await startCollab({ roomId, role: 'admin' });
        }
        const token = await mintRoomToken({ roomId, role });
        if (!cancelled) setLink(buildShareUrl(roomId, token));
      } catch (err) {
        // eslint-disable-next-line no-console
        console.error('[collab] share-link minting failed:', err);
      } finally {
        if (!cancelled) setBusy(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [open, hasModel, role, collabRoomId, startCollab]);

  const handleCopy = useCallback(async () => {
    if (!link) return;
    try {
      await navigator.clipboard.writeText(link);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      // clipboard may be blocked; the input is selectable as a fallback
    }
  }, [link]);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Link2 className="size-4" />
            Share “{modelName}”
          </DialogTitle>
          <DialogDescription>
            Anyone with the link can join — no account needed.
          </DialogDescription>
        </DialogHeader>

        {!hasModel ? (
          <p className="text-sm text-muted-foreground">
            Load a model first, then share it.
          </p>
        ) : (
          <div className="flex flex-col gap-4">
            <div className="flex flex-col gap-2">
              <Label>Anyone with the link can</Label>
              <div className="grid grid-cols-3 gap-2" role="radiogroup" aria-label="Access level">
                {ROLE_OPTIONS.map((opt) => (
                  <Button
                    key={opt.role}
                    type="button"
                    role="radio"
                    aria-checked={role === opt.role}
                    variant={role === opt.role ? 'default' : 'outline'}
                    size="sm"
                    onClick={() => setRole(opt.role)}
                  >
                    {opt.label}
                  </Button>
                ))}
              </div>
              <p className="text-xs text-muted-foreground">
                {ROLE_OPTIONS.find((o) => o.role === role)?.hint}
              </p>
            </div>

            <div className="flex items-end gap-2">
              <div className="flex flex-1 flex-col gap-1">
                <Label htmlFor="share-link">Link</Label>
                <Input
                  id="share-link"
                  readOnly
                  value={busy ? 'Generating link…' : link}
                  onFocus={(e) => e.currentTarget.select()}
                />
              </div>
              <Button type="button" onClick={handleCopy} disabled={busy || !link} className="gap-1.5">
                {copied ? <Check className="size-4" /> : <Copy className="size-4" />}
                {copied ? 'Copied' : 'Copy'}
              </Button>
            </div>

            <div className="flex flex-col gap-1.5">
              <Label className="flex items-center gap-1.5">
                <Users className="size-3.5" /> Live now
              </Label>
              <div className="flex flex-wrap items-center gap-2">
                <PeerChip color={collabIdentity.color} name={`${collabIdentity.name} (you)`} />
                {collabPeers.map((peer) => (
                  <PeerChip
                    key={peer.user.id}
                    color={peer.user.color ?? '#888'}
                    name={peer.user.name}
                  />
                ))}
              </div>
            </div>

            <p className="text-xs text-muted-foreground">
              Link expires in 7 days. Anyone with it gets <strong>{role}</strong> access.
            </p>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}

function PeerChip({ color, name }: { color: string; name: string }) {
  return (
    <span className="inline-flex items-center gap-1.5 rounded-full border px-2 py-0.5 text-xs">
      <span className="size-2 rounded-full" style={{ backgroundColor: color }} />
      {name}
    </span>
  );
}
