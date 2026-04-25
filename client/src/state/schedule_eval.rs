//! Offline schedule evaluation.
//!
//! When the WebSocket is disconnected, the client falls back to evaluating
//! its persisted schedule definitions locally so playlist transitions still
//! fire. The selection logic here mirrors the server's `isScheduleActive` +
//! conflict resolution but trims out fields the server is authoritative for:
//!
//!   * Holiday rules require an external dataset (server uses `date-holidays`)
//!     and aren't evaluated client-side. Schedules whose `conditions` contain
//!     a holiday rule are skipped offline.
//!   * Event-triggered schedules (`event_trigger` condition) only fire on
//!     server-side notification events; offline they're skipped.
//!   * `special_dates` is honored — pure date-string matching.
//!
//! All functions are sync and side-effect free so they can be unit-tested
//! without spinning a tokio runtime.
//!
//! Tie-breaking matches the server (`conflict-resolver.ts`): higher
//! `priority` wins, ties broken by lower `id`.

use crate::network::Schedule;
use chrono::{DateTime, Datelike, NaiveTime, TimeZone, Timelike};
use chrono_tz::Tz;
use cron::Schedule as CronSchedule;
use std::str::FromStr;

/// Pick the schedule that should be active right now from the persisted
/// set, or `None` if no schedule applies. Pure: takes everything by
/// reference and depends only on `now`.
///
/// Filters in order:
///   1. `enabled == true`
///   2. `days_of_week` matches `now`'s weekday (Sunday = 0 to match server)
///   3. holiday/event conditions (skip — server-only)
///   4. `special_dates` matches today (when set)
///   5. cron — fired in the last 60 seconds in the schedule's tz
///      OR start/end-time window contains `now`
///
/// Tie-break: highest `priority`, then lowest `id`.
pub fn select_active_schedule(
    schedules: &[Schedule],
    now: DateTime<chrono::Local>,
) -> Option<&Schedule> {
    schedules
        .iter()
        .filter(|s| is_active(s, now))
        .max_by(|a, b| a.priority.cmp(&b.priority).then(b.id.cmp(&a.id)))
}

/// True if this schedule's window/cron match the given moment.
pub fn is_active(schedule: &Schedule, now: DateTime<chrono::Local>) -> bool {
    if !schedule.enabled {
        return false;
    }

    // Skip server-authoritative conditions (holidays, event triggers).
    if let Some(ref c) = schedule.conditions {
        if c.get("holidays").is_some() {
            return false;
        }
        if c.get("event_trigger").is_some() {
            return false;
        }
        // Special dates: today must be in the list when set.
        if let Some(special) = c.get("special_dates").and_then(|v| v.as_array()) {
            let today = now.format("%Y-%m-%d").to_string();
            let matches = special
                .iter()
                .filter_map(|v| v.as_str())
                .any(|d| d == today);
            if !matches {
                return false;
            }
        }
    }

    // Day-of-week filter (server convention: Sunday = 0).
    let dow = now.weekday().num_days_from_sunday();
    let allowed: Vec<u32> = schedule
        .days_of_week
        .split(',')
        .filter_map(|s| s.trim().parse::<u32>().ok())
        .collect();
    if !allowed.contains(&dow) {
        return false;
    }

    // Cron path takes precedence when set.
    if let Some(ref expr) = schedule.cron_expression {
        return cron_fired_in_last_minute(expr, schedule.timezone.as_deref(), now);
    }

    // Legacy HH:MM window path.
    let Some(ref start) = schedule.start_time else {
        return false;
    };
    let now_hm = format!("{:02}:{:02}", now.hour(), now.minute());
    if now_hm.as_str() < start.as_str() {
        return false;
    }
    if let Some(ref end) = schedule.end_time {
        if now_hm.as_str() >= end.as_str() {
            return false;
        }
    }
    // Optional sanity check that the times are well-formed.
    if NaiveTime::parse_from_str(start, "%H:%M").is_err() {
        return false;
    }
    if let Some(ref end) = schedule.end_time {
        if NaiveTime::parse_from_str(end, "%H:%M").is_err() {
            return false;
        }
    }

    true
}

/// True if the cron expression had a fire-time in the 60-second window
/// `[now - 60s, now]` in the given timezone (defaults to client local).
fn cron_fired_in_last_minute(expr: &str, tz: Option<&str>, now: DateTime<chrono::Local>) -> bool {
    let Ok(schedule) = CronSchedule::from_str(expr) else {
        return false;
    };
    let one_min = chrono::Duration::seconds(60);

    // Evaluate in the configured timezone if set; otherwise client local.
    if let Some(tz_name) = tz {
        if let Ok(zone) = Tz::from_str(tz_name) {
            let now_tz = now.with_timezone(&zone);
            let lower = now_tz - one_min;
            return schedule
                .after(&zone.from_utc_datetime(&lower.naive_utc()))
                .take(2)
                .any(|t| t <= now_tz);
        }
    }
    let lower = now - one_min;
    schedule
        .after(&chrono::Local.from_utc_datetime(&lower.naive_utc()))
        .take(2)
        .any(|t| t <= now)
}

#[cfg(test)]
mod tests {
    use super::*;
    use chrono::TimeZone;

    fn dt(year: i32, month: u32, day: u32, hour: u32, minute: u32) -> DateTime<chrono::Local> {
        chrono::Local
            .with_ymd_and_hms(year, month, day, hour, minute, 0)
            .single()
            .expect("valid local datetime for tests")
    }

    fn base() -> Schedule {
        Schedule {
            id: 1,
            name: "test".to_string(),
            playlist_id: 100,
            client_id: None,
            group_id: None,
            start_time: None,
            end_time: None,
            days_of_week: "0,1,2,3,4,5,6".to_string(),
            priority: 50,
            enabled: true,
            cron_expression: None,
            timezone: None,
            conditions: None,
            interrupt_mode: "assign".to_string(),
            duration_seconds: None,
        }
    }

    #[test]
    fn time_window_active_inside() {
        // Wednesday 2026-04-22 (Sun=0, Wed=3) at 10:30, schedule 09:00-17:00
        let mut s = base();
        s.start_time = Some("09:00".to_string());
        s.end_time = Some("17:00".to_string());
        let now = dt(2026, 4, 22, 10, 30);
        assert!(is_active(&s, now));
        assert_eq!(
            select_active_schedule(std::slice::from_ref(&s), now).map(|x| x.id),
            Some(1)
        );
    }

    #[test]
    fn time_window_inactive_before_start() {
        let mut s = base();
        s.start_time = Some("09:00".to_string());
        s.end_time = Some("17:00".to_string());
        // 08:30 is before start.
        let now = dt(2026, 4, 22, 8, 30);
        assert!(!is_active(&s, now));
    }

    #[test]
    fn time_window_inactive_after_end() {
        let mut s = base();
        s.start_time = Some("09:00".to_string());
        s.end_time = Some("17:00".to_string());
        // 17:00 is the boundary — exclusive end.
        let now = dt(2026, 4, 22, 17, 0);
        assert!(!is_active(&s, now));
    }

    #[test]
    fn days_of_week_filter_excludes_weekend() {
        let mut s = base();
        s.start_time = Some("09:00".to_string());
        s.end_time = Some("17:00".to_string());
        s.days_of_week = "1,2,3,4,5".to_string(); // weekdays only
                                                  // 2026-04-25 is a Saturday (Sun=0,Sat=6).
        let now = dt(2026, 4, 25, 10, 0);
        assert!(!is_active(&s, now));
    }

    #[test]
    fn disabled_schedule_never_active() {
        let mut s = base();
        s.enabled = false;
        s.start_time = Some("00:00".to_string());
        s.end_time = Some("23:59".to_string());
        let now = dt(2026, 4, 22, 12, 0);
        assert!(!is_active(&s, now));
    }

    #[test]
    fn priority_breaks_ties_higher_wins() {
        let mut a = base();
        a.id = 1;
        a.priority = 10;
        a.start_time = Some("00:00".to_string());
        a.end_time = Some("23:59".to_string());

        let mut b = base();
        b.id = 2;
        b.priority = 50;
        b.start_time = Some("00:00".to_string());
        b.end_time = Some("23:59".to_string());

        let now = dt(2026, 4, 22, 12, 0);
        let pool = vec![a, b];
        let picked = select_active_schedule(&pool, now).unwrap();
        assert_eq!(picked.id, 2);
        assert_eq!(picked.priority, 50);
    }

    #[test]
    fn priority_tie_falls_back_to_lowest_id() {
        let mut a = base();
        a.id = 7;
        a.priority = 50;
        a.start_time = Some("00:00".to_string());
        a.end_time = Some("23:59".to_string());

        let mut b = base();
        b.id = 3;
        b.priority = 50;
        b.start_time = Some("00:00".to_string());
        b.end_time = Some("23:59".to_string());

        let now = dt(2026, 4, 22, 12, 0);
        let pool = vec![a, b];
        let picked = select_active_schedule(&pool, now).unwrap();
        assert_eq!(picked.id, 3);
    }

    #[test]
    fn missing_start_time_means_inactive_for_legacy_path() {
        let s = base();
        let now = dt(2026, 4, 22, 12, 0);
        // No cron, no start_time → can't fire.
        assert!(!is_active(&s, now));
    }

    #[test]
    fn cron_fires_within_last_minute_window() {
        let mut s = base();
        // Every minute on the minute — fires at the top of every minute.
        s.cron_expression = Some("0 * * * * *".to_string());
        // now = 12:30:00, last fire was at 12:30:00 → within window.
        let now = dt(2026, 4, 22, 12, 30);
        assert!(is_active(&s, now));
    }

    #[test]
    fn cron_no_fire_in_window() {
        let mut s = base();
        // Fires only at 09:00 daily.
        s.cron_expression = Some("0 0 9 * * *".to_string());
        // 12:30 is well after the morning fire — last_minute window is
        // 12:29:00 to 12:30:00, no fire there.
        let now = dt(2026, 4, 22, 12, 30);
        assert!(!is_active(&s, now));
    }

    #[test]
    fn holiday_condition_skipped_offline() {
        let mut s = base();
        s.start_time = Some("00:00".to_string());
        s.end_time = Some("23:59".to_string());
        s.conditions = Some(serde_json::json!({
            "holidays": { "country": "US", "match": "on" }
        }));
        let now = dt(2026, 4, 22, 12, 0);
        // Even though the time window matches, holiday conditions are
        // server-only and the offline evaluator must skip the schedule.
        assert!(!is_active(&s, now));
    }

    #[test]
    fn event_trigger_condition_skipped_offline() {
        let mut s = base();
        s.start_time = Some("00:00".to_string());
        s.end_time = Some("23:59".to_string());
        s.conditions = Some(serde_json::json!({
            "event_trigger": { "event_type": "client_offline" }
        }));
        let now = dt(2026, 4, 22, 12, 0);
        assert!(!is_active(&s, now));
    }

    #[test]
    fn special_dates_filter_match_required() {
        let mut s = base();
        s.start_time = Some("00:00".to_string());
        s.end_time = Some("23:59".to_string());
        s.conditions = Some(serde_json::json!({
            "special_dates": ["2026-04-22", "2026-12-25"]
        }));
        let in_list = dt(2026, 4, 22, 12, 0);
        let not_in_list = dt(2026, 4, 23, 12, 0);
        assert!(is_active(&s, in_list));
        assert!(!is_active(&s, not_in_list));
    }

    #[test]
    fn empty_input_returns_none() {
        let now = dt(2026, 4, 22, 12, 0);
        assert!(select_active_schedule(&[], now).is_none());
    }
}
