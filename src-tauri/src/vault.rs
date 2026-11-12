use serde::Serialize;
use std::{fs::{self, OpenOptions}, io::Write, path::{Component, Path, PathBuf}, sync::atomic::{AtomicU64, Ordering}};

static TEMP_COUNTER: AtomicU64 = AtomicU64::new(0);
const FOLDERS: [&str; 5] = ["テーマ", "メモ", "資料", "添付", ".lamina"];
const MAX_WORKSPACE_BYTES: usize = 1024 * 1024;

fn workspace_format(value: &serde_json::Value) -> bool {
    value.get("version").and_then(|v| v.as_u64()) == Some(1)
        && value.get("panes").and_then(|v| v.as_array()).is_some_and(|panes|
            panes.len() == 2 && panes.iter().all(|pane| pane.get("tabs").is_some_and(|tabs| tabs.is_array())))
}

#[derive(Clone, Serialize)]
pub struct FileEntry { pub path: String, pub name: String }
#[derive(Clone, Serialize)]
pub struct ThemeEntry { pub path: String, pub name: String, pub files: Vec<FileEntry> }
#[derive(Serialize)]
pub struct VaultSnapshot { pub root: String, pub name: String, pub themes: Vec<ThemeEntry>, pub notes: Vec<FileEntry>, #[serde(rename = "noteFolders")] pub note_folders: Vec<String>, pub materials: Vec<FileEntry> }
#[derive(Clone, Serialize)]
pub struct DiskFile { pub path: String, pub content: String, pub revision: String }

pub struct Vault { pub(crate) root: PathBuf }

pub(crate) fn io_error(error: impl std::fmt::Display) -> String { format!("ファイル操作に失敗しました: {error}") }
pub(crate) fn digest(bytes: &[u8]) -> String { blake3::hash(bytes).to_hex().to_string() }

pub fn validate_name(name: &str) -> Result<(), String> {
    let stem = name.split('.').next().unwrap_or("").to_uppercase();
    let reserved = matches!(stem.as_str(), "CON" | "PRN" | "AUX" | "NUL") || (stem.len() == 4 && (stem.starts_with("COM") || stem.starts_with("LPT")) && matches!(stem.as_bytes()[3], b'1'..=b'9'));
    if name.trim().is_empty() || name != name.trim() || name.ends_with('.') || name.chars().any(|c| c.is_control() || "<>:\"/\\|?*".contains(c)) || reserved || name.len() > 180 {
        Err("名前を確認してください。空欄やWindowsで使用できない文字・名前は使えません。".into())
    } else { Ok(()) }
}

fn is_month_file(name: &str) -> bool {
    let b = name.as_bytes();
    b.len() == 10 && &b[7..] == b".md" && b[4] == b'-' && b[..4].iter().all(u8::is_ascii_digit)
        && b[5..7].iter().all(u8::is_ascii_digit) && (1..=12).contains(&name[5..7].parse::<u8>().unwrap_or(0))
}

impl Vault {
    pub fn open(root: &str, initialize: bool) -> Result<Self, String> {
        let root = fs::canonicalize(root).map_err(io_error)?;
        if !root.is_dir() { return Err("フォルダーを選択してください。".into()); }
        let vault = Self { root };
        if initialize {
            for folder in FOLDERS {
                let target = vault.root.join(folder);
                if target.exists() {
                    vault.check_existing(&target)?;
                    if !target.is_dir() { return Err(format!("{folder} はフォルダーではありません。")); }
                } else { fs::create_dir(&target).map_err(io_error)?; }
            }
        } else if !vault.root.join("テーマ").is_dir() && !vault.root.join("メモ").is_dir() {
            return Err("このフォルダーにテーマ・メモが見つかりません。「新しい保管庫を作る」から初期化できます。".into());
        }
        vault.recover_image()?;
        vault.recover_operation()?;
        Ok(vault)
    }

    pub(crate) fn check_existing(&self, path: &Path) -> Result<PathBuf, String> {
        let canonical = fs::canonicalize(path).map_err(io_error)?;
        if !canonical.starts_with(&self.root) { return Err("保管庫の外を参照するパスは扱えません。".into()); }
        Ok(canonical)
    }

    pub(crate) fn relative_path(&self, relative: &str) -> Result<PathBuf, String> {
        let relative = Path::new(relative);
        if relative.as_os_str().is_empty() || relative.components().any(|c| !matches!(c, Component::Normal(_))) || relative.to_string_lossy().contains(':') {
            return Err("保管庫内の相対パスを指定してください。".into());
        }
        let first = relative.components().next().unwrap().as_os_str();
        if first != "テーマ" && first != "メモ" && first != "資料" { return Err("この操作は保管庫内のMarkdownが対象です。".into()); }
        if relative.extension().and_then(|s| s.to_str()) != Some("md") { return Err("Markdownファイルを指定してください。".into()); }
        Ok(self.root.join(relative))
    }

    fn entry(&self, path: &Path) -> FileEntry {
        FileEntry { path: path.strip_prefix(&self.root).unwrap().to_string_lossy().replace('\\', "/"), name: path.file_name().unwrap().to_string_lossy().into() }
    }

    fn collect_notes(&self, folder: &Path, result: &mut Vec<FileEntry>, folders: &mut Vec<String>) -> Result<(), String> {
        if !folder.exists() { return Ok(()); }
        self.check_existing(folder)?;
        for entry in fs::read_dir(folder).map_err(io_error)? {
            let entry = entry.map_err(io_error)?;
            let kind = entry.file_type().map_err(io_error)?;
            if kind.is_symlink() { continue; }
            let path = entry.path();
            self.check_existing(&path)?;
            if kind.is_dir() { folders.push(path.strip_prefix(&self.root).unwrap().to_string_lossy().replace('\\', "/")); self.collect_notes(&path, result, folders)?; }
            else if path.extension().and_then(|s| s.to_str()) == Some("md") { result.push(self.entry(&path)); }
        }
        Ok(())
    }

    pub fn snapshot(&self) -> Result<VaultSnapshot, String> {
        let mut themes = Vec::new();
        let theme_root = self.root.join("テーマ");
        if theme_root.exists() { self.collect_themes(&theme_root, &mut themes)?; }
        themes.sort_by(|a, b| a.name.cmp(&b.name));
        let mut notes = Vec::new();
        let mut note_folders = Vec::new();
        self.collect_notes(&self.root.join("メモ"), &mut notes, &mut note_folders)?;
        notes.sort_by(|a, b| a.path.cmp(&b.path));
        note_folders.sort();
        let mut materials = Vec::new();
        self.collect_notes(&self.root.join("資料"), &mut materials, &mut Vec::new())?;
        materials.sort_by(|a, b| a.path.cmp(&b.path));
        Ok(VaultSnapshot { root: self.root.to_string_lossy().into(), name: self.root.file_name().unwrap_or_default().to_string_lossy().into(), themes, notes, note_folders, materials })
    }

    fn collect_themes(&self, folder: &Path, result: &mut Vec<ThemeEntry>) -> Result<(), String> {
        self.check_existing(folder)?;
        let mut files = Vec::new();
        let mut children = Vec::new();
        for entry in fs::read_dir(folder).map_err(io_error)? {
            let entry = entry.map_err(io_error)?;
            let kind = entry.file_type().map_err(io_error)?;
            if kind.is_symlink() { continue; }
            self.check_existing(&entry.path())?;
            if kind.is_dir() { children.push(entry.path()); }
            else if kind.is_file() && is_month_file(&entry.file_name().to_string_lossy()) { files.push(self.entry(&entry.path())); }
        }
        if folder != self.root.join("テーマ") && (!files.is_empty() || children.is_empty()) {
            files.sort_by(|a, b| a.path.cmp(&b.path));
            result.push(ThemeEntry { path: folder.strip_prefix(&self.root).unwrap().to_string_lossy().replace('\\', "/"), name: folder.file_name().unwrap().to_string_lossy().into(), files });
        }
        for child in children { self.collect_themes(&child, result)?; }
        Ok(())
    }

    pub fn read(&self, relative: &str) -> Result<DiskFile, String> {
        let path = self.check_existing(&self.relative_path(relative)?)?;
        let bytes = fs::read(path).map_err(io_error)?;
        let content = String::from_utf8(bytes.clone()).map_err(|_| "UTF-8として読み込めないファイルです。元ファイルは変更しません。")?;
        Ok(DiskFile { path: relative.replace('\\', "/"), content, revision: digest(&bytes) })
    }

    pub fn save(&self, relative: &str, content: &str, expected: Option<&str>) -> Result<DiskFile, String> {
        let path = self.relative_path(relative)?;
        // A document's parent already exists. Saving must not create arbitrary paths.
        self.check_existing(path.parent().ok_or("保存先が不正です。")?)?;
        let verify = || -> Result<(), String> {
            if path.exists() {
                self.check_existing(&path)?;
                let bytes = fs::read(&path).map_err(io_error)?;
                if expected != Some(digest(&bytes).as_str()) { return Err("別のアプリで変更されたか、同名ファイルが作成されています。編集内容を保持しています。".into()); }
            } else if expected.is_some() { return Err("元のファイルが移動または削除されています。編集内容を保持しています。".into()); }
            Ok(())
        };
        verify()?;
        let temp = path.with_file_name(format!(".lamina-{}-{}.tmp", std::process::id(), TEMP_COUNTER.fetch_add(1, Ordering::Relaxed)));
        let result = (|| -> Result<(), String> {
            let mut file = OpenOptions::new().create_new(true).write(true).open(&temp).map_err(io_error)?;
            file.write_all(content.as_bytes()).map_err(io_error)?;
            file.sync_all().map_err(io_error)?;
            drop(file);
            verify()?;
            fs::rename(&temp, &path).map_err(io_error)?;
            Ok(())
        })();
        if result.is_err() { let _ = fs::remove_file(&temp); }
        result?;
        Ok(DiskFile { path: relative.replace('\\', "/"), content: content.into(), revision: digest(content.as_bytes()) })
    }

    pub fn create_theme(&self, name: &str) -> Result<(), String> {
        validate_name(name)?;
        let folder = self.root.join("テーマ");
        self.check_existing(&folder)?;
        fs::create_dir(folder.join(name)).map_err(io_error)
    }

    pub fn create_note(&self, name: &str) -> Result<DiskFile, String> {
        validate_name(name)?;
        let filename = if name.ends_with(".md") { name.to_owned() } else { format!("{name}.md") };
        self.save(&format!("メモ/{filename}"), "", None)
    }

    pub fn read_workspace(&self) -> Result<Option<serde_json::Value>, String> {
        let path = self.root.join(".lamina/workspace.json");
        if !path.exists() { return Ok(None); }
        let path = self.check_existing(&path)?;
        if fs::metadata(&path).map_err(io_error)?.len() > MAX_WORKSPACE_BYTES as u64 {
            return Err("画面状態のファイルが大きすぎるため読み込めませんでした。".into());
        }
        let bytes = fs::read(path).map_err(io_error)?;
        serde_json::from_slice(&bytes).map(Some).map_err(|_| "画面状態を読み込めませんでした。ノート本文は変更していません。".into())
    }

    pub fn save_workspace(&self, session: &serde_json::Value) -> Result<(), String> {
        if !workspace_format(session) { return Err("画面状態の保存形式が不正です。".into()); }
        let bytes = serde_json::to_vec_pretty(session).map_err(io_error)?;
        if bytes.len() > MAX_WORKSPACE_BYTES { return Err("画面状態のファイルが大きすぎるため保存できませんでした。".into()); }
        let folder = self.root.join(".lamina");
        if !folder.exists() { fs::create_dir(&folder).map_err(io_error)?; }
        self.check_existing(&folder)?;
        let path = folder.join("workspace.json");
        if path.exists() {
            self.check_existing(&path)?;
            let old = fs::read(&path).map_err(io_error)?;
            // Preserve unreadable or incompatible metadata before starting a new session.
            if !serde_json::from_slice(&old).ok().is_some_and(|value| workspace_format(&value)) {
                let counter = TEMP_COUNTER.fetch_add(1, Ordering::Relaxed);
                let stamp = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map_err(io_error)?.as_millis();
                let backup = folder.join(format!("workspace-recovered-{stamp}-{counter}.json"));
                let mut file = OpenOptions::new().create_new(true).write(true).open(backup).map_err(io_error)?;
                file.write_all(&old).map_err(io_error)?;
                file.sync_all().map_err(io_error)?;
            }
        }
        let temp = folder.join(format!(".workspace-{}-{}.tmp", std::process::id(), TEMP_COUNTER.fetch_add(1, Ordering::Relaxed)));
        let result = (|| -> Result<(), String> {
            let mut file = OpenOptions::new().create_new(true).write(true).open(&temp).map_err(io_error)?;
            file.write_all(&bytes).map_err(io_error)?;
            file.sync_all().map_err(io_error)?;
            drop(file);
            fs::rename(&temp, &path).map_err(io_error)
        })();
        if result.is_err() { let _ = fs::remove_file(&temp); }
        result
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn saves_without_overwriting_external_changes() {
        let dir = tempfile::tempdir().unwrap();
        let vault = Vault::open(dir.path().to_str().unwrap(), true).unwrap();
        let first = vault.create_note("試験記録").unwrap();
        let saved = vault.save(&first.path, "温度は45℃。\r\n", Some(&first.revision)).unwrap();
        fs::write(dir.path().join(&first.path), "外部で変更").unwrap();
        assert!(vault.save(&first.path, "上書き", Some(&saved.revision)).is_err());
        assert_eq!(vault.read(&first.path).unwrap().content, "外部で変更");
    }

    #[test]
    fn does_not_overwrite_duplicate_or_escape_vault() {
        let dir = tempfile::tempdir().unwrap();
        let vault = Vault::open(dir.path().to_str().unwrap(), true).unwrap();
        vault.create_note("メモ").unwrap();
        assert!(vault.create_note("メモ").is_err());
        assert!(vault.save("メモ/../../outside.md", "test", None).is_err());
        assert!(vault.create_theme("CON").is_err());
        assert!(vault.create_theme("../テーマ").is_err());
    }

    #[test]
    fn persists_workspace_separately_and_reopens_it() {
        let dir = tempfile::tempdir().unwrap();
        let vault = Vault::open(dir.path().to_str().unwrap(), true).unwrap();
        vault.create_note("原文").unwrap();
        assert!(vault.read_workspace().unwrap().is_none());
        let mut session = serde_json::json!({"version": 1, "panes": [{"tabs": [{"id": "メモ/原文.md", "pinned": true}], "active": "メモ/原文.md"}, {"tabs": [], "active": null}], "split": false});
        vault.save_workspace(&session).unwrap();
        session["split"] = serde_json::json!(true);
        vault.save_workspace(&session).unwrap();
        let reopened = Vault::open(dir.path().to_str().unwrap(), false).unwrap();
        assert_eq!(reopened.read_workspace().unwrap(), Some(session));
        assert_eq!(reopened.read("メモ/原文.md").unwrap().content, "");
        assert!(!fs::read_dir(dir.path().join(".lamina")).unwrap().any(|entry| entry.unwrap().path().extension().is_some_and(|ext| ext == "tmp")));
    }

    #[test]
    fn preserves_corrupt_workspace_before_replacing_it() {
        let dir = tempfile::tempdir().unwrap();
        let vault = Vault::open(dir.path().to_str().unwrap(), true).unwrap();
        fs::write(dir.path().join(".lamina/workspace.json"), b"{broken").unwrap();
        assert!(vault.read_workspace().is_err());
        assert!(vault.save_workspace(&serde_json::json!({"version": 2})).is_err());
        let session = serde_json::json!({"version": 1, "panes": [{"tabs": []}, {"tabs": []}]});
        vault.save_workspace(&session).unwrap();
        let backup = fs::read_dir(dir.path().join(".lamina")).unwrap().map(|entry| entry.unwrap().path()).find(|path| path.file_name().unwrap().to_string_lossy().starts_with("workspace-recovered-")).unwrap();
        assert_eq!(fs::read(backup).unwrap(), b"{broken");
        assert_eq!(vault.read_workspace().unwrap(), Some(session));
    }
}
