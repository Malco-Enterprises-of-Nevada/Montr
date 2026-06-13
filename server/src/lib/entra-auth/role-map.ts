/**
 * Maps Entra app-role value strings to Montr's native UserRole.
 *
 * The Entra registration `BLV - Montr` (SSO_MASTER_PLAN.md §C) defines app roles
 * `Montr.Admin` / `Montr.Editor` / `Montr.Viewer`, assigned via the
 * `SG-BLV-Montr-*` security groups. A signed-in user may carry several; we pick
 * the most privileged. Returns null when none of the roles map (caller denies —
 * "User assignment required = Yes" + deny-on-empty per §B(10)).
 */

import { UserRole } from '../../database/types';

const ENTRA_ROLE_TO_NATIVE: Record<string, UserRole> = {
  'Montr.Admin': 'admin',
  'Montr.Editor': 'editor',
  'Montr.Viewer': 'viewer',
};

// Most-privileged first so the first hit wins.
const ROLE_PRECEDENCE: UserRole[] = ['admin', 'editor', 'viewer'];

export function mapEntraRoles(entraRoles: string[]): UserRole | null {
  const native = new Set<UserRole>();
  for (const r of entraRoles) {
    const mapped = ENTRA_ROLE_TO_NATIVE[r];
    if (mapped) native.add(mapped);
  }
  for (const role of ROLE_PRECEDENCE) {
    if (native.has(role)) return role;
  }
  return null;
}
