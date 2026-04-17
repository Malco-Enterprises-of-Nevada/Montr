//! Subtitle track resolution.
//!
//! The server advertises zero-or-more subtitle tracks per playlist item in
//! protocol 1.1.0. Before we issue the mpv IPC `loadfile` sequence we have
//! to decide: which track, if any, should be visible? The answer depends on
//! the operator's `display.enable_subtitles` toggle, their preferred
//! `display.preferred_language`, and the `is_default` / `is_forced` flags
//! the server attached. This module expresses that policy in one place so
//! the engine can stay focused on IPC mechanics.

use crate::network::protocol::{SubtitleKind, SubtitleTrack};
use std::path::PathBuf;

/// How the engine should activate a subtitle track on mpv once the video is
/// loaded. `External` variants reference files already resolved to on-disk
/// paths by the cache layer; `Embedded` already carries an mpv-style sid
/// (1-based index across only the container's subtitle streams) so the
/// engine doesn't have to repeat the translation.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum SubtitleSelection {
    External { path: PathBuf },
    Embedded { sid: u32 },
    None,
}

/// The full plan for a playback session: all external sidecars to be
/// registered with mpv (so the user can later toggle between them), plus
/// which one of those or which embedded stream should be visible now.
#[derive(Debug, Clone)]
pub struct ResolvedSubtitles {
    /// External sidecar files (already cached on disk) to `sub-add` in mpv.
    pub external_paths: Vec<PathBuf>,
    /// The single track to make active — mpv's `sid` property.
    pub selected: SubtitleSelection,
    /// Optional `sub-font-size` override from operator config.
    pub font_size: Option<u32>,
}

impl ResolvedSubtitles {
    pub fn none() -> Self {
        Self {
            external_paths: Vec::new(),
            selected: SubtitleSelection::None,
            font_size: None,
        }
    }
}

/// Candidate entry built from one server-advertised subtitle track plus
/// the cache decision the caller already made (for externals: did we
/// actually manage to fetch the sidecar?).
#[derive(Debug, Clone)]
pub struct SubtitleCandidate {
    pub track: SubtitleTrack,
    /// Populated only for external tracks whose sidecar is cached and ready.
    pub local_path: Option<PathBuf>,
}

impl SubtitleCandidate {
    pub fn external(track: SubtitleTrack, local_path: PathBuf) -> Self {
        debug_assert_eq!(track.kind, SubtitleKind::External);
        Self {
            track,
            local_path: Some(local_path),
        }
    }

    pub fn embedded(track: SubtitleTrack) -> Self {
        debug_assert_eq!(track.kind, SubtitleKind::Embedded);
        Self {
            track,
            local_path: None,
        }
    }
}

/// Select the visible track from a set of candidates.
///
/// Precedence, from most to least specific:
/// 1. `preferred_language` match *and* `is_default`.
/// 2. `preferred_language` match alone.
/// 3. `is_default`.
/// 4. Any `is_forced` track (likely burned-in signage).
/// 5. Any track at all.
/// Within each bucket external sidecars beat embedded streams — they are
/// usually the operator's explicit upload and so the more intentional choice.
///
/// Returns `SubtitleSelection::None` if `enable` is false or the candidate
/// list is empty.
pub fn choose(
    candidates: &[SubtitleCandidate],
    preferred_language: Option<&str>,
    enable: bool,
) -> SubtitleSelection {
    if !enable || candidates.is_empty() {
        return SubtitleSelection::None;
    }

    // Build the mpv-sid map once (embedded tracks sorted by ffprobe stream_index).
    let embedded_sid_by_track_id = build_embedded_sid_map(candidates);

    let pref_ok = |c: &SubtitleCandidate| {
        preferred_language
            .and_then(|p| c.track.language.as_deref().map(|l| l.eq_ignore_ascii_case(p)))
            .unwrap_or(false)
    };

    // Helper that converts a candidate into a SubtitleSelection.
    let to_selection = |c: &SubtitleCandidate| -> Option<SubtitleSelection> {
        match c.track.kind {
            SubtitleKind::External => c
                .local_path
                .as_ref()
                .map(|p| SubtitleSelection::External { path: p.clone() }),
            SubtitleKind::Embedded => embedded_sid_by_track_id
                .get(&c.track.id)
                .copied()
                .map(|sid| SubtitleSelection::Embedded { sid }),
        }
    };

    // Each bucket prefers external-then-embedded inside it.
    let buckets: &[Box<dyn Fn(&SubtitleCandidate) -> bool>] = &[
        Box::new(|c: &SubtitleCandidate| pref_ok(c) && c.track.is_default),
        Box::new(|c: &SubtitleCandidate| pref_ok(c)),
        Box::new(|c: &SubtitleCandidate| c.track.is_default),
        Box::new(|c: &SubtitleCandidate| c.track.is_forced),
        Box::new(|_c: &SubtitleCandidate| true),
    ];

    for predicate in buckets {
        // Externals first within the bucket.
        let mut best: Option<&SubtitleCandidate> = None;
        for c in candidates
            .iter()
            .filter(|c| c.track.kind == SubtitleKind::External)
            .filter(|c| c.local_path.is_some())
        {
            if predicate(c) {
                best = Some(c);
                break;
            }
        }
        if best.is_none() {
            for c in candidates
                .iter()
                .filter(|c| c.track.kind == SubtitleKind::Embedded)
            {
                if predicate(c) {
                    best = Some(c);
                    break;
                }
            }
        }
        if let Some(c) = best {
            if let Some(sel) = to_selection(c) {
                return sel;
            }
        }
    }

    SubtitleSelection::None
}

/// Compose a `ResolvedSubtitles` plan: the set of external sidecars to
/// register with mpv plus the selection chosen by `choose()`.
pub fn resolve(
    candidates: Vec<SubtitleCandidate>,
    preferred_language: Option<&str>,
    enable: bool,
    font_size: Option<u32>,
) -> ResolvedSubtitles {
    let external_paths: Vec<PathBuf> = candidates
        .iter()
        .filter(|c| c.track.kind == SubtitleKind::External)
        .filter_map(|c| c.local_path.clone())
        .collect();

    let selected = choose(&candidates, preferred_language, enable);

    ResolvedSubtitles {
        external_paths,
        selected,
        font_size,
    }
}

/// mpv numbers subtitle tracks with `sid=1, sid=2, …` counting only the
/// subtitle streams inside the container, in ffprobe stream_index order.
/// Translate the server-advertised global `streamIndex` into an mpv sid for
/// each embedded candidate.
fn build_embedded_sid_map(
    candidates: &[SubtitleCandidate],
) -> std::collections::HashMap<u32, u32> {
    let mut embedded: Vec<&SubtitleCandidate> = candidates
        .iter()
        .filter(|c| c.track.kind == SubtitleKind::Embedded)
        .collect();
    embedded.sort_by_key(|c| c.track.stream_index.unwrap_or(0));
    let mut map = std::collections::HashMap::new();
    for (i, c) in embedded.iter().enumerate() {
        map.insert(c.track.id, (i as u32) + 1);
    }
    map
}

#[cfg(test)]
mod tests {
    use super::*;

    fn make_external(id: u32, language: Option<&str>, is_default: bool) -> SubtitleCandidate {
        let track = SubtitleTrack {
            id,
            kind: SubtitleKind::External,
            language: language.map(String::from),
            label: None,
            is_default,
            is_forced: false,
            download_url: Some(format!("/api/subtitles/{}/download", id)),
            filename: Some(format!("{}.srt", id)),
            format: Some("srt".into()),
            checksum: None,
            stream_index: None,
            codec: None,
        };
        SubtitleCandidate::external(track, PathBuf::from(format!("/tmp/{}.srt", id)))
    }

    fn make_embedded(
        id: u32,
        stream_index: u32,
        language: Option<&str>,
        is_default: bool,
    ) -> SubtitleCandidate {
        let track = SubtitleTrack {
            id,
            kind: SubtitleKind::Embedded,
            language: language.map(String::from),
            label: None,
            is_default,
            is_forced: false,
            download_url: None,
            filename: None,
            format: None,
            checksum: None,
            stream_index: Some(stream_index),
            codec: Some("subrip".into()),
        };
        SubtitleCandidate::embedded(track)
    }

    #[test]
    fn disabled_always_returns_none() {
        let cands = vec![make_external(1, Some("eng"), true)];
        assert_eq!(choose(&cands, Some("eng"), false), SubtitleSelection::None);
    }

    #[test]
    fn empty_returns_none() {
        assert_eq!(choose(&[], Some("eng"), true), SubtitleSelection::None);
    }

    #[test]
    fn preferred_language_and_default_wins() {
        let cands = vec![
            make_external(1, Some("spa"), false),
            make_external(2, Some("eng"), true),
            make_embedded(3, 2, Some("eng"), true),
        ];
        match choose(&cands, Some("eng"), true) {
            SubtitleSelection::External { path } => {
                assert_eq!(path, PathBuf::from("/tmp/2.srt"))
            }
            _ => panic!("expected external eng default"),
        }
    }

    #[test]
    fn preferred_language_without_default_still_wins() {
        let cands = vec![
            make_external(1, Some("spa"), true),
            make_external(2, Some("eng"), false),
        ];
        match choose(&cands, Some("eng"), true) {
            SubtitleSelection::External { path } => {
                assert_eq!(path, PathBuf::from("/tmp/2.srt"))
            }
            _ => panic!("expected eng non-default preferred"),
        }
    }

    #[test]
    fn default_flag_wins_absent_preferred_match() {
        let cands = vec![
            make_external(1, Some("fra"), false),
            make_external(2, Some("spa"), true),
        ];
        match choose(&cands, Some("eng"), true) {
            SubtitleSelection::External { path } => {
                assert_eq!(path, PathBuf::from("/tmp/2.srt"))
            }
            _ => panic!("expected default external"),
        }
    }

    #[test]
    fn embedded_sid_translation_is_stream_index_order() {
        // Server sends ffprobe indices 3, 5, 2 — mpv sid should be 1, 2, 3
        // matching ascending stream_index (2, 3, 5).
        let cands = vec![
            make_embedded(100, 3, Some("eng"), false),
            make_embedded(101, 5, Some("spa"), false),
            make_embedded(102, 2, Some("ger"), true),
        ];
        // Preferred "eng" beats "default" — id=100 (eng) selected.
        // id=100 has stream_index=3; sorted [2,3,5] → sid=2.
        match choose(&cands, Some("eng"), true) {
            SubtitleSelection::Embedded { sid } => assert_eq!(sid, 2),
            other => panic!("unexpected selection: {:?}", other),
        }
    }

    #[test]
    fn external_beats_embedded_at_same_priority() {
        let cands = vec![
            make_embedded(1, 2, Some("eng"), true),
            make_external(2, Some("eng"), true),
        ];
        match choose(&cands, Some("eng"), true) {
            SubtitleSelection::External { path } => {
                assert_eq!(path, PathBuf::from("/tmp/2.srt"))
            }
            _ => panic!("external should win ties"),
        }
    }

    #[test]
    fn first_available_when_nothing_preferred_or_default() {
        let cands = vec![
            make_embedded(10, 5, Some("fra"), false),
            make_embedded(11, 2, Some("spa"), false),
        ];
        // No preferred language and nothing flagged: selector falls to the
        // "any" bucket, which picks in candidate order. id=10 is first in
        // the Vec; its stream_index=5 sorts to position 2 of [2,5] → sid=2.
        match choose(&cands, None, true) {
            SubtitleSelection::Embedded { sid } => assert_eq!(sid, 2),
            other => panic!("unexpected: {:?}", other),
        }
    }

    #[test]
    fn external_missing_local_path_is_skipped() {
        // Simulate a download failure: external track advertised but local_path None.
        let track = SubtitleTrack {
            id: 1,
            kind: SubtitleKind::External,
            language: Some("eng".into()),
            label: None,
            is_default: true,
            is_forced: false,
            download_url: Some("/x".into()),
            filename: Some("1.srt".into()),
            format: Some("srt".into()),
            checksum: None,
            stream_index: None,
            codec: None,
        };
        let missing = SubtitleCandidate {
            track,
            local_path: None,
        };
        let embedded = make_embedded(2, 1, Some("eng"), false);
        let cands = vec![missing, embedded];
        // External is skipped (no local_path) → embedded used.
        match choose(&cands, Some("eng"), true) {
            SubtitleSelection::Embedded { sid } => assert_eq!(sid, 1),
            other => panic!("unexpected: {:?}", other),
        }
    }
}
