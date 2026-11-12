use notify::{Event, EventKind, RecommendedWatcher, RecursiveMode, Watcher};
use std::{path::Path, sync::Mutex};
use tauri::{AppHandle, Emitter};

#[derive(Default)]
pub struct WatchState(pub Mutex<Option<RecommendedWatcher>>);

fn relevant(event: &Event) -> bool {
    if matches!(event.kind, EventKind::Access(_)) { return false; }
    event.paths.iter().any(|path| {
        if path.components().any(|part| part.as_os_str().to_string_lossy() == ".lamina" || part.as_os_str().to_string_lossy().starts_with(".lamina-")) { return false; }
        path.extension().is_some_and(|ext| ext == "md") || path.extension().is_none() || path.is_dir() || matches!(event.kind, EventKind::Remove(notify::event::RemoveKind::Folder))
    })
}
pub fn watch(root: String, app: AppHandle) -> Result<RecommendedWatcher, String> {
    let watched = root.clone();
    let mut watcher = notify::recommended_watcher(move |event: notify::Result<Event>| {
        match event {
            Ok(event) => {
                if relevant(&event) { let _ = app.emit("vault-changed", &watched); }
                if !matches!(event.kind, EventKind::Access(_)) && event.paths.iter().any(|path| !path.components().any(|part| part.as_os_str().to_string_lossy().starts_with(".lamina")) && path.extension().is_some_and(|ext| matches!(ext.to_string_lossy().to_ascii_lowercase().as_str(), "png" | "jpg" | "jpeg" | "gif" | "webp" | "bmp") || ext == "json" && path.file_name().is_some_and(|name| name == "annotation.json"))) { let _ = app.emit("images-changed", &watched); }
            }
            Err(error) => { let _ = app.emit("vault-watch-error", serde_json::json!({ "root": watched, "message": error.to_string() })); }
        }
    }).map_err(|error| error.to_string())?;
    watcher.watch(Path::new(&root), RecursiveMode::Recursive).map_err(|error| error.to_string())?;
    Ok(watcher)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn management_and_temporary_files_do_not_trigger_reload() {
        let kind = EventKind::Modify(notify::event::ModifyKind::Any);
        assert!(!relevant(&Event::new(kind).add_path("vault/.lamina/tracking.json".into())));
        assert!(!relevant(&Event::new(kind).add_path("vault/メモ/.lamina-write-1.tmp".into())));
        assert!(relevant(&Event::new(kind).add_path("vault/メモ/記録.md".into())));
        assert!(relevant(&Event::new(EventKind::Remove(notify::event::RemoveKind::Folder)).add_path("vault/メモ/設計.v1".into())));
    }
    #[test]
    fn receives_real_markdown_file_changes() {
        let dir = tempfile::tempdir().unwrap();
        let (tx, rx) = std::sync::mpsc::channel();
        let mut watcher = notify::recommended_watcher(move |event: notify::Result<Event>| { if let Ok(event) = event { if relevant(&event) { let _ = tx.send(event); } } }).unwrap();
        watcher.watch(dir.path(), RecursiveMode::Recursive).unwrap();
        std::fs::write(dir.path().join("記録.md"), "保存").unwrap();
        let event = rx.recv_timeout(std::time::Duration::from_secs(5)).expect("Markdown file change should reach the watcher");
        assert!(event.paths.iter().any(|path| path.file_name().is_some_and(|name| name == "記録.md")));
    }
}
