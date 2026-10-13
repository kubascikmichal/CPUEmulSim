/**
 * Fastify application: authentication + sessions, the account file store, health probes and
 * session-gated static hosting of the web client. The emulator itself runs in the browser.
 */
import cookie from '@fastify/cookie';
import helmet from '@fastify/helmet';
import fastifyStatic from '@fastify/static';
import Fastify, { type FastifyReply, type FastifyRequest } from 'fastify';
import { resolve } from 'node:path';
import type { LocalAccounts } from './accounts.ts';
import { ADMIN_ROLE } from './admin.ts';
import { primaryRole, registerAdminRoutes } from './admin-api.ts';
import { Captcha } from './captcha.ts';
import { isLdapEnabled, type Config } from './config.ts';
import { FileStore, FileStoreError } from './files.ts';
import type { AuthResult } from './ldap.ts';
import { RateLimiter, SessionStore, type SessionData } from './sessions.ts';

export interface Authenticator {
  authenticate(username: string, password: string): Promise<AuthResult>;
  check(): Promise<boolean>;
}

export interface AppOptions {
  config: Config;
  authenticator: Authenticator;
  /** Local accounts (`auth.mode: local`): self-registration and user management. */
  accounts?: LocalAccounts;
  now?: () => number;
  logger?: boolean;
}

const CSRF_HEADER = 'x-requested-with';
/** Oversized uploads up to this size are read to the end before the 413 (see rejectOversizedUpload). */
const MAX_DRAIN_BYTES = 64 * 1024 * 1024;
const CSRF_VALUE = 'cpuemul';

declare module 'fastify' {
  interface FastifyRequest {
    session: (SessionData & { id: string }) | null;
  }
}

export async function buildApp({ config, authenticator, accounts, now = Date.now, logger = true }: AppOptions) {
  const app = Fastify({
    logger: logger ? { level: 'info', redact: ['req.headers.cookie', 'req.headers.authorization'] } : false,
    trustProxy: config.server.trustProxy,
    bodyLimit: config.files.maxFileBytes + 1024,
  });

  const sessions = new SessionStore(config.session.idleTimeoutMin * 60_000, config.session.absoluteTimeoutHours * 3_600_000, now);
  const ipLimiter = new RateLimiter(config.security.loginRateLimit.perIpPerMin, 60_000, now);
  const userLimiter = new RateLimiter(config.security.loginRateLimit.perUserPerMin, 60_000, now);
  const files = new FileStore(config.files.dataDir, config.files);
  const local = config.auth.mode === 'local' && accounts !== undefined;
  const registration = local && config.auth.allowRegistration;
  const captcha = registration && config.security.captcha.enabled ? new Captcha(config.security.captcha.maxNumber, undefined, now) : null;
  const sweep = setInterval(() => sessions.sweep(), 60_000);
  app.addHook('onClose', async () => clearInterval(sweep));

  await app.register(cookie);
  await app.register(helmet, {
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        scriptSrc: ["'self'"],
        // emotion (MUI) and CodeMirror inject <style> elements
        styleSrc: ["'self'", "'unsafe-inline'"],
        imgSrc: ["'self'", 'data:'],
        connectSrc: ["'self'"],
        frameAncestors: ["'none'"],
        objectSrc: ["'none'"],
        baseUri: ["'self'"],
        formAction: ["'self'"],
      },
    },
    crossOriginOpenerPolicy: { policy: 'same-origin' },
  });
  await app.register(fastifyStatic, { root: resolve(config.server.publicDir), serve: false });

  app.addContentTypeParser(['text/plain', 'application/octet-stream'], { parseAs: 'buffer' }, (_req, body, done) => done(null, body));

  // ---------------------------------------------------------------- session resolution + CSRF

  const setSessionCookie = (reply: FastifyReply, id: string) =>
    reply.setCookie(config.session.cookieName, id, {
      httpOnly: true,
      secure: config.session.secureCookie,
      sameSite: 'strict',
      path: '/',
    });

  app.decorateRequest('session', null);
  app.addHook('onRequest', async (req, reply) => {
    if (req.url.startsWith('/api/') && !['GET', 'HEAD'].includes(req.method) && req.headers[CSRF_HEADER] !== CSRF_VALUE) {
      return reply.code(403).send({ error: 'csrf' });
    }
    const id = req.cookies[config.session.cookieName];
    const data = sessions.get(id);
    req.session = data && id ? { ...data, id } : null;
    // auth.mode none: no login, every request without a valid session gets one as the local user
    if (req.session === null && config.auth.mode === 'none' && req.url !== '/api/auth/logout') {
      const username = config.auth.localUser;
      const created = sessions.create({ username, displayName: username, roles: ['user'] });
      setSessionCookie(reply, created.id);
      req.session = { ...created.data, id: created.id };
    }
  });

  const requireApiSession = async (req: FastifyRequest, reply: FastifyReply) => {
    if (req.session === null) return reply.code(401).send({ error: 'unauthenticated' });
  };

  const sessionInfo = (s: SessionData) => ({
    user: { username: s.username, displayName: s.displayName, role: primaryRole(s.roles) },
    session: { idleTimeoutSec: sessions.idleTimeoutSec, absoluteExpiresAt: sessions.absoluteExpiry(s).toISOString() },
  });

  // ---------------------------------------------------------------- auth API

  app.post('/api/auth/login', async (req, reply) => {
    const body = (req.body ?? {}) as { username?: unknown; password?: unknown };
    const username = typeof body.username === 'string' ? body.username.trim() : '';
    const password = typeof body.password === 'string' ? body.password : '';
    const ip = req.ip;

    if (!ipLimiter.attempt(ip) || (username !== '' && !userLimiter.attempt(username.toLowerCase()))) {
      req.log.warn({ event: 'login', user: username, ip, result: 'rate_limited' });
      return reply.code(429).send({ error: 'rate_limited' });
    }
    if (username === '' || password === '') {
      req.log.info({ event: 'login', user: username, ip, result: 'invalid_credentials', reason: 'empty_input' });
      return reply.code(401).send({ error: 'invalid_credentials' });
    }

    const result = await authenticator.authenticate(username, password);
    if (!result.ok) {
      req.log.info({ event: 'login', user: username, ip, result: result.error, reason: result.reason });
      const status = result.error === 'not_authorized' || result.error === 'account_disabled' ? 403 : result.error === 'directory_unavailable' ? 503 : 401;
      return reply.code(status).send({ error: result.error });
    }

    // session fixation protection: always a new id, the old session (if any) is destroyed
    sessions.destroy(req.cookies[config.session.cookieName]);
    const { id, data } = sessions.create({ username: result.username, displayName: result.displayName, roles: result.roles });
    setSessionCookie(reply, id);
    req.log.info({ event: 'login', user: result.username, ip, result: 'success', roles: result.roles });
    return sessionInfo(data);
  });

  // public: tells the login page which forms to offer
  app.get('/api/auth/config', async () => ({
    mode: config.auth.mode,
    registration,
    captcha: captcha !== null,
    ldap: isLdapEnabled(config),
  }));

  // public: proof-of-work challenge for the registration form
  app.get('/api/auth/captcha', async (_req, reply) => {
    if (captcha === null) return reply.code(404).send({ error: 'not_found' });
    return reply.header('Cache-Control', 'no-store').send(captcha.create());
  });

  app.post('/api/auth/register', async (req, reply) => {
    if (!registration) return reply.code(404).send({ error: 'not_found' });
    const body = (req.body ?? {}) as { username?: unknown; password?: unknown; name?: unknown; captcha?: unknown };
    const username = typeof body.username === 'string' ? body.username.trim() : '';
    const password = typeof body.password === 'string' ? body.password : '';
    const name = typeof body.name === 'string' ? body.name : '';
    const ip = req.ip;
    if (!ipLimiter.attempt(ip)) {
      req.log.warn({ event: 'register', user: username, ip, result: 'rate_limited' });
      return reply.code(429).send({ error: 'rate_limited' });
    }
    if (captcha !== null && !captcha.verify(body.captcha)) {
      req.log.info({ event: 'register', user: username, ip, result: 'captcha_failed' });
      return reply.code(400).send({ error: 'captcha_failed' });
    }
    const result = await accounts!.register(username, password, name);
    if (!result.ok) {
      req.log.info({ event: 'register', user: username, ip, result: result.error });
      return reply.code(result.error === 'username_taken' ? 409 : 400).send({ error: result.error });
    }
    // registration logs the new user in (fresh session id, as on login)
    sessions.destroy(req.cookies[config.session.cookieName]);
    const created = (await accounts!.find(result.username))!;
    const { id, data } = sessions.create({ username: created.username, displayName: created.name, roles: [created.role] });
    setSessionCookie(reply, id);
    req.log.info({ event: 'register', user: result.username, ip, result: 'success' });
    return reply.code(201).send(sessionInfo(data));
  });

  app.post('/api/auth/logout', async (req, reply) => {
    if (req.session) req.log.info({ event: 'logout', user: req.session.username, ip: req.ip });
    sessions.destroy(req.cookies[config.session.cookieName]);
    reply.clearCookie(config.session.cookieName, { path: '/' });
    return reply.code(204).send();
  });

  app.get('/api/auth/session', { preHandler: requireApiSession }, async (req) => sessionInfo(req.session!));

  app.post('/api/auth/keepalive', { preHandler: requireApiSession }, async (req, reply) => {
    sessions.touch(req.session!.id);
    return reply.code(204).send();
  });

  // ---------------------------------------------------------------- files API (D2)

  const fileError = (reply: FastifyReply, e: unknown) => {
    if (e instanceof FileStoreError) return reply.code(e.status).send({ error: e.code });
    throw e;
  };

  app.get('/api/files', { preHandler: requireApiSession }, async (req, reply) => {
    sessions.touch(req.session!.id);
    const ext = String((req.query as { ext?: string }).ext ?? '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
    try {
      return await files.list(req.session!.username, ext);
    } catch (e) {
      return fileError(reply, e);
    }
  });

  app.get('/api/files/:name', { preHandler: requireApiSession, exposeHeadRoute: false }, async (req, reply) => {
    sessions.touch(req.session!.id);
    try {
      const content = await files.read(req.session!.username, (req.params as { name: string }).name);
      return reply.type('text/plain; charset=utf-8').header('Cache-Control', 'no-store').send(content);
    } catch (e) {
      return fileError(reply, e);
    }
  });

  app.head('/api/files/:name', { preHandler: requireApiSession }, async (req, reply) => {
    try {
      const exists = await files.exists(req.session!.username, (req.params as { name: string }).name);
      return reply.code(exists ? 200 : 404).send();
    } catch (e) {
      return fileError(reply, e);
    }
  });

  /**
   * An upload larger than the per-file limit (by Content-Length) is drained before the 413 is sent.
   * Rejecting mid-body closes the connection, which reverse proxies that stream request bodies
   * (Apache mod_proxy - it does not apply LimitRequestBody to proxied requests) turn into a 502.
   * Absurd sizes are cut off at once.
   */
  const rejectOversizedUpload = async (req: FastifyRequest, reply: FastifyReply) => {
    const length = Number(req.headers['content-length']);
    if (!Number.isFinite(length) || length <= config.files.maxFileBytes) return;
    if (length <= MAX_DRAIN_BYTES) {
      await new Promise<void>((resolveDrain) => {
        req.raw.on('end', () => resolveDrain());
        req.raw.on('error', () => resolveDrain());
        req.raw.on('close', () => resolveDrain());
        req.raw.resume();
      });
    }
    return reply.code(413).send({ error: 'quota_exceeded' });
  };

  app.put('/api/files/:name', { onRequest: rejectOversizedUpload, preHandler: requireApiSession }, async (req, reply) => {
    sessions.touch(req.session!.id);
    const body = Buffer.isBuffer(req.body) ? req.body : Buffer.from(String(req.body ?? ''), 'utf8');
    try {
      await files.write(req.session!.username, (req.params as { name: string }).name, body);
      req.log.info({ event: 'file_write', user: req.session!.username, name: (req.params as { name: string }).name, bytes: body.length });
      return reply.code(204).send();
    } catch (e) {
      return fileError(reply, e);
    }
  });

  // ---------------------------------------------------------------- user management (teachers, admin)

  if (local) registerAdminRoutes(app, { accounts: accounts!, sessions, files });

  // ---------------------------------------------------------------- health

  app.get('/api/health', async () => ({ status: 'ok' }));
  app.get('/api/health/ready', async (_req, reply) => {
    const ok = await authenticator.check();
    return reply.code(ok ? 200 : 503).send({ status: ok ? 'ready' : 'directory_unavailable' });
  });

  // ---------------------------------------------------------------- static client (session-gated)

  const page = (file: string) => async (req: FastifyRequest, reply: FastifyReply) => {
    if (req.session === null) return reply.redirect('/login');
    return reply.header('Cache-Control', 'no-store').sendFile(file);
  };
  app.get('/', page('index.html'));
  app.get('/index.html', page('index.html'));
  app.get('/schematic', page('schematic.html'));
  app.get('/schematic.html', page('schematic.html'));

  // user management page: teachers and the admin only (others go back to the emulator)
  const adminPage = async (req: FastifyRequest, reply: FastifyReply) => {
    if (req.session === null) return reply.redirect('/login');
    const role = primaryRole(req.session.roles);
    if (!local || (role !== ADMIN_ROLE && role !== 'teacher')) return reply.redirect('/');
    return reply.header('Cache-Control', 'no-store').sendFile('admin.html');
  };
  app.get('/admin', adminPage);
  app.get('/admin.html', adminPage);

  const loginPage = async (req: FastifyRequest, reply: FastifyReply) => {
    if (req.session !== null) return reply.redirect('/');
    return reply.header('Cache-Control', 'no-store').sendFile('login.html');
  };
  app.get('/login', loginPage);
  app.get('/login.html', loginPage);

  // public: only the login page's own assets
  app.get('/login-assets/*', async (req, reply) => reply.sendFile('login-assets/' + (req.params as { '*': string })['*']));

  // gated: application bundle and icons
  for (const prefix of ['assets', 'icons']) {
    app.get(`/${prefix}/*`, async (req, reply) => {
      if (req.session === null) return reply.code(401).send({ error: 'unauthenticated' });
      return reply.sendFile(`${prefix}/` + (req.params as { '*': string })['*']);
    });
  }

  return app;
}
