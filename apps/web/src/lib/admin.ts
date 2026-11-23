export type AdminTab = 'overview' | 'users' | 'streams' | 'reports' | 'audit';
export interface AdminOverview {
  users: { total: number; active: number; suspended: number; newLast7Days: number };
  streams: { liveSessions: number; scheduledSessions: number };
  reports: { open: number; reviewing: number };
  gifts: { sentCount: number; spentDu: string; claimedDu: string };
  dailyRegistrations: Array<{ date: string; count: number }>;
  serverNow: string;
}
export interface AdminPage<T> { items: T[]; nextCursor: string | null; }
export interface AdminPerson { id: string; username: string | null; displayName: string; }
export interface AdminUser extends AdminPerson {
  email: string; status: string; createdAt: string; roles: string[]; openStreamCount: number;
}
export interface AdminStream {
  id: string; title: string; status: string; createdAt: string; startedAt: string | null; endedAt: string | null;
  creator: AdminPerson; viewerCount: number | null; mediaStatus: 'publishing' | 'offline' | 'unknown';
}
export type ReportDecision = 'REVIEWING' | 'RESOLVED' | 'DISMISSED';
export interface AdminReport {
  id: string; status: string; reasonCode: string; details: string | null; createdAt: string; resolvedAt: string | null;
  reporter: AdminPerson; target: AdminPerson | null; stream: { id: string; title: string; status: string } | null;
}
export interface AdminAudit {
  id: string; action: string; entityType: string; entityId: string | null; before: unknown; after: unknown;
  requestId: string; createdAt: string; actor: AdminPerson | null;
}
export type AdminListItem = AdminUser | AdminStream | AdminReport | AdminAudit;
export interface UserActionResult {
  user: { id: string; status: string };
  mediaCleanup: { complete: boolean; pendingStreamIds: string[] };
}
