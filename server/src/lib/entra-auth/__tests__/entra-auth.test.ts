/**
 * Unit tests for the vendored Entra auth module's pure logic and the Montr role
 * map. These cover the security-critical, DB-free pieces: the open-redirect
 * sanitizer, the guest/domain guard, the stateless signed-cookie state carrier
 * (round-trip / tamper / single-use), and the Entra→Montr role mapping.
 */

import { Request, Response } from 'express';
import { sanitizeReturnTo, domainAllowed, signedCookieStateStore, PendingAuth } from '../index';
import { mapEntraRoles } from '../role-map';

describe('sanitizeReturnTo', () => {
  it('accepts same-origin relative paths', () => {
    expect(sanitizeReturnTo('/dashboard')).toBe('/dashboard');
    expect(sanitizeReturnTo('/a/b?c=1')).toBe('/a/b?c=1');
  });

  it('rejects protocol-relative, backslash, absolute, and empty values', () => {
    expect(sanitizeReturnTo('//evil.com')).toBe('/');
    expect(sanitizeReturnTo('/\\evil.com')).toBe('/');
    expect(sanitizeReturnTo('https://evil.com')).toBe('/');
    expect(sanitizeReturnTo('')).toBe('/');
    expect(sanitizeReturnTo(undefined)).toBe('/');
    expect(sanitizeReturnTo(42)).toBe('/');
  });
});

describe('domainAllowed', () => {
  const allowed = ['budgetlasvegas.com'];

  it('allows configured domains (case-insensitive) and blocks others', () => {
    expect(domainAllowed('alice@budgetlasvegas.com', allowed)).toBe(true);
    expect(domainAllowed('alice@BudgetLasVegas.com', allowed)).toBe(true);
    expect(domainAllowed('mallory@evil.com', allowed)).toBe(false);
    expect(domainAllowed('not-an-email', allowed)).toBe(false);
  });

  it('treats an empty allow-list as "guard disabled"', () => {
    expect(domainAllowed('anyone@anywhere.com', [])).toBe(true);
  });
});

describe('mapEntraRoles', () => {
  it('maps Entra app roles to the most-privileged native role', () => {
    expect(mapEntraRoles(['Montr.Admin'])).toBe('admin');
    expect(mapEntraRoles(['Montr.Editor'])).toBe('editor');
    expect(mapEntraRoles(['Montr.Viewer'])).toBe('viewer');
    expect(mapEntraRoles(['Montr.Viewer', 'Montr.Admin'])).toBe('admin');
    expect(mapEntraRoles(['Montr.Viewer', 'Montr.Editor'])).toBe('editor');
  });

  it('returns null when no role maps (deny-on-empty)', () => {
    expect(mapEntraRoles([])).toBeNull();
    expect(mapEntraRoles(['Some.Other.Role'])).toBeNull();
  });
});

describe('signedCookieStateStore', () => {
  const store = signedCookieStateStore({ secret: 'unit-test-secret', secure: false });
  const data: PendingAuth = { state: 'guid-123', verifier: 'pkce-verifier', returnTo: '/home' };

  // Minimal req/res doubles capturing the cookie jar.
  function makeReqRes(cookies: Record<string, string> = {}) {
    const jar: Record<string, string> = { ...cookies };
    let cleared = false;
    const res = {
      cookie: (name: string, value: string) => {
        jar[name] = value;
      },
      clearCookie: () => {
        cleared = true;
      },
    } as unknown as Response;
    const req = { cookies: jar } as unknown as Request;
    return { req, res, jar, wasCleared: () => cleared };
  }

  it('round-trips saved state and clears the cookie on take (single-use)', async () => {
    const a = makeReqRes();
    await store.save(a.req, a.res, data);
    const cookieVal = a.jar['oidc_state'];
    expect(typeof cookieVal).toBe('string');

    const b = makeReqRes({ oidc_state: cookieVal });
    const taken = await store.take(b.req, b.res);
    expect(taken).toEqual(data);
    expect(b.wasCleared()).toBe(true);
  });

  it('rejects a tampered cookie', async () => {
    const a = makeReqRes();
    await store.save(a.req, a.res, data);
    const tampered = a.jar['oidc_state'].slice(0, -2) + 'xx';

    const b = makeReqRes({ oidc_state: tampered });
    expect(await store.take(b.req, b.res)).toBeNull();
  });

  it('rejects a cookie signed with a different secret', async () => {
    const other = signedCookieStateStore({ secret: 'different-secret', secure: false });
    const a = makeReqRes();
    await other.save(a.req, a.res, data);

    const b = makeReqRes({ oidc_state: a.jar['oidc_state'] });
    expect(await store.take(b.req, b.res)).toBeNull();
  });

  it('returns null when no cookie is present', async () => {
    const b = makeReqRes();
    expect(await store.take(b.req, b.res)).toBeNull();
  });
});
