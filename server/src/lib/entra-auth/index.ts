/**
 * @malco/entra-auth (TypeScript port) — shared Microsoft Entra ID (Azure AD)
 * OIDC auth for the Budget LV fleet, ported to TypeScript for Montr.
 *
 * This is a faithful port of the canonical JS module
 * (`malco-portal/lib/entra-auth/index.js`, commit de9ad7a) and enforces the
 * same contract (SSO_MASTER_PLAN.md §B) so every fleet copy behaves identically:
 *   1. State check fails CLOSED (rejects when no pending auth / missing state / missing code).
 *   2. Session regenerated BEFORE onUser grants identity (anti session-fixation; no-op for stateless apps).
 *   3. oid is the primary identity key (onUser binds it); email is a match hint only.
 *   4. JIT guest/domain guard — reject #EXT# UPNs and non-allowed email domains.
 *   5. returnTo open-redirect sanitizer (same-origin relative paths only).
 *   6. POST logout with id_token_hint + post_logout_redirect_uri.
 *   7. response_mode=query + PKCE S256 (avoids form_post vs global-CSRF 403s).
 *   8. State is single-use (deleted before token exchange).
 *   9. claims shape: { oid, email(lowercased), name, roles }.
 *  10. onUser may throw to deny (e.g. empty roles / not provisioned) -> rendered 403.
 *
 * Montr is a stateless (Bearer-JWT) app, so it passes `signedCookieStateStore`
 * for the PKCE state carrier. Two TS-port-only additions, both preserving the
 * contract above:
 *   - Denial logs carry a fixed structured `event` code (SsoDeniedEvent) so the
 *     observability Loki rules can match them by name.
 *   - `onUser` may RETURN a redirect URL; if it does, the callback redirects
 *     there instead of `returnTo`. Montr uses this for the SPA fragment handoff
 *     (`/#sso_token=<jwt>`), since it has no cookie session to set.
 */

import express, { Request, Response, NextFunction, Router } from 'express';
import * as msal from '@azure/msal-node';

const MS_LOGIN = 'https://login.microsoftonline.com';

/** Fixed event codes emitted on the denial paths (for Loki/Grafana auth rules). */
export const SsoDeniedEvent = {
  STATE: 'SSO_LOGIN_DENIED_STATE',
  ENTRA_ERROR: 'SSO_LOGIN_DENIED_ENTRA_ERROR',
  TOKEN_EXCHANGE: 'SSO_LOGIN_DENIED_TOKEN_EXCHANGE',
  GUEST_OR_DOMAIN: 'SSO_LOGIN_DENIED_GUEST',
  ON_USER: 'SSO_LOGIN_DENIED',
} as const;

/** Emitted on a successful sign-in (for the auth success/denied dashboard). */
export const SSO_LOGIN_SUCCESS = 'SSO_LOGIN_SUCCESS';

export interface EntraClaims {
  oid: string;
  /** preferred_username || email, lowercased. */
  email: string;
  name?: string;
  roles: string[];
}

export interface SsoLogger {
  warn(obj: unknown, msg?: string): void;
  error(obj: unknown, msg?: string): void;
  info?(obj: unknown, msg?: string): void;
}

/** Persisted between /login and /callback. */
export interface PendingAuth {
  state: string;
  verifier: string;
  returnTo: string;
}

export interface StateStore {
  save(req: Request, res: Response, data: PendingAuth): Promise<void>;
  /** Single-use: returns the pending data and removes it. */
  take(req: Request, res: Response): Promise<PendingAuth | null>;
}

/**
 * onUser establishes the app's native session/JWT. It may:
 *  - throw to deny (e.g. empty roles / not provisioned); a `publicMessage`
 *    property on the thrown error is shown to the user, else "Access denied.".
 *  - return a string redirect URL to override the post-login redirect target
 *    (used for the stateless SPA fragment handoff); return void/undefined to
 *    fall back to the sanitized `returnTo`.
 */
export type OnUser = (
  claims: EntraClaims,
  req: Request,
  res: Response,
  tokenResponse: msal.AuthenticationResult
) => Promise<void | string> | void | string;

export interface CreateEntraAuthOptions {
  tenantId: string;
  clientId: string;
  clientSecret: string;
  redirectUri: string;
  scopes?: string[];
  postLogoutRedirectUri?: string;
  allowedDomains?: string[];
  stateStore?: StateStore;
  sessionCookieName?: string;
  onUser: OnUser;
  logger?: SsoLogger;
}

/** Same-origin relative paths only. Blocks //evil.com, /\evil, absolute URLs. */
export function sanitizeReturnTo(value: unknown): string {
  if (typeof value !== 'string' || value.length === 0) return '/';
  if (!/^\/(?!\/)/.test(value)) return '/'; // must start with exactly one '/'
  if (value.includes('\\')) return '/';
  return value;
}

export function domainAllowed(email: string, allowedDomains?: string[]): boolean {
  if (!allowedDomains || allowedDomains.length === 0) return true; // guard disabled
  const at = email.lastIndexOf('@');
  if (at === -1) return false;
  const domain = email.slice(at + 1).toLowerCase();
  return allowedDomains.some((d) => domain === String(d).toLowerCase());
}

/**
 * State store for STATELESS apps (JWT-only, no express-session).
 * Stores {state, verifier, returnTo} in a short-lived, signed, single-use
 * cookie. The HMAC is typed (`oidc-state.` prefix) so the value can never be
 * replayed as a bearer token.
 */
export function signedCookieStateStore(opts: {
  secret: string;
  secure?: boolean;
  maxAgeMs?: number;
  cookieName?: string;
}): StateStore {
  const { secret, secure = true, maxAgeMs = 600000, cookieName = 'oidc_state' } = opts;
  const crypto = require('crypto') as typeof import('crypto');

  const sign = (payload: PendingAuth): string => {
    const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
    const ts = Date.now();
    const mac = crypto
      .createHmac('sha256', secret)
      .update(`oidc-state.${body}.${ts}`)
      .digest('base64url');
    return `${body}.${ts}.${mac}`;
  };

  const verify = (token: unknown): PendingAuth | null => {
    if (typeof token !== 'string') return null;
    const parts = token.split('.');
    if (parts.length !== 3) return null;
    const [body, ts, mac] = parts;
    const expected = crypto
      .createHmac('sha256', secret)
      .update(`oidc-state.${body}.${ts}`)
      .digest('base64url');
    const a = Buffer.from(mac);
    const b = Buffer.from(expected);
    if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
    if (Date.now() - Number(ts) > maxAgeMs) return null;
    try {
      return JSON.parse(Buffer.from(body, 'base64url').toString('utf8')) as PendingAuth;
    } catch {
      return null;
    }
  };

  return {
    async save(_req: Request, res: Response, data: PendingAuth): Promise<void> {
      res.cookie(cookieName, sign(data), {
        httpOnly: true,
        sameSite: 'lax',
        secure,
        maxAge: maxAgeMs,
        signed: false,
      });
    },
    async take(req: Request, res: Response): Promise<PendingAuth | null> {
      const cookies = (req as Request & { cookies?: Record<string, string> }).cookies;
      const token = cookies ? cookies[cookieName] : undefined;
      res.clearCookie(cookieName);
      return verify(token);
    },
  };
}

/** Default state store backed by express-session (used by the session apps). */
export const sessionStateStore: StateStore = {
  async save(req: Request, _res: Response, data: PendingAuth): Promise<void> {
    const r = req as Request & {
      session?: Record<string, unknown> & { save?: (cb: (err?: unknown) => void) => void };
    };
    if (!r.session) throw new Error('sessionStateStore requires express-session');
    r.session.entraAuth = data;
    await new Promise<void>((resolve, reject) => {
      if (typeof r.session!.save === 'function') {
        r.session!.save((err?: unknown) =>
          err ? reject(err instanceof Error ? err : new Error(String(err))) : resolve()
        );
      } else {
        resolve();
      }
    });
  },
  async take(req: Request): Promise<PendingAuth | null> {
    const r = req as Request & { session?: Record<string, unknown> };
    const data = r.session ? (r.session.entraAuth as PendingAuth | undefined) : undefined;
    if (data && r.session) delete r.session.entraAuth;
    return data || null;
  },
};

interface IdTokenClaims {
  oid?: string;
  preferred_username?: string;
  email?: string;
  name?: string;
  roles?: string[];
}

export function createEntraAuth(opts: CreateEntraAuthOptions): Router {
  const {
    tenantId,
    clientId,
    clientSecret,
    redirectUri,
    scopes = ['openid', 'profile', 'email'],
    postLogoutRedirectUri,
    allowedDomains = ['budgetlasvegas.com'],
    stateStore = sessionStateStore,
    sessionCookieName = 'connect.sid',
    onUser,
    logger = console as unknown as SsoLogger,
  } = opts;

  if (!tenantId || !clientId || !clientSecret || !redirectUri) {
    throw new Error('createEntraAuth: tenantId, clientId, clientSecret, redirectUri are required');
  }
  if (typeof onUser !== 'function') {
    throw new Error('createEntraAuth: onUser callback is required');
  }

  const cca = new msal.ConfidentialClientApplication({
    auth: { clientId, clientSecret, authority: `${MS_LOGIN}/${tenantId}` },
  });
  const cryptoProvider = new msal.CryptoProvider();
  const router = express.Router();

  const denyError = (res: Response, status: number, message: string): void => {
    if (typeof res.render === 'function' && res.app && res.app.get('views')) {
      res
        .status(status)
        .render(
          'error',
          { message, error: {}, title: 'Sign-in error' },
          (err: Error | null, html?: string) => {
            if (err || typeof html !== 'string') {
              res.type('text/plain').send(message);
              return;
            }
            res.send(html);
          }
        );
      return;
    }
    res.status(status).type('text/plain').send(message);
  };

  // GET <base>/login
  router.get('/login', async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const { verifier, challenge } = await cryptoProvider.generatePkceCodes();
      const state = cryptoProvider.createNewGuid();
      const returnTo = sanitizeReturnTo(req.query && req.query.returnTo);
      await stateStore.save(req, res, { state, verifier, returnTo });
      const url = await cca.getAuthCodeUrl({
        scopes,
        redirectUri,
        responseMode: 'query',
        codeChallenge: challenge,
        codeChallengeMethod: 'S256',
        state,
      });
      res.redirect(url);
    } catch (err) {
      next(err);
    }
  });

  // GET <base>/callback
  router.get(
    '/callback',
    async (req: Request, res: Response, next: NextFunction): Promise<void> => {
      let pending: PendingAuth | null;
      try {
        pending = await stateStore.take(req, res); // single-use
      } catch (err) {
        next(err);
        return;
      }

      const q = (req.query || {}) as Record<string, unknown>;

      // Entra returned an explicit error (e.g. consent denied)
      if (q.error) {
        logger.warn(
          { event: SsoDeniedEvent.ENTRA_ERROR, error: q.error, desc: q.error_description },
          'Entra returned an auth error'
        );
        denyError(res, 403, 'Sign-in was cancelled or denied.');
        return;
      }

      // (1)(8) State check fails CLOSED.
      if (
        !pending ||
        typeof q.state !== 'string' ||
        q.state.length === 0 ||
        q.state !== pending.state ||
        typeof q.code !== 'string' ||
        q.code.length === 0
      ) {
        logger.warn(
          {
            event: SsoDeniedEvent.STATE,
            hasPending: Boolean(pending),
            hasState: Boolean(q.state),
            hasCode: Boolean(q.code),
          },
          'OIDC callback rejected: state/code validation failed'
        );
        denyError(res, 403, 'Sign-in could not be verified. Please try signing in again.');
        return;
      }

      const { verifier, returnTo } = pending;

      let tokenResponse: msal.AuthenticationResult;
      try {
        tokenResponse = await cca.acquireTokenByCode({
          code: q.code,
          scopes,
          redirectUri,
          codeVerifier: verifier,
        });
      } catch (err) {
        logger.error(
          {
            event: SsoDeniedEvent.TOKEN_EXCHANGE,
            err: err instanceof Error ? err.message : String(err),
          },
          'Token exchange failed'
        );
        denyError(res, 403, 'Sign-in failed during token exchange. Please try again.');
        return;
      }

      const c = (tokenResponse.idTokenClaims || {}) as IdTokenClaims;
      const email = String(c.preferred_username || c.email || '').toLowerCase();
      const claims: EntraClaims = {
        oid: c.oid || '',
        email,
        name: c.name,
        roles: Array.isArray(c.roles) ? c.roles : [],
      };

      // (4) JIT guest / domain guard.
      if (email.includes('#ext#') || !domainAllowed(email, allowedDomains)) {
        logger.warn(
          { event: SsoDeniedEvent.GUEST_OR_DOMAIN, email },
          'Denied sign-in: guest account or disallowed email domain'
        );
        denyError(res, 403, 'This account is not permitted to sign in.');
        return;
      }

      const finish = (): void => {
        Promise.resolve()
          .then(() => onUser(claims, req, res, tokenResponse)) // (3)(9)(10)
          .then((redirectOverride) => {
            // (6) keep the id_token for a clean front-channel logout (session apps)
            const r = req as Request & {
              session?: Record<string, unknown> & { save?: (cb: (err?: unknown) => void) => void };
            };
            if (r.session) r.session.idTokenHint = tokenResponse.idToken;
            if (logger.info) {
              logger.info({ event: SSO_LOGIN_SUCCESS, email }, 'SSO login succeeded');
            }
            const target =
              typeof redirectOverride === 'string' && redirectOverride.length > 0
                ? redirectOverride
                : returnTo || '/';
            if (r.session && typeof r.session.save === 'function') {
              r.session.save((err?: unknown) => (err ? next(err) : res.redirect(target)));
            } else {
              res.redirect(target);
            }
          })
          .catch((err: Error & { publicMessage?: string }) => {
            // onUser throws to deny (e.g. empty roles / not provisioned)
            logger.warn(
              { event: SsoDeniedEvent.ON_USER, err: err && err.message, email },
              'onUser denied sign-in'
            );
            denyError(res, 403, (err && err.publicMessage) || 'Access denied.');
          });
      };

      // (2) Regenerate the session before granting privileges (anti-fixation).
      const r = req as Request & {
        session?: { regenerate?: (cb: (err?: unknown) => void) => void };
      };
      if (r.session && typeof r.session.regenerate === 'function') {
        r.session.regenerate((err?: unknown) => (err ? next(err) : finish()));
      } else {
        finish();
      }
    }
  );

  // POST <base>/logout  (POST so third parties can't force-logout)
  router.post('/logout', (req: Request, res: Response, next: NextFunction): void => {
    const r = req as Request & {
      session?: { idTokenHint?: string; destroy?: (cb: (err?: unknown) => void) => void };
    };
    const idTokenHint = r.session && r.session.idTokenHint;
    const params = new URLSearchParams();
    if (postLogoutRedirectUri) params.set('post_logout_redirect_uri', postLogoutRedirectUri);
    if (idTokenHint) params.set('id_token_hint', idTokenHint);
    const dest = `${MS_LOGIN}/${tenantId}/oauth2/v2.0/logout?${params.toString()}`;

    if (r.session && typeof r.session.destroy === 'function') {
      r.session.destroy((err?: unknown) => {
        if (err) {
          next(err);
          return;
        }
        res.clearCookie(sessionCookieName);
        res.redirect(dest);
      });
    } else {
      res.redirect(dest);
    }
  });

  return router;
}
