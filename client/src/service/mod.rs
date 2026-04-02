#[cfg(windows)]
mod windows;

#[cfg(windows)]
pub use windows::{install_service, run_service_dispatcher, uninstall_service};
