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
import { migration as m006 } from './006_interruptions';
import { migration as m007 } from './007_playback_logs';
import { migration as m008 } from './008_notifications';
import { migration as m009 } from './009_content_approval';
import { migration as m010 } from './010_users';
import { migration as m011 } from './011_client_telemetry';
import { migration as m012 } from './012_widen_notification_events';
import { migration as m013 } from './013_advanced_scheduling';
import { migration as m014 } from './014_media_folders';

export const migrations: Migration[] = [
  m001,
  m002,
  m003,
  m004,
  m005,
  m006,
  m007,
  m008,
  m009,
  m010,
  m011,
  m012,
  m013,
  m014,
];
