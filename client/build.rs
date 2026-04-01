fn main() {
    // Capture build commit SHA for auto-update comparison.
    // Priority: BUILD_SHA env var (set by Docker/CI) > git rev-parse > "unknown"
    let sha = std::env::var("BUILD_SHA")
        .ok()
        .filter(|s| s != "unknown" && !s.is_empty())
        .or_else(|| {
            std::process::Command::new("git")
                .args(["rev-parse", "HEAD"])
                .output()
                .ok()
                .filter(|o| o.status.success())
                .map(|o| String::from_utf8_lossy(&o.stdout).trim().to_string())
        })
        .unwrap_or_else(|| "unknown".to_string());

    println!("cargo:rustc-env=BUILD_SHA={sha}");
    println!("cargo:rerun-if-env-changed=BUILD_SHA");
}
