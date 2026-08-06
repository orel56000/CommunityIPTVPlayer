fn main() {
    // Declares this app's own commands so tauri-build autogenerates their ACL
    // permissions (`allow-<command>` / `deny-<command>`, underscores -> dashes).
    // Without this, invoking them from the main window's remote-loaded content
    // (WebviewUrl::External — see build_window in lib.rs) fails with
    // "Command <name> not allowed by ACL", even though nothing in
    // capabilities/default.json looks wrong at a glance: local (bundled-asset)
    // windows implicitly trust the app's own commands, but content loaded via
    // WebviewUrl::External is "remote" and always needs an explicit grant.
    let attrs = tauri_build::Attributes::new()
        .app_manifest(tauri_build::AppManifest::new().commands(&["open_debug_window"]));
    tauri_build::try_build(attrs).expect("failed to run tauri-build");
}
