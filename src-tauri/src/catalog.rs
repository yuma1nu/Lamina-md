use crate::{operations::{atomic_write, PathMove}, vault::{digest, io_error, DiskFile, Vault, VaultSnapshot}};
use serde::{Deserialize, Serialize};
use std::{collections::HashSet, fs, path::Path};

#[derive(Clone, Serialize, Deserialize)]
pub struct TrackedEntry { pub path: String, pub kind: String, pub identity: Option<String>, pub signature: String }
#[derive(Serialize, Deserialize)]
struct Tracking { version: u8, entries: Vec<TrackedEntry> }
#[derive(Serialize)]
pub struct Catalog { pub snapshot: VaultSnapshot, pub files: Vec<DiskFile>, pub moves: Vec<PathMove>, pub previous: Vec<TrackedEntry>, pub warnings: Vec<String> }

#[cfg(windows)]
fn identity(path: &Path) -> Option<String> {
    use std::os::windows::{fs::OpenOptionsExt, io::AsRawHandle};
    use windows_sys::Win32::Storage::FileSystem::{BY_HANDLE_FILE_INFORMATION, FILE_FLAG_BACKUP_SEMANTICS, GetFileInformationByHandle};
    let file = fs::OpenOptions::new().read(true).custom_flags(FILE_FLAG_BACKUP_SEMANTICS).open(path).ok()?;
    let mut info: BY_HANDLE_FILE_INFORMATION = unsafe { std::mem::zeroed() };
    if unsafe { GetFileInformationByHandle(file.as_raw_handle(), &mut info) } == 0 { return None; }
    if info.nFileIndexHigh == 0 && info.nFileIndexLow == 0 { return None; }
    Some(format!("{}:{}:{}:{}:{}", info.dwVolumeSerialNumber, info.nFileIndexHigh, info.nFileIndexLow, info.ftCreationTime.dwHighDateTime, info.ftCreationTime.dwLowDateTime))
}
#[cfg(not(windows))]
fn identity(_path: &Path) -> Option<String> { None }

fn name(path: &str) -> &str { path.rsplit('/').next().unwrap_or(path) }
fn moved(previous: &[TrackedEntry], current: &[TrackedEntry]) -> (Vec<PathMove>, Vec<String>) {
    let old_paths: HashSet<_> = previous.iter().map(|entry| entry.path.as_str()).collect();
    let paths: HashSet<_> = current.iter().map(|entry| entry.path.as_str()).collect();
    let mut moves = Vec::new(); let mut warnings = Vec::new();
    for old in previous.iter().filter(|entry| !paths.contains(entry.path.as_str())) {
        let candidates: Vec<_> = current.iter().filter(|entry| !old_paths.contains(entry.path.as_str()) && entry.kind == old.kind && name(&entry.path) == name(&old.path)).collect();
        let by_identity: Vec<_> = candidates.iter().filter(|entry| old.identity.is_some() && entry.identity == old.identity).collect();
        let candidates = if by_identity.is_empty() {
            let unique_old = previous.iter().filter(|entry| entry.kind == old.kind && name(&entry.path) == name(&old.path) && entry.signature == old.signature).count() == 1;
            candidates.iter().filter(|entry| unique_old && entry.signature == old.signature).collect::<Vec<_>>()
        } else { by_identity };
        if candidates.len() == 1 { moves.push(PathMove { from: old.path.clone(), to: candidates[0].path.clone() }); }
        else if candidates.len() > 1 { warnings.push(format!("移動先を一意に決められませんでした: {}", old.path)); }
    }
    // Do not assign one destination to multiple previous files.
    let duplicate: HashSet<_> = moves.iter().filter(|movement| moves.iter().filter(|other| other.to == movement.to).count() > 1).map(|movement| movement.to.clone()).collect();
    moves.retain(|movement| !duplicate.contains(&movement.to));
    (moves, warnings)
}
impl Vault {
    fn current_catalog(&self) -> Result<(VaultSnapshot, Vec<DiskFile>, Vec<TrackedEntry>), String> {
        let snapshot = self.snapshot()?;
        let mut files = Vec::new(); let mut entries = Vec::new();
        for theme in &snapshot.themes {
            let mut signatures = Vec::new();
            for entry in &theme.files {
                let file = self.read(&entry.path)?;
                signatures.push(format!("{}:{}", entry.name, file.revision));
                entries.push(TrackedEntry { path: file.path.clone(), kind: "month".into(), identity: identity(&self.root.join(&file.path)), signature: file.revision.clone() });
                files.push(file);
            }
            entries.push(TrackedEntry { path: theme.path.clone(), kind: "theme".into(), identity: identity(&self.root.join(&theme.path)), signature: digest(signatures.join("\n").as_bytes()) });
        }
        for entry in snapshot.notes.iter().chain(snapshot.materials.iter()) {
            let file = self.read(&entry.path)?;
            entries.push(TrackedEntry { path: file.path.clone(), kind: if file.path.starts_with("資料/") { "material".into() } else { "note".into() }, identity: identity(&self.root.join(&file.path)), signature: file.revision.clone() });
            files.push(file);
        }
        Ok((snapshot, files, entries))
    }
    pub fn catalog(&self) -> Result<Catalog, String> {
        let (snapshot, files, current) = self.current_catalog()?;
        let tracking = self.root.join(".lamina/tracking.json");
        let previous = if tracking.exists() {
            self.check_existing(&tracking)?;
            let saved: Tracking = serde_json::from_slice(&fs::read(tracking).map_err(io_error)?).map_err(|_| "追跡情報を読み込めませんでした。リンクの自動更新を止めています。")?;
            if saved.version != 1 { return Err("未対応の追跡情報です。".into()); }
            saved.entries
        } else { current.clone() };
        let (moves, warnings) = moved(&previous, &current);
        Ok(Catalog { snapshot, files, previous, moves, warnings })
    }
    pub fn commit_tracking(&self) -> Result<(), String> {
        let (_, _, entries) = self.current_catalog()?;
        let path = self.management_dir()?.join("tracking.json");
        if path.exists() { self.check_existing(&path)?; }
        atomic_write(&path, &serde_json::to_vec(&Tracking { version: 1, entries }).map_err(io_error)?)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn follows_offline_note_and_theme_moves_and_keeps_renames_unresolved() {
        let dir = tempfile::tempdir().unwrap(); let root = dir.path();
        let vault = Vault::open(root.to_str().unwrap(), true).unwrap();
        vault.create_note("手順").unwrap(); vault.create_theme("評価").unwrap();
        fs::write(root.join("テーマ/評価/2026-11.md"), "# 2026-11-12\n記録").unwrap();
        vault.commit_tracking().unwrap();
        fs::create_dir(root.join("メモ/整理")).unwrap(); fs::create_dir(root.join("テーマ/開発")).unwrap();
        fs::rename(root.join("メモ/手順.md"), root.join("メモ/整理/手順.md")).unwrap();
        fs::rename(root.join("テーマ/評価"), root.join("テーマ/開発/評価")).unwrap();
        let catalog = vault.catalog().unwrap();
        assert!(catalog.moves.iter().any(|m| m.from == "メモ/手順.md" && m.to == "メモ/整理/手順.md"));
        assert!(catalog.moves.iter().any(|m| m.from == "テーマ/評価" && m.to == "テーマ/開発/評価"));
        assert!(catalog.moves.iter().any(|m| m.from == "テーマ/評価/2026-11.md" && m.to == "テーマ/開発/評価/2026-11.md"));
        vault.commit_tracking().unwrap();
        fs::rename(root.join("メモ/整理/手順.md"), root.join("メモ/整理/改名.md")).unwrap();
        assert!(vault.catalog().unwrap().moves.is_empty());
    }
    #[test]
    fn ambiguous_copies_are_not_assigned() {
        let entry = |path: &str| TrackedEntry { path: path.into(), kind: "note".into(), identity: None, signature: "same".into() };
        let (moves, warnings) = moved(&[entry("メモ/a.md")], &[entry("メモ/x/a.md"), entry("メモ/y/a.md")]);
        assert!(moves.is_empty()); assert_eq!(warnings.len(), 1);
    }
}
