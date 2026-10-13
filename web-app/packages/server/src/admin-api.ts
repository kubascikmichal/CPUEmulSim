/**
 * User management API (`auth.mode: local`), `/api/admin/*`.
 *
 *  - teacher: manages students only - list (with online state and storage), create, CSV import,
 *    rename, set password, enable / disable, delete (account + files),
 *  - admin (from the environment): the same for every account, and changes roles.
 *
 * Disabling, deleting or a new password logs the user out at once; a rename or role change is
 * applied to the user's open sessions.
 */
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import {
  generatePassword,
  ROLES,
  type AccountError,
  type AccountInfo,
  type LocalAccounts,
  type NewAccount,
  type Role,
} from './accounts.ts';
import { ADMIN_ROLE } from './admin.ts';
import type { FileStore } from './files.ts';
import type { SessionData, SessionStore } from './sessions.ts';

export const MAX_IMPORT_ROWS = 300;

type Actor = 'admin' | 'teacher';

const STATUS: Record<AccountError | 'forbidden' | 'invalid_role' | 'invalid_request' | 'too_many_rows', number> = {
  invalid_username: 400,
  weak_password: 400,
  invalid_name: 400,
  invalid_role: 400,
  invalid_request: 400,
  too_many_rows: 400,
  username_taken: 409,
  not_found: 404,
  forbidden: 403,
};

/** Role used by the UI: admin > teacher > student; other roles (LDAP / auth.mode none) → `user`. */
export function primaryRole(roles: string[]): string {
  for (const r of [ADMIN_ROLE, 'teacher', 'student']) if (roles.includes(r)) return r;
  return roles[0] ?? 'user';
}

export interface CsvRow {
  line: number;
  name: string;
  username: string;
}

/**
 * Parses the import file: one student per line, `name;username` (`,` or tab also accepted when the
 * line has no `;`). Optional header line, blank lines ignored, fields may be quoted ("..." with "").
 */
export function parseStudentCsv(text: string): CsvRow[] {
  const rows: CsvRow[] = [];
  const lines = text.replace(/^﻿/, '').split(/\r?\n|\r/);
  let first = true;
  lines.forEach((raw, i) => {
    if (raw.trim() === '') return;
    const sep = raw.includes(';') ? ';' : raw.includes('\t') ? '\t' : ',';
    const cells = splitCsvLine(raw, sep);
    const row = { line: i + 1, name: (cells[0] ?? '').trim(), username: (cells[1] ?? '').trim() };
    if (first && /^(name|meno|celé meno|cele meno)$/i.test(row.name) && /user|použ|pouz|login|účet|ucet/i.test(row.username)) {
      first = false;
      return; // header
    }
    first = false;
    rows.push(row);
  });
  return rows;
}

function splitCsvLine(line: string, sep: string): string[] {
  const cells: string[] = [];
  let cur = '';
  let quoted = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (quoted) {
      if (c === '"' && line[i + 1] === '"') {
        cur += '"';
        i++;
      } else if (c === '"') quoted = false;
      else cur += c;
    } else if (c === '"' && cur.trim() === '') {
      quoted = true;
      cur = '';
    } else if (c === sep) {
      cells.push(cur);
      cur = '';
    } else cur += c;
  }
  cells.push(cur);
  return cells;
}

export function registerAdminRoutes(
  app: FastifyInstance,
  deps: { accounts: LocalAccounts; sessions: SessionStore; files: FileStore },
): void {
  const { accounts, sessions, files } = deps;

  const fail = (reply: FastifyReply, error: keyof typeof STATUS) => reply.code(STATUS[error]).send({ error });

  /** Teacher or admin session, else 401/403. */
  const requireManager = async (req: FastifyRequest, reply: FastifyReply) => {
    if (req.session === null) return reply.code(401).send({ error: 'unauthenticated' });
    const role = primaryRole(req.session.roles);
    if (role !== ADMIN_ROLE && role !== 'teacher') return fail(reply, 'forbidden');
    sessions.touch(req.session.id);
  };
  const actorOf = (req: FastifyRequest): Actor => (primaryRole(req.session!.roles) === ADMIN_ROLE ? 'admin' : 'teacher');
  const canManage = (actor: Actor, target: AccountInfo) => actor === 'admin' || target.role === 'student';
  const audit = (req: FastifyRequest, event: string, target: string, extra: object = {}) =>
    req.log.info({ event, actor: req.session!.username, target, ...extra });

  /** Loads the target account if the actor may manage it (else replies 404 / 403 and returns null). */
  const target = async (req: FastifyRequest, reply: FastifyReply): Promise<AccountInfo | null> => {
    const account = await accounts.find((req.params as { username: string }).username);
    if (account === null) {
      fail(reply, 'not_found');
      return null;
    }
    if (!canManage(actorOf(req), account)) {
      fail(reply, 'forbidden');
      return null;
    }
    return account;
  };

  const view = async (a: AccountInfo) => {
    const activity = sessions.activity(a.username);
    const usage = await files.usage(a.username);
    return {
      ...a,
      online: activity.online,
      lastActivityAt: activity.lastActivity === null ? null : new Date(activity.lastActivity).toISOString(),
      fileCount: usage.files,
      storageBytes: usage.bytes,
    };
  };

  app.get('/api/admin/users', { preHandler: requireManager }, async (req) => {
    const actor = actorOf(req);
    const visible = (await accounts.list()).filter((a) => canManage(actor, a));
    return { actor, users: await Promise.all(visible.map(view)) };
  });

  app.post('/api/admin/users', { preHandler: requireManager }, async (req, reply) => {
    const body = (req.body ?? {}) as { username?: unknown; name?: unknown; password?: unknown; role?: unknown };
    const actor = actorOf(req);
    const role = body.role === undefined ? 'student' : body.role;
    if (!ROLES.includes(role as Role)) return fail(reply, 'invalid_role');
    if (actor !== 'admin' && role !== 'student') return fail(reply, 'forbidden');
    const result = await accounts.create({
      username: typeof body.username === 'string' ? body.username.trim() : '',
      name: typeof body.name === 'string' ? body.name : '',
      password: typeof body.password === 'string' ? body.password : '',
      role: role as Role,
    });
    if (!result.ok) return fail(reply, result.error);
    audit(req, 'user_create', result.value.username, { role });
    return reply.code(201).send({ user: await view(result.value) });
  });

  app.post('/api/admin/users/import', { preHandler: requireManager }, async (req, reply) => {
    const body = (req.body ?? {}) as { csv?: unknown };
    if (typeof body.csv !== 'string') return fail(reply, 'invalid_request');
    const rows = parseStudentCsv(body.csv);
    if (rows.length > MAX_IMPORT_ROWS) return fail(reply, 'too_many_rows');
    const inputs: NewAccount[] = rows.map((r) => ({ username: r.username, name: r.name, password: generatePassword(), role: 'student' }));
    const results = await accounts.createMany(inputs);
    const created: { line: number; name: string; username: string; password: string }[] = [];
    const skipped: { line: number; name: string; username: string; error: AccountError }[] = [];
    results.forEach((r, i) => {
      if (r.ok) created.push({ line: rows[i].line, name: r.value.name, username: r.value.username, password: inputs[i].password });
      else skipped.push({ line: rows[i].line, name: rows[i].name, username: rows[i].username, error: r.error });
    });
    audit(req, 'user_import', '-', { created: created.length, skipped: skipped.length });
    return { created, skipped };
  });

  app.patch('/api/admin/users/:username', { preHandler: requireManager }, async (req, reply) => {
    const current = await target(req, reply);
    if (current === null) return reply;
    const body = (req.body ?? {}) as { name?: unknown; enabled?: unknown; role?: unknown };
    if (body.enabled !== undefined && typeof body.enabled !== 'boolean') return fail(reply, 'invalid_request');
    if (body.role !== undefined) {
      if (actorOf(req) !== 'admin') return fail(reply, 'forbidden');
      if (!ROLES.includes(body.role as Role)) return fail(reply, 'invalid_role');
    }
    const result = await accounts.update(current.username, {
      ...(body.name !== undefined ? { name: body.name } : {}),
      ...(body.enabled !== undefined ? { enabled: body.enabled as boolean } : {}),
      ...(body.role !== undefined ? { role: body.role as Role } : {}),
    });
    if (!result.ok) return fail(reply, result.error);
    const updated = result.value;
    if (!updated.enabled) sessions.destroyUser(updated.username);
    else sessions.updateUser(updated.username, { displayName: updated.name, roles: [updated.role] } satisfies Partial<SessionData>);
    audit(req, 'user_update', updated.username, { name: body.name !== undefined, enabled: body.enabled, role: body.role });
    return { user: await view(updated) };
  });

  app.put('/api/admin/users/:username/password', { preHandler: requireManager }, async (req, reply) => {
    const current = await target(req, reply);
    if (current === null) return reply;
    const result = await accounts.setPassword(current.username, (req.body as { password?: unknown } | null)?.password);
    if (!result.ok) return fail(reply, result.error);
    sessions.destroyUser(current.username);
    audit(req, 'user_password', current.username);
    return reply.code(204).send();
  });

  app.delete('/api/admin/users/:username', { preHandler: requireManager }, async (req, reply) => {
    const current = await target(req, reply);
    if (current === null) return reply;
    const result = await accounts.remove(current.username);
    if (!result.ok) return fail(reply, result.error);
    sessions.destroyUser(current.username);
    await files.removeUser(current.username);
    audit(req, 'user_delete', current.username);
    return reply.code(204).send();
  });
}
