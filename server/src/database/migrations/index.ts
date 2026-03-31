/**
 * Migration registry
 * All migrations must be imported and listed here in order.
 */

import { Migration } from './types';
import { migration as m001 } from './001_initial_schema';
import { migration as m002 } from './002_add_thumbnail_status';
import { migration as m003 } from './003_client_groups';
import { migration as m004 } from './004_schedules';
import { migration as m005 } from './005_client_playlists';

export const migrations: Migration[] = [m001, m002, m003, m004, m005];
