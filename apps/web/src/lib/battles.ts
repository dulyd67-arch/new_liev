/** Scores are committed promotional DU gifts, never likes or cash. */
export interface BattleHost {
  streamId: string;
  userId: string;
  title: string;
  username: string | null;
  displayName: string;
}

export interface BattleView {
  id: string;
  status: 'INVITED' | 'ACTIVE' | 'FINISHED' | 'DECLINED' | 'CANCELED';
  host: BattleHost;
  guest: BattleHost;
  inviterId: string;
  startsAt: string | null;
  endsAt: string | null;
  invitationExpiresAt: string;
  durationSeconds: number;
  hostScore: string;
  guestScore: string;
  winnerStreamId: string | null;
  finishReason: string | null;
  settledAt: string | null;
  createdAt: string;
  serverNow: string;
}

export interface BattleState { battle: BattleView | null; serverNow: string; }
export interface BattleInvitations { items: BattleView[]; serverNow: string; }
export interface StreamLikes { total: string; serverNow: string; }
export interface LikeResult extends StreamLikes { acceptedCount: number; }

/** A safe ratio even when scores exceed JavaScript's exact integer range. */
export function battleHostPercent(battle: Pick<BattleView, 'hostScore' | 'guestScore'>): number {
  try {
    const host = BigInt(battle.hostScore); const guest = BigInt(battle.guestScore);
    return host + guest > 0n ? Number(host * 10_000n / (host + guest)) / 100 : 50;
  } catch { return 50; }
}

export function battleOpponent(battle: BattleView | null, streamId: string | null | undefined): BattleHost | null {
  if (!battle || !streamId) return null;
  if (battle.host.streamId === streamId) return battle.guest;
  if (battle.guest.streamId === streamId) return battle.host;
  return null;
}
