import { Injectable, OnModuleInit, ServiceUnavailableException } from '@nestjs/common';
import { AccessToken, RoomServiceClient, type ParticipantInfo } from 'livekit-server-sdk';
import { EnvironmentValidationError, isPublicHostname, isUnsafeProductionSecret } from '../config';

export interface RoomPresence {
  viewerCount: number;
  publisherConnected: boolean;
  publisherHasTracks: boolean;
}

/** The secret remains server-side; clients receive only narrowly scoped tokens. */
@Injectable()
export class LiveKitService implements OnModuleInit {
  onModuleInit(): void {
    // Public deployments must fail at boot, rather than accepting accounts with
    // a media setup that can only connect back to the developer's computer.
    if (process.env.NODE_ENV === 'production') this.configuration();
  }

  private configuration() {
    const url = process.env.LIVEKIT_URL?.trim();
    const key = process.env.LIVEKIT_API_KEY?.trim();
    const secret = process.env.LIVEKIT_API_SECRET?.trim();
    const apiUrl = process.env.LIVEKIT_API_URL?.trim() || url?.replace(/^ws/, 'http');
    const production = process.env.NODE_ENV === 'production';
    const invalid = new Set<string>();
    if (!url) invalid.add('LIVEKIT_URL');
    if (!key) invalid.add('LIVEKIT_API_KEY');
    if (!secret) invalid.add('LIVEKIT_API_SECRET');
    if (!apiUrl) invalid.add('LIVEKIT_API_URL');
    try {
      const publicUrl = new URL(url ?? '');
      if (!['ws:', 'wss:'].includes(publicUrl.protocol) || publicUrl.username || publicUrl.password || publicUrl.search || publicUrl.hash
        || (production && (publicUrl.protocol !== 'wss:' || !isPublicHostname(publicUrl.hostname)))) invalid.add('LIVEKIT_URL');
    } catch { invalid.add('LIVEKIT_URL'); }
    try {
      const managementUrl = new URL(apiUrl ?? '');
      if (!['http:', 'https:'].includes(managementUrl.protocol) || managementUrl.username || managementUrl.password || managementUrl.search || managementUrl.hash
        || (production && managementUrl.protocol === 'http:' && isPublicHostname(managementUrl.hostname))) invalid.add('LIVEKIT_API_URL');
    } catch { invalid.add('LIVEKIT_API_URL'); }
    if (production && (key?.toLowerCase() === 'devkey' || /^(?:dev|test|example|sample|placeholder)(?:[_ -]|$)/i.test(key ?? ''))) invalid.add('LIVEKIT_API_KEY');
    if (production && isUnsafeProductionSecret(secret ?? '')) invalid.add('LIVEKIT_API_SECRET');
    if (invalid.size) {
      if (production) throw new EnvironmentValidationError([...invalid]);
      throw new ServiceUnavailableException('Live streaming configuration is invalid or missing.');
    }
    return { url: url!, key: key!, secret: secret!, apiUrl: apiUrl! };
  }

  configured(): boolean {
    try { this.configuration(); return true; } catch { return false; }
  }

  private client(): RoomServiceClient {
    const { apiUrl, key, secret } = this.configuration();
    return new RoomServiceClient(apiUrl, key, secret, { requestTimeout: 5, failover: false });
  }

  async createRoom(name: string): Promise<void> {
    await this.client().createRoom({ name, emptyTimeout: 120, departureTimeout: 60, maxParticipants: 100 });
  }

  async deleteRoom(name: string): Promise<void> {
    try { await this.client().deleteRoom(name); }
    catch (error) { if (!this.isMissing(error)) throw error; }
  }

  private isMissing(error: unknown): boolean {
    const value = error as { code?: unknown; status?: unknown; statusCode?: unknown };
    return value?.code === 'not_found' || value?.status === 404 || value?.statusCode === 404;
  }

  async rooms(names: string[]): Promise<Set<string>> {
    if (!names.length) return new Set();
    const rooms = await this.client().listRooms(names);
    return new Set(rooms.map(room => room.name));
  }

  async participants(name: string): Promise<ParticipantInfo[]> {
    return this.client().listParticipants(name);
  }

  async presence(name: string, creatorId: string): Promise<RoomPresence> {
    const participants = await this.participants(name);
    const publisher = participants.find(participant => participant.identity === creatorId);
    return {
      viewerCount: participants.filter(participant => participant.identity !== creatorId).length,
      publisherConnected: !!publisher,
      publisherHasTracks: !!publisher?.tracks.some(track => !track.muted),
    };
  }

  async token(room: string, identity: string, name: string, publish: boolean): Promise<{ token: string; url: string }> {
    const configuration = this.configuration();
    const token = new AccessToken(configuration.key, configuration.secret, {
      identity, name, ttl: publish ? '15m' : '10m',
    });
    token.addGrant({
      room, roomJoin: true, canSubscribe: true, canPublish: publish,
      canPublishData: false, canUpdateOwnMetadata: false,
    });
    return { token: await token.toJwt(), url: configuration.url };
  }
}
