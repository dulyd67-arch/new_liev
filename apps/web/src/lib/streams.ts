export interface LiveStream {
  id: string; title: string; category: string | null;
  status: 'SCHEDULED' | 'LIVE' | 'ENDED' | 'TERMINATED';
  creator: { id: string; username: string; displayName: string };
  viewerCount: number | null; mediaAvailable: boolean; publisherConnected: boolean;
  startedAt: string | null; endedAt: string | null; createdAt: string;
}
export interface StreamMessage {
  id: string; body: string; createdAt: string;
  sender: { id: string; username: string; displayName: string };
}
export interface StreamToken { token: string; url: string; }
