/**
 * Microsoft Entra ID SSO routes for Montr.
 *
 * Wires the vendored `@malco/entra-auth` module (TS port) to Montr's stateless
 * Bearer-JWT auth. The `onUser` callback:
 *   - resolves the app user by Entra `oid` (primary key), falling back to an
 *     email match on first login and binding the `oid` then (§B(3));
 *   - denies an email match that already carries a different `oid`;
 *   - denies when no Montr account exists (no JIT — admin provisions first);
 *   - maps the Entra app roles to Montr's native role and denies on empty (§B(10));
 *   - keeps the native role in sync with the Entra group assignment;
 *   - mints Montr's existing JWT and hands it to the SPA via a URL fragment
 *     (`/#sso_token=<jwt>`) so the token never reaches server logs / Cloudflare.
 */

import { Router } from 'express';
import {
  createEntraAuth,
  signedCookieStateStore,
  EntraClaims,
  SsoLogger,
} from '../../lib/entra-auth';
import { mapEntraRoles } from '../../lib/entra-auth/role-map';
import { config } from '../../config/config';
import { getDatabase } from '../../database/connection';
import { generateToken } from '../middleware/jwt-auth';
import { getLogger } from '../../utils/logger';

function denied(publicMessage: string): Error & { publicMessage: string } {
  const err = new Error(publicMessage) as Error & { publicMessage: string };
  err.publicMessage = publicMessage;
  return err;
}

export function createMontrEntraRouter(): Router {
  const e = config.auth.entra;
  const winston = getLogger();
  // Adapt winston to the module's (obj, msg) logger shape.
  const ssoLogger: SsoLogger = {
    warn: (obj, msg) => winston.warn(msg || 'sso', { sso: obj }),
    error: (obj, msg) => winston.error(msg || 'sso', { sso: obj }),
    info: (obj, msg) => winston.info(msg || 'sso', { sso: obj }),
  };

  return createEntraAuth({
    tenantId: e.tenantId!,
    clientId: e.clientId!,
    clientSecret: e.clientSecret!,
    redirectUri: e.redirectUri!,
    postLogoutRedirectUri: e.postLogoutRedirectUri,
    allowedDomains: e.allowedDomains,
    logger: ssoLogger,
    stateStore: signedCookieStateStore({
      secret: e.stateSecret,
      secure: config.server.environment === 'production',
    }),
    onUser: async (claims: EntraClaims): Promise<string> => {
      const db = await getDatabase();

      // (3) oid is the primary identity key; email is a first-login hint only.
      let user = await db.getUserByEntraOid(claims.oid);
      if (!user) {
        const byEmail = await db.getUserByEmail(claims.email);
        if (byEmail) {
          if (byEmail.entra_oid && byEmail.entra_oid !== claims.oid) {
            // This email is already bound to a DIFFERENT Entra identity.
            throw denied('This account is already linked to a different Microsoft user.');
          }
          await db.setUserEntraOid(byEmail.id, claims.oid);
          user = await db.getUserById(byEmail.id);
        }
      }

      if (!user) {
        // No JIT provisioning — an admin must create the Montr account first.
        throw denied(
          'No Montr account is linked to this Microsoft user. Contact an administrator.'
        );
      }

      // (10) Deny when no assigned Entra app role maps to a Montr role.
      const role = mapEntraRoles(claims.roles);
      if (!role) {
        throw denied('Your account has no Montr role assigned. Contact an administrator.');
      }

      // Entra group assignment is the source of truth — keep the native role in sync.
      if (user.role !== role) {
        await db.updateUser(user.id, { role });
      }

      const token = generateToken({ userId: user.id, username: user.username, role }, e.jwtExpiry);
      // SPA fragment handoff (overrides the module's default returnTo redirect).
      return `/#sso_token=${encodeURIComponent(token)}`;
    },
  });
}
