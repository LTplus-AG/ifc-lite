/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Collaboration room panel — the live roster + room management surface.
 *
 * Registered as the `collab` workspace panel (see `@/lib/panels/registry`), so
 * it docks in the unified sidebar, floats, and pops out like every other
 * panel. Surfaces who is in the room, their role + activity, and room
 * management (copy invite link, revoke, kick, leave). All data comes from the
 * collab slice (`collabPeers`, `collabIdentity`, `collabRole`, `collabRoomId`,
 * `collabStatus`); presence updates stream in live.
 */

import { useCallback, useMemo, useState } from 'react';
import { Check, Link2, LocateFixed, LogOut, ShieldOff, UserMinus, Users } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { useViewerStore } from '@/store';
import type { CollabRole } from '@/store/slices/collabSlice';
import { buildShareUrl, mintRoomToken } from '@/lib/collab/share-link';

interface RoomPanelProps {
  onClose: () => void;
}

/** Connection status → dot color + label. */
const STATUS_META: Record<string, { tone: string; label: string; pulse: boolean }> = {
  connected: { tone: 'bg-emerald-500', label: 'Live', pulse: true },
  syncing: { tone: 'bg-amber-500', label: 'Syncing', pulse: true },
  connecting: { tone: 'bg-amber-500', label: 'Connecting', pulse: true },
  indexeddb: { tone: 'bg-sky-500', label: 'Local', pulse: false },
  memory: { tone: 'bg-sky-500', label: 'Local', pulse: false },
  disconnected: { tone: 'bg-muted-foreground/50', label: 'Offline', pulse: false },
};

/** Role → badge accent. Subtle, role-tinted, dark-mode aware. */
const ROLE_META: Record<CollabRole, { label: string; cls: string }> = {
  admin: { label: 'Admin', cls: 'border-violet-500/30 bg-violet-500/10 text-violet-600 dark:text-violet-300' },
  editor: { label: 'Editor', cls: 'border-emerald-500/30 bg-emerald-500/10 text-emerald-600 dark:text-emerald-300' },
  commenter: { label: 'Comment', cls: 'border-amber-500/30 bg-amber-500/10 text-amber-600 dark:text-amber-300' },
  viewer: { label: 'Viewer', cls: 'border-sky-500/30 bg-sky-500/10 text-sky-600 dark:text-sky-300' },
};

function RoleBadge({ role }: { role: CollabRole }) {
  const m = ROLE_META[role];
  return (
    <span className={`shrink-0 rounded-full border px-1.5 py-px text-[10px] font-medium leading-none ${m.cls}`}>
      {m.label}
    </span>
  );
}

/** A presence avatar — color dot with a soft ring + optional activity pulse. */
function PresenceDot({ color, active }: { color: string; active?: boolean }) {
  return (
    <span className="relative flex size-2.5 shrink-0 items-center justify-center">
      {active && (
        <span
          className="absolute inline-flex size-full animate-ping rounded-full opacity-60"
          style={{ backgroundColor: color }}
        />
      )}
      <span
        className="relative inline-flex size-2.5 rounded-full ring-2 ring-background"
        style={{ backgroundColor: color }}
      />
    </span>
  );
}

type Vec3 = { x: number; y: number; z: number };

function PeerRow({
  color,
  name,
  isSelf,
  role,
  activity,
  selectionCount,
  index,
  onJump,
  onKick,
}: {
  color: string;
  name: string;
  isSelf?: boolean;
  role?: CollabRole;
  activity?: string;
  selectionCount?: number;
  index: number;
  onJump?: () => void;
  onKick?: () => void;
}) {
  // Sub-line: activity (idle/measuring…) and/or selection count.
  const subParts: string[] = [];
  if (activity && activity !== 'active') subParts.push(activity);
  if (selectionCount && selectionCount > 0) subParts.push(`${selectionCount} selected`);
  const subLine = subParts.join(' · ');
  return (
    <div
      className="group flex items-center gap-2 rounded-md px-1.5 py-1 transition-colors hover:bg-muted/60"
      style={{ animationDelay: `${index * 30}ms` }}
    >
      <PresenceDot color={color} active={activity === 'active'} />
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-1.5">
          <span className="truncate text-xs font-medium">{name}</span>
          {isSelf && <span className="text-[10px] text-muted-foreground">(you)</span>}
        </div>
        {subLine && <span className="text-[10px] capitalize text-muted-foreground">{subLine}</span>}
      </div>
      {role && <RoleBadge role={role} />}
      {onJump && (
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              variant="ghost"
              size="icon-sm"
              className="size-5 shrink-0 text-muted-foreground opacity-0 transition-opacity hover:text-foreground group-hover:opacity-100"
              onClick={onJump}
              aria-label={`Jump to ${name}'s view`}
            >
              <LocateFixed className="size-3" />
            </Button>
          </TooltipTrigger>
          <TooltipContent side="left">Jump to view</TooltipContent>
        </Tooltip>
      )}
      {onKick && (
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              variant="ghost"
              size="icon-sm"
              className="size-5 shrink-0 text-muted-foreground opacity-0 transition-opacity hover:text-destructive group-hover:opacity-100"
              onClick={onKick}
              aria-label={`Remove ${name}`}
            >
              <UserMinus className="size-3" />
            </Button>
          </TooltipTrigger>
          <TooltipContent side="left">Remove from room</TooltipContent>
        </Tooltip>
      )}
    </div>
  );
}

export function RoomPanel({ onClose }: RoomPanelProps) {
  const collabRoomId = useViewerStore((s) => s.collabRoomId);
  const collabStatus = useViewerStore((s) => s.collabStatus);
  const collabRole = useViewerStore((s) => s.collabRole);
  const collabIdentity = useViewerStore((s) => s.collabIdentity);
  const collabPeers = useViewerStore((s) => s.collabPeers);
  const stopCollab = useViewerStore((s) => s.stopCollab);
  const kickPeer = useViewerStore((s) => s.kickPeer);
  const revokeCollabLink = useViewerStore((s) => s.revokeCollabLink);

  const [copied, setCopied] = useState(false);
  const [revoked, setRevoked] = useState(false);

  const status = STATUS_META[collabStatus] ?? STATUS_META.disconnected;
  const selfRole: CollabRole = collabRole ?? 'admin';
  const isAdmin = collabRole === 'admin';
  const peerCount = collabPeers.length + 1;

  const handleCopyLink = useCallback(async () => {
    if (!collabRoomId) return;
    try {
      // Share at the broadest non-owner level the inviter can grant.
      const role: CollabRole = isAdmin ? 'editor' : selfRole;
      const adminBearer = useViewerStore.getState().collabSelfToken ?? undefined;
      const token = await mintRoomToken({ roomId: collabRoomId, role, bearer: adminBearer });
      await navigator.clipboard.writeText(buildShareUrl(collabRoomId, token));
      useViewerStore.getState().setCollabLastShareToken(token);
      setCopied(true);
      setTimeout(() => setCopied(false), 1600);
    } catch {
      // clipboard / mint can fail silently; the dialog Share flow is the fallback
    }
  }, [collabRoomId, isAdmin, selfRole]);

  const handleRevoke = useCallback(async () => {
    const ok = await revokeCollabLink();
    if (ok) {
      setRevoked(true);
      setTimeout(() => setRevoked(false), 2000);
    }
  }, [revokeCollabLink]);

  const handleLeave = useCallback(() => {
    stopCollab();
    onClose();
  }, [stopCollab, onClose]);

  const jumpToPeer = useCallback(
    (camera: { position: Vec3; target: Vec3; fov: number } | undefined) => {
      if (!camera) return;
      const { cameraCallbacks, projectionMode } = useViewerStore.getState();
      // Presence carries only position/target/fov; reconstruct a viewpoint with
      // world-up + our own projection ("jump to roughly their view").
      cameraCallbacks.applyViewpoint?.(
        {
          position: camera.position,
          target: camera.target,
          up: { x: 0, y: 1, z: 0 },
          fov: camera.fov,
          projectionMode,
        },
        true,
      );
    },
    [],
  );

  const peerRows = useMemo(
    () =>
      collabPeers.filter((p) => p?.user).map((p, i) => {
        const clientId = (p as { clientId?: number }).clientId;
        const camera = (p as { camera?: { position: Vec3; target: Vec3; fov: number } }).camera;
        const selection = (p as { selection?: string[] }).selection;
        return (
          <PeerRow
            key={p.user.id}
            color={p.user.color ?? '#888'}
            name={p.user.name ?? 'Guest'}
            role={(p as { role?: CollabRole }).role}
            activity={p.status ?? (p.tool && p.tool !== 'select' ? p.tool : undefined)}
            selectionCount={selection?.length}
            index={i + 1}
            onJump={camera ? () => jumpToPeer(camera) : undefined}
            onKick={isAdmin && clientId != null ? () => void kickPeer(clientId) : undefined}
          />
        );
      }),
    [collabPeers, isAdmin, kickPeer, jumpToPeer],
  );

  if (!collabRoomId) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-2 p-6 text-center">
        <Users className="size-6 text-muted-foreground" aria-hidden />
        <p className="text-sm font-medium">Not in a shared room</p>
        <p className="text-xs text-muted-foreground">
          Use the Share button in the toolbar to create a room and copy an
          invite link, or open a link someone shared with you.
        </p>
      </div>
    );
  }

  return (
    <div className="flex h-full min-h-0 flex-col" aria-label="Collaboration room">
      {/* Header */}
      <div className="flex items-center gap-2 border-b px-3 py-2">
        <span className="relative flex size-2 items-center justify-center">
          {status.pulse && (
            <span className={`absolute inline-flex size-full animate-ping rounded-full opacity-75 ${status.tone}`} />
          )}
          <span className={`relative inline-flex size-2 rounded-full ${status.tone}`} />
        </span>
        <div className="min-w-0 flex-1">
          <div className="text-xs font-semibold leading-tight">{status.label} room</div>
          <div className="truncate font-mono text-[10px] text-muted-foreground">{collabRoomId}</div>
        </div>
        <span className="rounded-full bg-muted px-1.5 py-0.5 text-[10px] font-medium text-muted-foreground">
          {peerCount}
        </span>
      </div>

      {/* Roster */}
      <ScrollArea className="min-h-0 flex-1">
        <div className="flex flex-col gap-px p-1.5">
          <PeerRow
            color={collabIdentity.color}
            name={collabIdentity.name}
            isSelf
            role={selfRole}
            index={0}
          />
          {peerRows}
          {peerRows.length === 0 && (
            <p className="px-1.5 py-2 text-[11px] text-muted-foreground">
              You're the only one here. Copy the link to invite others.
            </p>
          )}
        </div>
      </ScrollArea>

      {/* Actions */}
      <div className="flex flex-col gap-1.5 border-t p-2">
        <Button
          variant="secondary"
          size="sm"
          className="h-8 w-full justify-start gap-2"
          onClick={handleCopyLink}
        >
          {copied ? <Check className="size-3.5" /> : <Link2 className="size-3.5" />}
          {copied ? 'Link copied' : 'Copy invite link'}
        </Button>
        <div className="flex items-center gap-1.5">
          {isAdmin && (
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  variant="ghost"
                  size="sm"
                  className="h-8 flex-1 justify-start gap-2 text-muted-foreground"
                  onClick={handleRevoke}
                >
                  <ShieldOff className="size-3.5" />
                  {revoked ? 'Revoked' : 'Revoke link'}
                </Button>
              </TooltipTrigger>
              <TooltipContent side="bottom">Invalidate the current share link</TooltipContent>
            </Tooltip>
          )}
          <Button
            variant="ghost"
            size="sm"
            className="h-8 flex-1 justify-start gap-2 text-destructive hover:text-destructive"
            onClick={handleLeave}
          >
            <LogOut className="size-3.5" />
            Leave room
          </Button>
        </div>
      </div>
    </div>
  );
}
