/**
 * Self-hosted proof-of-work captcha for registration, using the ALTCHA protocol
 * (https://altcha.org/docs/server-integration): no third-party service, no tracking.
 *
 * The server issues `{ algorithm, challenge, maxnumber, salt, signature }` where
 * `challenge = SHA-256(salt + secretNumber)` and `signature = HMAC-SHA-256(key, challenge)`. The
 * browser finds the number by brute force and sends back base64(JSON `{ algorithm, challenge,
 * number, salt, signature }`). The salt carries an expiry; each solution is accepted only once.
 */
import { createHash, createHmac, randomBytes, randomInt, timingSafeEqual } from 'node:crypto';

export interface Challenge {
  algorithm: 'SHA-256';
  challenge: string;
  maxnumber: number;
  salt: string;
  signature: string;
}

const sha256 = (s: string) => createHash('sha256').update(s).digest('hex');

export class Captcha {
  /** Signatures of solutions already used → their expiry (ms). */
  private readonly used = new Map<string, number>();

  constructor(
    /** Upper bound of the secret number - the work the browser has to do (on average half of it). */
    private readonly maxNumber: number,
    private readonly ttlMs = 10 * 60_000,
    private readonly now: () => number = Date.now,
    /** HMAC key; a random key per process means challenges do not survive a restart (harmless). */
    private readonly key: Buffer = randomBytes(32),
  ) {}

  create(): Challenge {
    const expires = Math.floor((this.now() + this.ttlMs) / 1000);
    const salt = `${randomBytes(12).toString('hex')}?expires=${expires}`;
    const challenge = sha256(salt + randomInt(0, this.maxNumber + 1));
    return { algorithm: 'SHA-256', challenge, maxnumber: this.maxNumber, salt, signature: this.sign(challenge) };
  }

  private sign(challenge: string): string {
    return createHmac('sha256', this.key).update(challenge).digest('hex');
  }

  /** Verifies (and consumes) a solution payload; false for anything malformed, expired, wrong or reused. */
  verify(payload: unknown): boolean {
    if (typeof payload !== 'string' || payload.length > 2000) return false;
    let p: { algorithm?: unknown; challenge?: unknown; number?: unknown; salt?: unknown; signature?: unknown };
    try {
      p = JSON.parse(Buffer.from(payload, 'base64').toString('utf8'));
    } catch {
      return false;
    }
    if (p === null || typeof p !== 'object') return false;
    const { algorithm, challenge, number, salt, signature } = p;
    if (algorithm !== 'SHA-256' || typeof challenge !== 'string' || typeof salt !== 'string' || typeof signature !== 'string') return false;
    if (typeof number !== 'number' || !Number.isInteger(number) || number < 0 || number > this.maxNumber) return false;

    const expires = Number(/[?&]expires=(\d+)/.exec(salt)?.[1]);
    const t = this.now();
    if (!Number.isFinite(expires) || expires * 1000 < t) return false;

    const expected = Buffer.from(this.sign(challenge), 'hex');
    const given = Buffer.from(signature, 'hex');
    if (given.length !== expected.length || !timingSafeEqual(given, expected)) return false;
    if (sha256(salt + number) !== challenge) return false;

    this.sweep(t);
    if (this.used.has(signature)) return false;
    this.used.set(signature, expires * 1000);
    return true;
  }

  private sweep(t: number): void {
    for (const [sig, expiry] of this.used) if (expiry < t) this.used.delete(sig);
  }
}
