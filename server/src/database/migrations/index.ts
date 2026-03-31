/**
 * Migration registry
 * All migrations must be imported and listed here in order.
 */

import { Migration } from './types';
import { migration as m001 } from './001_initial_schema';
import { migration as m002 } from './002_add_thumbnail_status';

export const migrations: Migration[] = [m001, m002];
