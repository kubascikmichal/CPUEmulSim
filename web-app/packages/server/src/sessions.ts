/**
 * Server-side sessions (in memory; one node) with idle and absolute expiry, plus a sliding-window
 * login rate limiter.
 */
import { randomBytes } from 'node:crypto';

export interface SessionData {
  username: string;
  displayName: string;
  roles: string[];
  createdAt: number;
  lastActivity: number;
}

export class SessionStore {
  private readonly sessions = new Map<string, SessionData>();

  constructor(
    private readonly idleMs: number,
    private readonly absoluteMs: number,
    private readonly now: () => number = Date.now,
  ) {}

  create(user: Omit<SessionData, 'createdAt' | 'lastActivity'>): { id: string; data: SessionData } {
    const id = randomBytes(32).toString('base64url');
    const t = this.now();
    const data = { ...user, createdAt: t, lastActivity: t };
    this.sessions.set(id, data);
    return { id, data };
  }

  /** Valid session or null (expired sessions are removed). */
  get(id: string | undefined): SessionData | null {
    if (!id) return null;
    const s = this.sessions.get(id);
    if (!s) return null;
    const t = this.now();
    if (t - s.lastActivity > this.idleMs || t - s.createdAt > this.absoluteMs) {
      this.sessions.delete(id);
      return null;
    }
    return s;
  }

  touch(id: string): void {
    const s = this.get(id);
    if (s) s.lastActivity = this.now();
  }

  destroy(id: string | undefined): void {
    if (id) this.sessions.delete(id);
  }

  absoluteExpiry(s: SessionData): Date {
    return new Date(s.createdAt + this.absoluteMs);
  }

  get idleTimeoutSec(): number {
    return Math.round(this.idleMs / 1000);
  }

  /** Valid sessions of a user (case-insensitive name). */
  private idsOf(username: string): string[] {
    const lower = username.toLowerCase();
    return [...this.sessions.keys()].filter((id) => this.get(id)?.username.toLowerCase() === lower);
  }

  /** Logs the user out everywhere (account disabled, deleted or password changed). */
  destroyUser(username: string): void {
    for (const id of this.idsOf(username)) this.sessions.delete(id);
  }

  /** Applies a new display name / roles to the user's open sessions (no re-login needed). */
  updateUser(username: string, patch: Partial<Pick<SessionData, 'displayName' | 'roles'>>): void {
    for (const id of this.idsOf(username)) Object.assign(this.sessions.get(id)!, patch);
  }

  /** Online = at least one valid session; `lastActivity` = the latest activity of those sessions. */
  activity(username: string): { online: boolean; lastActivity: number | null } {
    const times = this.idsOf(username).map((id) => this.sessions.get(id)!.lastActivity);
    return times.length === 0 ? { online: false, lastActivity: null } : { online: true, lastActivity: Math.max(...times) };
  }

  /** Periodic cleanup. */
  sweep(): void {
    for (const id of [...this.sessions.keys()]) this.get(id);
  }
}

export class RateLimiter {
  private readonly hits = new Map<string, number[]>();

  constructor(
    private readonly limit: number,
    private readonly windowMs: number,
    private readonly now: () => number = Date.now,
  ) {}

  /** Records an attempt; returns false when the limit is exceeded. */
  attempt(key: string): boolean {
    const t = this.now();
    const list = (this.hits.get(key) ?? []).filter((x) => t - x < this.windowMs);
    list.push(t);
    this.hits.set(key, list);
    return list.length <= this.limit;
  }
}
