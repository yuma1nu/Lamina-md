mod vault;
mod links;
mod catalog;
mod operations;
mod watching;
mod images;
mod resources;
mod trash;

use std::sync::Mutex;
use tauri::State;
use tauri_plugin_opener::OpenerExt;
use vault::{DiskFile, Vault, VaultSnapshot};

#[derive(Default)]
struct VaultState(Mutex<Option<Vault>>);

#[tauri::command]
async fn open_vault(root: String, initialize: bool, state: State<'_, VaultState>) -> Result<VaultSnapshot, String> {
    let mut guard = state.0.lock().map_err(|_| "保管庫の状態を取得できません。")?;
    let vault = Vault::open(&root, initialize)?;
    let snapshot = vault.snapshot()?;
    *guard = Some(vault);
    Ok(snapshot)
}

#[tauri::command]
async fn read_document(path: String, state: State<'_, VaultState>) -> Result<DiskFile, String> {
    let guard = state.0.lock().map_err(|_| "保管庫の状態を取得できません。")?;
    guard.as_ref().ok_or("保管庫を開いてください。")?.read(&path)
}

#[tauri::command]
async fn save_document(path: String, content: String, expected_revision: Option<String>, state: State<'_, VaultState>) -> Result<DiskFile, String> {
    let guard = state.0.lock().map_err(|_| "保管庫の状態を取得できません。")?;
    guard.as_ref().ok_or("保管庫を開いてください。")?.save(&path, &content, expected_revision.as_deref())
}

#[tauri::command]
async fn create_theme(name: String, state: State<'_, VaultState>) -> Result<VaultSnapshot, String> {
    let guard = state.0.lock().map_err(|_| "保管庫の状態を取得できません。")?;
    let vault = guard.as_ref().ok_or("保管庫を開いてください。")?;
    vault.create_theme(&name)?;
    vault.snapshot()
}

#[tauri::command]
async fn create_note(name: String, state: State<'_, VaultState>) -> Result<DiskFile, String> {
    let guard = state.0.lock().map_err(|_| "保管庫の状態を取得できません。")?;
    let vault = guard.as_ref().ok_or("保管庫を開いてください。")?;
    vault.create_note(&name)
}

#[tauri::command]
async fn read_workspace(state: State<'_, VaultState>) -> Result<Option<serde_json::Value>, String> {
    let guard = state.0.lock().map_err(|_| "保管庫の状態を取得できません。")?;
    guard.as_ref().ok_or("保管庫を開いてください。")?.read_workspace()
}

#[tauri::command]
async fn save_workspace(session: serde_json::Value, state: State<'_, VaultState>) -> Result<(), String> {
    let guard = state.0.lock().map_err(|_| "保管庫の状態を取得できません。")?;
    guard.as_ref().ok_or("保管庫を開いてください。")?.save_workspace(&session)
}

#[tauri::command]
async fn open_web_link(url: String, app: tauri::AppHandle) -> Result<(), String> {
    let url = links::web_url(&url)?;
    app.opener().open_url(url.as_str(), None::<&str>).map_err(|error| format!("リンク先を開けませんでした: {error}"))
}

#[tauri::command]
async fn inspect_resource(path: String) -> Result<resources::ResourceInfo, String> { resources::inspect(&path) }
#[tauri::command]
async fn read_resource_clipboard() -> Result<resources::ClipboardResources, String> { resources::clipboard() }
#[tauri::command]
async fn read_dropped_image(path: String) -> Result<resources::DroppedImage, String> { resources::dropped_image(&path) }
#[tauri::command]
async fn open_resource(path: String, app: tauri::AppHandle) -> Result<(), String> {
    if path.to_ascii_lowercase().starts_with("https://") || path.to_ascii_lowercase().starts_with("http://") {
        let url = links::web_url(&path)?;
        app.opener().open_url(url.as_str(), None::<&str>).map_err(|error| error.to_string())
    } else {
        let path = resources::resource_path(&path)?; resources::check_document(&path)?;
        if !path.exists() { return Err("資料が見つかりません。パスや共有フォルダーへの接続を確認してください。".into()); }
        app.opener().open_path(path.to_string_lossy().into_owned(), None::<&str>).map_err(|error| format!("資料を開けませんでした: {error}"))
    }
}

#[tauri::command]
async fn read_catalog(state: State<'_, VaultState>) -> Result<catalog::Catalog, String> {
    let guard = state.0.lock().map_err(|_| "保管庫の状態を取得できません。")?;
    guard.as_ref().ok_or("保管庫を開いてください。")?.catalog()
}
#[tauri::command]
async fn apply_operation(operation: operations::Operation, state: State<'_, VaultState>) -> Result<catalog::Catalog, String> {
    let guard = state.0.lock().map_err(|_| "保管庫の状態を取得できません。")?;
    guard.as_ref().ok_or("保管庫を開いてください。")?.apply_operation(operation)
}
#[tauri::command]
async fn trash_note(path: String, expected_revision: String, state: State<'_, VaultState>) -> Result<catalog::Catalog, String> {
    let guard = state.0.lock().map_err(|_| "保管庫の状態を取得できません。")?;
    guard.as_ref().ok_or("保管庫を開いてください。")?.trash_note(&path, &expected_revision)
}
#[tauri::command]
async fn watch_vault(state: State<'_, VaultState>, watch: State<'_, watching::WatchState>, app: tauri::AppHandle) -> Result<(), String> {
    let root = state.0.lock().map_err(|_| "保管庫の状態を取得できません。")?.as_ref().ok_or("保管庫を開いてください。")?.root.to_string_lossy().to_string();
    let watcher = watching::watch(root, app)?;
    *watch.0.lock().map_err(|_| "監視の状態を取得できません。")? = Some(watcher);
    Ok(())
}

#[tauri::command]
async fn read_image(root: String, path: String, editing: bool, state: State<'_, VaultState>) -> Result<images::ImageFile, String> {
    let guard = state.0.lock().map_err(|_| "保管庫の状態を取得できません。")?;
    let vault = guard.as_ref().ok_or("保管庫を開いてください。")?;
    if vault.root.to_string_lossy() != root { return Err("保管庫が切り替わりました。".into()); }
    vault.read_image(&path, editing)
}
#[tauri::command]
async fn write_image(root: String, write: images::ImageWrite, state: State<'_, VaultState>) -> Result<images::ImageFile, String> {
    let guard = state.0.lock().map_err(|_| "保管庫の状態を取得できません。")?;
    let vault = guard.as_ref().ok_or("保管庫を開いてください。")?;
    if vault.root.to_string_lossy() != root { return Err("保管庫が切り替わりました。".into()); }
    vault.write_image(write)
}

pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::Builder::new().open_js_links_on_click(false).build())
        .manage(VaultState::default())
        .manage(watching::WatchState::default())
        .invoke_handler(tauri::generate_handler![open_vault, read_document, save_document, create_theme, create_note, read_workspace, save_workspace, open_web_link, read_catalog, apply_operation, trash_note, watch_vault, read_image, write_image, inspect_resource, read_resource_clipboard, read_dropped_image, open_resource])
        .run(tauri::generate_context!())
        .expect("Lamina.mdの起動に失敗しました");
}
