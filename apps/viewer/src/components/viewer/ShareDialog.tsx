/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Share dialog (M1 scaffolding, plan §2.1).
 *
 * Accountless, link-based sharing: pick an access level, mint a room token,
 * copy the link. The role is baked into the token and enforced on the
 * collab-server (plan §3). "Live now" reflects `session.presence`.
 *
 * Two independent effects (#4446): one creates the room (mints the admin
 * token, starts the seeding join), the other mints the invite — and only once
 * `collabSeedPhase` says the seed has settled. `startCollab` sets
 * `collabRoomId` synchronously, long before the model is in the room, and a
 * single effect keyed on it used to re-run for the new room and hand out a
 * link to an empty one; whoever opened it reconstructed nothing.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { AlertTriangle, Check, Copy, Link2, Loader2, Users } from 'lucide-react';
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
import { toast } from '@/components/ui/toast';
import type { CollabRole } from '@/store/slices/collabSlice';
import { buildShareUrl, mintRoomId, mintRoomToken, parseRoleFromToken } from '@/lib/collab/share-link';
import { buildStepSeedSource } from '@/lib/collab/step-seed';
import { describeSeedPhase, isCollabSeedInFlight } from '@/lib/collab/seed-phase';

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
  // Set when the room did not get the model's geometry. A link to a room the
  // viewer KNOWS is missing its geometry must not be presented as a plain
  // success: the recipient would open it and see an empty scene.
  const seedFailure = useViewerStore((s) => s.collabSeedFailure);
  const seedPhase = useViewerStore((s) => s.collabSeedPhase);
  const seedProgress = useViewerStore((s) => s.collabSeedProgress);

  const [role, setRole] = useState<CollabRole>('editor');
  const [link, setLink] = useState<string>('');
  // Room creation in flight (no room yet) / invite mint in flight.
  const [creating, setCreating] = useState(false);
  const [minting, setMinting] = useState(false);
  const [copied, setCopied] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  // One room-creation attempt per opening. A join whose session never comes up
  // resets `collabRoomId` to null, which would otherwise re-trigger creation
  // in a loop; the notice tells the user, and re-opening the dialog retries.
  const roomAttemptRef = useRef<Promise<void> | null>(null);

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
  const isJoiner = Boolean(collabRoomId && collabRole && collabRole !== 'admin');
  // The room exists but the model is still going in: no invite until it has.
  const seedInFlight = Boolean(collabRoomId) && isCollabSeedInFlight(seedPhase);

  // 1. Ensure a room: the creator mints an admin token (first-touch) and joins
  // with it, seeding the model, so it's authorized to mint role-scoped share
  // links thereafter. Deliberately NOT re-run by `collabRoomId` flipping to
  // the new room — the attempt ref carries this promise across re-renders.
  useEffect(() => {
    if (!open) {
      roomAttemptRef.current = null;
      return;
    }
    if (!hasModel || collabRoomId || roomAttemptRef.current) return;
    const roomId = mintRoomId();
    setCreating(true);
    setLink('');
    setCopied(false);
    setNotice(null);
    roomAttemptRef.current = (async () => {
      try {
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
        // `startCollab` resolves without a live room when the session never
        // came up (it logs why) or the user left mid-join (RoomPanel's Leave).
        // Neither is a connection failure this dialog can tell apart, and the
        // attempt ref blocks a retry until it is re-opened — so say exactly
        // that instead of sitting on "Creating room…" forever.
        if (useViewerStore.getState().collabRoomId !== roomId) {
          setNotice('No room was created. Close and reopen this dialog to try again.');
        }
      } catch (err) {
        // eslint-disable-next-line no-console
        console.error('[collab] room creation failed:', err);
        setNotice('Link creation failed. Check the connection and try again.');
      } finally {
        setCreating(false);
      }
    })();
  }, [open, hasModel, collabRoomId, startCollab, ifcDataStore, activeModelId, models, modelName]);

  // 2. Mint the invite — re-minted when the dialog opens or the role changes,
  // and only once the seed has settled (`seedInFlight` false). Until then the
  // progress row below stands in for the link.
  useEffect(() => {
    if (!open || !hasModel || !collabRoomId) return;
    setCopied(false);
    // A joined non-admin can't mint: don't fire a doomed request, reuse the
    // invite we hold and say so.
    if (isJoiner) {
      const fallback = fallbackShareLink(collabRoomId);
      if (fallback) {
        setLink(fallback.url);
        if (fallback.role) setRole(fallback.role);
        setNotice('You joined via an invite - sharing it forwards the same access. Only the room admin can mint new links.');
      } else {
        setLink('');
        setNotice('Only the room admin can create invite links for this room.');
      }
      return;
    }
    if (seedInFlight) return;
    let cancelled = false;
    setMinting(true);
    setNotice(null);
    (async () => {
      const roomId = collabRoomId;
      try {
        // Server requires the owner's admin bearer once the room exists;
        // ignored in local-only mode.
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
        if (!cancelled) setMinting(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [open, hasModel, collabRoomId, isJoiner, seedInFlight, role, fallbackShareLink]);

  useEffect(() => {
    if (open && seedFailure) toast.error(seedFailure);
  }, [open, seedFailure]);

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

  const waiting = (creating && !collabRoomId) || seedInFlight || minting;
  const seedLabel = describeSeedPhase(seedPhase, seedProgress);
  const linkFieldText = seedInFlight
    ? 'Link is ready once the upload finishes…'
    : creating && !collabRoomId
      ? 'Creating room…'
      : 'Generating link…';

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
                    disabled={isJoiner}
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
                  value={waiting ? linkFieldText : link}
                  onFocus={(e) => e.currentTarget.select()}
                />
              </div>
              <Button type="button" onClick={handleCopy} disabled={waiting || !link} className="gap-1.5">
                {copied ? <Check className="size-4" /> : <Copy className="size-4" />}
                {copied ? 'Copied' : 'Copy'}
              </Button>
            </div>
            {seedInFlight && seedLabel && (
              <p role="status" className="flex items-center gap-2 text-xs text-muted-foreground">
                <Loader2 className="size-3.5 shrink-0 animate-spin" aria-hidden />
                <span>{seedLabel}</span>
              </p>
            )}
            {notice && <p className="text-xs text-muted-foreground">{notice}</p>}
            {seedFailure && (
              <div
                role="alert"
                className="flex items-start gap-2 rounded-md bg-destructive/10 px-3 py-2 text-xs text-destructive"
              >
                <AlertTriangle className="mt-px size-3.5 shrink-0" />
                <span>{seedFailure}</span>
              </div>
            )}

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
