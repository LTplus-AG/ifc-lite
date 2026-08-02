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
import { buildShareUrl, mintRoomId, mintRoomToken, parseRoleFromToken } from '@/lib/collab/share-link';
import { buildStepSeedSource } from '@/lib/collab/step-seed';

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
  const ifcDataStore = useViewerStore((s) => s.ifcDataStore);
  const collabRoomId = useViewerStore((s) => s.collabRoomId);
  const collabRole = useViewerStore((s) => s.collabRole);
  const collabPeers = useViewerStore((s) => s.collabPeers);
  const collabIdentity = useViewerStore((s) => s.collabIdentity);
  const startCollab = useViewerStore((s) => s.startCollab);

  const [role, setRole] = useState<CollabRole>('editor');
  const [link, setLink] = useState<string>('');
  const [busy, setBusy] = useState(false);
  const [copied, setCopied] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);

  /**
   * Non-admins cannot mint role-scoped tokens (no escalation by design),
   * and even an admin's mint can fail after a reload loses the bearer.
   * Fall back to a link we already hold: the last one this tab minted,
   * else the invite THIS tab joined with (its token rides the page URL) —
   * forwarding it grants exactly the access we received, never more.
   */
  const fallbackShareLink = useCallback((roomId: string): { url: string; role: CollabRole | null } | null => {
    const last = useViewerStore.getState().collabLastShareToken;
    if (last) return { url: buildShareUrl(roomId, last), role: parseRoleFromToken(last) };
    if (typeof window !== 'undefined') {
      const params = new URLSearchParams(window.location.search);
      const urlToken = params.get('t');
      if (urlToken && params.get('room') === roomId) {
        return { url: buildShareUrl(roomId, urlToken), role: parseRoleFromToken(urlToken) };
      }
    }
    return null;
  }, []);

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
    setNotice(null);
    (async () => {
      const roomId = collabRoomId ?? mintRoomId();
      // A joined non-admin can't mint: don't fire a doomed request, reuse
      // the invite we hold and say so.
      if (collabRoomId && collabRole && collabRole !== 'admin') {
        const fallback = fallbackShareLink(roomId);
        if (!cancelled) {
          if (fallback) {
            setLink(fallback.url);
            if (fallback.role) setRole(fallback.role);
            setNotice('You joined via an invite - sharing it forwards the same access. Only the room admin can mint new links.');
          } else {
            setLink('');
            setNotice('Only the room admin can create invite links for this room.');
          }
          setBusy(false);
        }
        return;
      }
      try {
        if (!collabRoomId) {
          // The creator mints an admin token (first-touch) and joins with it,
          // so it's authorized to mint role-scoped share links thereafter.
          const adminToken = await mintRoomToken({ roomId, role: 'admin' });
          await startCollab({
            roomId,
            role: 'admin',
            token: adminToken,
            // Owner seeds the model so recipients hydrate from the room.
            // IFC5/IFCX seeds natively from the model's own bytes; legacy STEP
            // seeds the IFCX-shaped StepSeedSource. (Seeding IFCX via the STEP
            // path produces an empty room — it can't read an IFCX-origin store.)
            seed: () => {
              const store = ifcDataStore;
              if (!store) return null;
              const model = activeModelId ? models.get(activeModelId) : undefined;
              const isIfcx = (model?.schemaVersion ?? store.schemaVersion) === 'IFC5';
              return {
                store,
                isIfcx,
                stepSource: isIfcx ? null : buildStepSeedSource(store, modelName),
              };
            },
          });
        }
        // Mint the role-scoped share link (server requires the owner's admin
        // bearer once the room exists; ignored in local-only mode).
        const adminBearer = useViewerStore.getState().collabSelfToken ?? undefined;
        const token = await mintRoomToken({ roomId, role, bearer: adminBearer });
        if (!cancelled) {
          setLink(buildShareUrl(roomId, token));
          useViewerStore.getState().setCollabLastShareToken(token);
        }
      } catch (err) {
        // eslint-disable-next-line no-console
        console.error('[collab] share-link minting failed:', err);
        // Never leave an empty Link box: reuse a link we already hold.
        const fallback = fallbackShareLink(roomId);
        if (!cancelled) {
          if (fallback) {
            setLink(fallback.url);
            setNotice('Could not mint a fresh link - reusing your current invite (same access).');
          } else {
            setLink('');
            setNotice('Link creation failed. Check the connection and try again.');
          }
        }
      } finally {
        if (!cancelled) setBusy(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [open, hasModel, role, collabRoomId, collabRole, startCollab, ifcDataStore, modelName, fallbackShareLink]);

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
                    // Only the room admin mints role-scoped links; a joiner
                    // forwards the invite they hold, so the role is fixed.
                    disabled={Boolean(collabRoomId && collabRole && collabRole !== 'admin')}
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
            {notice && <p className="text-xs text-muted-foreground">{notice}</p>}

            <div className="flex flex-col gap-1.5">
              <Label className="flex items-center gap-1.5">
                <Users className="size-3.5" /> Live now
              </Label>
              <div className="flex flex-wrap items-center gap-2">
                <PeerChip color={collabIdentity.color} name={`${collabIdentity.name} (you)`} />
                {collabPeers
                  // A peer's awareness state can arrive before its `user` is
                  // populated (the identity patch flushes async). Skip those
                  // half-initialized entries so a transient peer can't crash
                  // the dialog with `peer.user.color` of undefined.
                  .filter((peer) => peer?.user)
                  .map((peer) => (
                    <PeerChip
                      key={peer.user.id}
                      color={peer.user.color ?? '#888'}
                      name={peer.user.name ?? 'Guest'}
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
