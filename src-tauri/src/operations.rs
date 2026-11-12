use crate::{catalog::Catalog, vault::{digest, io_error, validate_name, Vault}};
use serde::{Deserialize, Serialize};
use std::{collections::HashSet, fs::{self, OpenOptions}, io::Write, path::{Component, Path, PathBuf}, sync::atomic::{AtomicU64, Ordering}};

static COUNTER: AtomicU64 = AtomicU64::new(0);
#[derive(Clone, Serialize, Deserialize)]
pub struct PathMove { pub from: String, pub to: String }
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FileWrite { pub path: String, pub content: String, pub expected_revision: Option<String> }
#[derive(Deserialize)]
pub struct Guard { pub path: String, pub revision: String }
#[derive(Deserialize)]
pub struct Operation { pub relocation: Option<PathMove>, pub writes: Vec<FileWrite>, pub guards: Vec<Guard>, #[serde(default)] pub folders: Vec<String>, #[serde(default)] pub deletes: Vec<Guard>, #[serde(default, rename = "acceptMoves")] pub accept_moves: bool }
#[derive(Serialize, Deserialize)]
struct Backup { path: String, before: Option<String>, after: Option<String> }
#[derive(Serialize, Deserialize)]
struct Journal { version: u8, committed: bool, relocation: Option<PathMove>, staging: Option<String>, files: Vec<Backup>, directories: Vec<String> }

pub(crate) fn map_path(path: &str, moves: &[PathMove]) -> String {
    moves.iter().filter(|m| path == m.from || path.starts_with(&(m.from.clone() + "/"))).max_by_key(|m| m.from.len())
        .map(|m| format!("{}{}", m.to, &path[m.from.len()..])).unwrap_or_else(|| path.into())
}

#[cfg(test)]
mod tests {
    use super::*;
    fn write(path: &str, content: &str, revision: Option<String>) -> FileWrite { FileWrite { path: path.into(), content: content.into(), expected_revision: revision } }
    fn operation(writes: Vec<FileWrite>, relocation: Option<PathMove>) -> Operation { Operation { writes, relocation, guards: vec![], folders: vec![], deletes: vec![], accept_moves: false } }
    #[test]
    fn materials_register_and_merge_with_references_in_one_operation() {
        let dir = tempfile::tempdir().unwrap(); let vault = Vault::open(dir.path().to_str().unwrap(), true).unwrap();
        let note = vault.create_note("参照元").unwrap();
        vault.apply_operation(operation(vec![write("資料/旧.md", "---\ntitle: 旧\n---\n本文A", None), write("資料/新.md", "---\ntitle: 新\n---\n本文B", None)], None)).unwrap();
        let first = vault.read("資料/旧.md").unwrap(); let second = vault.read("資料/新.md").unwrap();
        let mut merge = operation(vec![write("資料/旧.md", "統合した本文AとB", Some(first.revision)), write(&note.path, "[資料](file:///C:/new.xlsx)", Some(note.revision))], None);
        merge.deletes.push(Guard { path: second.path, revision: second.revision });
        let catalog = vault.apply_operation(merge).unwrap();
        assert_eq!(catalog.snapshot.materials.len(), 1); assert_eq!(vault.read("資料/旧.md").unwrap().content, "統合した本文AとB");
        assert!(vault.read("資料/新.md").is_err()); assert!(vault.read(&note.path).unwrap().content.contains("new.xlsx"));
    }
    #[test]
    fn interrupted_material_merge_restores_deleted_page_and_does_not_overwrite_conflicts() {
        let dir = tempfile::tempdir().unwrap(); let vault = Vault::open(dir.path().to_str().unwrap(), true).unwrap();
        vault.save("資料/一.md", "統合前A", None).unwrap(); vault.save("資料/二.md", "統合前B", None).unwrap();
        let journal = Journal { version: 1, committed: false, relocation: None, staging: None, files: vec![Backup { path: "資料/一.md".into(), before: Some("統合前A".into()), after: Some("統合後AB".into()) }, Backup { path: "資料/二.md".into(), before: Some("統合前B".into()), after: None }], directories: vec![] };
        atomic_write(&vault.journal_path().unwrap(), &serde_json::to_vec(&journal).unwrap()).unwrap();
        fs::write(dir.path().join("資料/一.md"), "統合後AB").unwrap(); fs::remove_file(dir.path().join("資料/二.md")).unwrap();
        vault.recover_operation().unwrap(); assert_eq!(vault.read("資料/一.md").unwrap().content, "統合前A"); assert_eq!(vault.read("資料/二.md").unwrap().content, "統合前B");
        atomic_write(&vault.journal_path().unwrap(), &serde_json::to_vec(&journal).unwrap()).unwrap(); fs::write(dir.path().join("資料/二.md"), "外部で変更").unwrap();
        assert!(vault.recover_operation().is_err()); assert_eq!(vault.read("資料/二.md").unwrap().content, "外部で変更");
    }
    #[test]
    fn stale_material_merge_makes_no_changes_and_only_materials_can_be_removed() {
        let dir = tempfile::tempdir().unwrap(); let vault = Vault::open(dir.path().to_str().unwrap(), true).unwrap();
        let source = vault.save("資料/旧.md", "元の情報", None).unwrap(); let note = vault.create_note("通常メモ").unwrap();
        let mut merge = operation(vec![write("資料/別.md", "新しい情報", None)], None);
        merge.deletes.push(Guard { path: source.path.clone(), revision: "古いリビジョン".into() });
        assert!(vault.apply_operation(merge).is_err()); assert!(!dir.path().join("資料/別.md").exists()); assert_eq!(vault.read(&source.path).unwrap().content, "元の情報");
        let mut remove_note = operation(vec![], None); remove_note.deletes.push(Guard { path: note.path.clone(), revision: note.revision });
        assert!(vault.apply_operation(remove_note).is_err()); assert!(vault.read(&note.path).is_ok());
    }
    #[test]
    fn rename_and_references_commit_together_preserving_raw_text() {
        let dir = tempfile::tempdir().unwrap(); let vault = Vault::open(dir.path().to_str().unwrap(), true).unwrap();
        let note = vault.create_note("旧名").unwrap(); let reference = vault.create_note("参照元").unwrap();
        let content = "\u{feff}# 記録\r\n[[新名]]\r\n";
        let result = vault.apply_operation(operation(vec![write(&reference.path, content, Some(reference.revision))], Some(PathMove { from: note.path, to: "メモ/整理/新名.md".into() }))).unwrap();
        assert!(result.snapshot.notes.iter().any(|file| file.path == "メモ/整理/新名.md"));
        assert_eq!(vault.read("メモ/参照元.md").unwrap().content, content);
        assert!(!dir.path().join("メモ/旧名.md").exists());
        assert!(!dir.path().join(".lamina/operations/current.json").exists());
    }
    #[test]
    fn collision_stale_revision_and_escape_make_no_changes() {
        let dir = tempfile::tempdir().unwrap(); let vault = Vault::open(dir.path().to_str().unwrap(), true).unwrap();
        let first = vault.create_note("一").unwrap(); vault.create_note("二").unwrap();
        assert!(vault.apply_operation(operation(vec![], Some(PathMove { from: first.path.clone(), to: "メモ/二.md".into() }))).is_err());
        fs::write(dir.path().join(&first.path), "外部で変更").unwrap();
        assert!(vault.apply_operation(operation(vec![write(&first.path, "更新", Some(first.revision))], None)).is_err());
        assert!(vault.apply_operation(operation(vec![], Some(PathMove { from: first.path.clone(), to: "メモ/../../outside.md".into() }))).is_err());
        assert_eq!(vault.read(&first.path).unwrap().content, "外部で変更");
        assert!(dir.path().join("メモ/二.md").exists());
    }
    #[test]
    fn interrupted_move_and_partial_writes_roll_back_on_open() {
        let dir = tempfile::tempdir().unwrap(); let vault = Vault::open(dir.path().to_str().unwrap(), true).unwrap();
        vault.create_note("旧名").unwrap(); vault.create_note("参照元").unwrap();
        let journal = Journal { version: 1, committed: false, relocation: Some(PathMove { from: "メモ/旧名.md".into(), to: "メモ/新名.md".into() }), staging: Some("メモ/.lamina-stage-test".into()), files: vec![Backup { path: "メモ/新名.md".into(), before: Some("".into()), after: Some("変更後".into()) }, Backup { path: "メモ/参照元.md".into(), before: Some("".into()), after: Some("[[新名]]".into()) }], directories: vec![] };
        atomic_write(&vault.journal_path().unwrap(), &serde_json::to_vec(&journal).unwrap()).unwrap();
        fs::rename(dir.path().join("メモ/旧名.md"), dir.path().join("メモ/新名.md")).unwrap();
        fs::write(dir.path().join("メモ/新名.md"), "変更後").unwrap();
        let reopened = Vault::open(dir.path().to_str().unwrap(), false).unwrap();
        assert_eq!(reopened.read("メモ/旧名.md").unwrap().content, "");
        assert_eq!(reopened.read("メモ/参照元.md").unwrap().content, "");
        assert!(!dir.path().join("メモ/新名.md").exists());
    }
    #[test]
    fn recovery_does_not_overwrite_subsequent_external_edits() {
        let dir = tempfile::tempdir().unwrap(); let vault = Vault::open(dir.path().to_str().unwrap(), true).unwrap();
        vault.create_note("原文").unwrap();
        let journal = Journal { version: 1, committed: false, relocation: None, staging: None, files: vec![Backup { path: "メモ/原文.md".into(), before: Some("".into()), after: Some("アプリ変更".into()) }], directories: vec![] };
        atomic_write(&vault.journal_path().unwrap(), &serde_json::to_vec(&journal).unwrap()).unwrap();
        fs::write(dir.path().join("メモ/原文.md"), "外部で追記").unwrap();
        assert!(Vault::open(dir.path().to_str().unwrap(), false).is_err());
        assert_eq!(fs::read_to_string(dir.path().join("メモ/原文.md")).unwrap(), "外部で追記");
        assert!(vault.journal_path().unwrap().exists());
    }
    #[test]
    fn extracts_into_new_file_and_supports_case_only_rename() {
        let dir = tempfile::tempdir().unwrap(); let vault = Vault::open(dir.path().to_str().unwrap(), true).unwrap();
        let first = vault.create_note("Note").unwrap();
        vault.apply_operation(operation(vec![write(&first.path, "[[知見]]", Some(first.revision)), write("メモ/知見.md", "切り出した本文", None)], Some(PathMove { from: first.path, to: "メモ/note.md".into() }))).unwrap();
        assert_eq!(vault.read("メモ/note.md").unwrap().content, "[[知見]]");
        assert_eq!(vault.read("メモ/知見.md").unwrap().content, "切り出した本文");
        assert!(vault.snapshot().unwrap().notes.iter().any(|entry| entry.name == "note.md"));
    }
    #[test]
    fn moves_a_folder_with_nested_notes_and_preserves_other_files() {
        let dir = tempfile::tempdir().unwrap(); let vault = Vault::open(dir.path().to_str().unwrap(), true).unwrap();
        fs::create_dir_all(dir.path().join("メモ/設計/補足")).unwrap();
        fs::write(dir.path().join("メモ/設計/原文.md"), "原文").unwrap();
        fs::write(dir.path().join("メモ/設計/補足/詳細.md"), "詳細").unwrap();
        fs::write(dir.path().join("メモ/設計/data.txt"), "添付されたデータ").unwrap();
        let result = vault.apply_operation(operation(vec![], Some(PathMove { from: "メモ/設計".into(), to: "メモ/整理/設計".into() }))).unwrap();
        assert!(result.snapshot.notes.iter().any(|note| note.path == "メモ/整理/設計/補足/詳細.md"));
        assert_eq!(fs::read_to_string(dir.path().join("メモ/整理/設計/data.txt")).unwrap(), "添付されたデータ");
        assert!(!dir.path().join("メモ/設計").exists());
    }
    #[test]
    fn recovers_a_move_interrupted_at_the_staging_path() {
        let dir = tempfile::tempdir().unwrap(); let vault = Vault::open(dir.path().to_str().unwrap(), true).unwrap();
        vault.create_note("原文").unwrap();
        let journal = Journal { version: 1, committed: false, relocation: Some(PathMove { from: "メモ/原文.md".into(), to: "メモ/改名.md".into() }), staging: Some("メモ/.lamina-stage-interrupted".into()), files: vec![Backup { path: "メモ/改名.md".into(), before: Some("".into()), after: Some("新しい本文".into()) }], directories: vec![] };
        atomic_write(&vault.journal_path().unwrap(), &serde_json::to_vec(&journal).unwrap()).unwrap();
        fs::rename(dir.path().join("メモ/原文.md"), dir.path().join("メモ/.lamina-stage-interrupted")).unwrap();
        let reopened = Vault::open(dir.path().to_str().unwrap(), false).unwrap();
        assert_eq!(reopened.read("メモ/原文.md").unwrap().content, "");
        assert!(!dir.path().join("メモ/.lamina-stage-interrupted").exists());
    }
}
pub(crate) fn atomic_write(path: &Path, bytes: &[u8]) -> Result<(), String> {
    let temp = path.with_file_name(format!(".lamina-write-{}-{}.tmp", std::process::id(), COUNTER.fetch_add(1, Ordering::Relaxed)));
    let result = (|| {
        let mut file = OpenOptions::new().create_new(true).write(true).open(&temp).map_err(io_error)?;
        file.write_all(bytes).map_err(io_error)?; file.sync_all().map_err(io_error)?; drop(file);
        fs::rename(&temp, path).map_err(io_error)
    })();
    if result.is_err() { let _ = fs::remove_file(temp); }
    result
}
impl Vault {
    pub(crate) fn management_dir(&self) -> Result<PathBuf, String> {
        let path = self.root.join(".lamina");
        if !path.exists() { fs::create_dir(&path).map_err(io_error)?; }
        self.check_existing(&path)?; Ok(path)
    }
    pub(crate) fn operation_path(&self, value: &str) -> Result<PathBuf, String> {
        let relative = Path::new(value);
        let parts: Vec<_> = relative.components().collect();
        if parts.is_empty() || parts.len() < 2 && value != "資料" || parts.iter().any(|part| !matches!(part, Component::Normal(_))) { return Err("保管庫内のフォルダーまたはファイルを指定してください。".into()); }
        if parts[0].as_os_str() != "メモ" && parts[0].as_os_str() != "テーマ" && parts[0].as_os_str() != "資料" { return Err("保管庫のMarkdownの分類内で移動してください。".into()); }
        for part in &parts { validate_name(&part.as_os_str().to_string_lossy())?; }
        Ok(self.root.join(relative))
    }
    fn journal_path(&self) -> Result<PathBuf, String> {
        let folder = self.management_dir()?.join("operations");
        if !folder.exists() { fs::create_dir(&folder).map_err(io_error)?; }
        self.check_existing(&folder)?; Ok(folder.join("current.json"))
    }
    fn ensure_parent(&self, path: &Path) -> Result<(), String> {
        let relative = path.strip_prefix(&self.root).map_err(io_error)?;
        let mut current = self.root.clone();
        for component in relative.components() {
            current.push(component.as_os_str());
            if !current.exists() { fs::create_dir(&current).map_err(io_error)?; }
            self.check_existing(&current)?;
            if !current.is_dir() { return Err("保存先に同名のファイルがあります。".into()); }
        }
        Ok(())
    }
    fn exact_exists(&self, relative: &str) -> bool {
        let mut current = self.root.clone();
        for part in Path::new(relative).components() {
            let Ok(entries) = fs::read_dir(&current) else { return false; };
            let Some(entry) = entries.filter_map(Result::ok).find(|entry| entry.file_name() == part.as_os_str()) else { return false; };
            current = entry.path();
        }
        true
    }
    pub fn recover_operation(&self) -> Result<(), String> {
        let folder = self.root.join(".lamina/operations");
        if !folder.exists() { return Ok(()); }
        self.check_existing(&folder)?;
        let path = folder.join("current.json");
        if !path.exists() { return Ok(()); }
        self.check_existing(&path)?;
        let journal: Journal = serde_json::from_slice(&fs::read(&path).map_err(io_error)?).map_err(|_| "未完了操作の記録を読み込めません。元のファイルを保護するため処理を止めました。")?;
        if journal.version != 1 { return Err("未対応の回復記録です。".into()); }
        if journal.committed { fs::remove_file(path).map_err(io_error)?; return Ok(()); }
        if let Some(movement) = &journal.relocation {
            let source = self.operation_path(&movement.from)?;
            let destination = self.operation_path(&movement.to)?;
            let staging = self.operation_path(journal.staging.as_deref().ok_or("移動の回復記録が不正です。")?)?;
            if staging.exists() { self.check_existing(&staging)?; fs::rename(&staging, &source).map_err(io_error)?; }
            else if self.exact_exists(&movement.to) && !self.exact_exists(&movement.from) {
                self.check_existing(&destination)?; fs::rename(&destination, &staging).map_err(io_error)?; fs::rename(&staging, &source).map_err(io_error)?;
            }
        }
        let inverse: Vec<_> = journal.relocation.iter().map(|movement| PathMove { from: movement.to.clone(), to: movement.from.clone() }).collect();
        for backup in journal.files.iter().rev() {
            let file = self.relative_path(&map_path(&backup.path, &inverse))?;
            if !file.exists() {
                if backup.after.is_none() { if let Some(before) = &backup.before { self.check_existing(file.parent().ok_or("回復先が不正です。")?)?; atomic_write(&file, before.as_bytes())?; } continue; }
                if backup.before.is_some() { return Err(format!("回復対象がありません: {}", backup.path)); } else { continue; }
            }
            self.check_existing(&file)?;
            let bytes = fs::read(&file).map_err(io_error)?;
            if backup.before.as_ref().is_some_and(|before| before.as_bytes() == bytes) { continue; }
            if !backup.after.as_ref().is_some_and(|after| digest(&bytes) == digest(after.as_bytes())) { return Err(format!("回復対象が外部で変更されています。上書きしていません: {}", backup.path)); }
            if let Some(before) = &backup.before { atomic_write(&file, before.as_bytes())?; } else { fs::remove_file(&file).map_err(io_error)?; }
        }
        for directory in journal.directories.iter().rev() { let path = self.operation_path(directory)?; if path.exists() { self.check_existing(&path)?; let _ = fs::remove_dir(path); } }
        fs::remove_file(path).map_err(io_error)
    }
    pub fn apply_operation(&self, operation: Operation) -> Result<Catalog, String> {
        self.recover_operation()?;
        if !operation.accept_moves && !self.catalog()?.moves.is_empty() { return Err("移動されたファイルがあります。保管庫を再読み込みしてから操作してください。".into()); }
        for guard in &operation.guards { if self.read(&guard.path)?.revision != guard.revision { return Err(format!("別のアプリで変更されています。再読み込みしてから操作してください: {}", guard.path)); } }
        if operation.writes.is_empty() && operation.relocation.is_none() && operation.folders.is_empty() && operation.deletes.is_empty() { self.commit_tracking()?; return self.catalog(); }
        let moves: Vec<PathMove> = operation.relocation.clone().into_iter().collect();
        if let Some(movement) = &operation.relocation {
            let source = self.operation_path(&movement.from)?;
            let destination = self.operation_path(&movement.to)?;
            self.check_existing(&source)?;
            if movement.from == movement.to { return Err("現在とは異なる名前・場所を指定してください。".into()); }
            if movement.from.split('/').next() != movement.to.split('/').next() || movement.to.starts_with(&(movement.from.clone() + "/")) { return Err("同じ分類内の別の場所へ移動してください。".into()); }
            if destination.exists() && !movement.from.eq_ignore_ascii_case(&movement.to) { return Err("移動先に同名の項目があります。上書きしていません。".into()); }
            if source.is_file() && (source.extension().is_none_or(|ext| ext != "md") || destination.extension().is_none_or(|ext| ext != "md")) { return Err("Markdownの拡張子は変更できません。".into()); }
        }
        let mut files = Vec::new(); let mut targets = HashSet::new(); let mut directories = Vec::new();
        let mut parents = operation.folders.clone();
        if let Some(movement) = &operation.relocation { if let Some(parent) = Path::new(&movement.to).parent() { parents.push(parent.to_string_lossy().replace('\\', "/")); } }
        for write in &operation.writes {
            self.relative_path(&write.path)?;
            let path = map_path(&write.path, &moves);
            if !targets.insert(path.to_lowercase()) { return Err("同じファイルへの変更が重複しています。".into()); }
            let original = self.relative_path(&write.path)?;
            let before = if original.exists() {
                let current = self.read(&write.path)?;
                if write.expected_revision.as_ref() != Some(&current.revision) { return Err(format!("外部変更または同名ファイルがあります: {}", write.path)); }
                Some(current.content)
            } else { if write.expected_revision.is_some() { return Err(format!("元のファイルがありません: {}", write.path)); } None };
            if let Some(parent) = Path::new(&path).parent() { parents.push(parent.to_string_lossy().replace('\\', "/")); }
            files.push(Backup { path, before, after: Some(write.content.clone()) });
        }
        for delete in &operation.deletes {
            if !delete.path.starts_with("資料/") || operation.relocation.is_some() { return Err("統合による削除は資料ページだけが対象です。".into()); }
            if !targets.insert(delete.path.to_lowercase()) { return Err("同じファイルへの変更が重複しています。".into()); }
            let file = self.read(&delete.path)?;
            if file.revision != delete.revision { return Err(format!("統合する資料が外部で変更されています: {}", delete.path)); }
            files.push(Backup { path: delete.path.clone(), before: Some(file.content), after: None });
        }
        for folder in &operation.folders { let path = self.operation_path(folder)?; if path.exists() { return Err("同名のフォルダーまたはファイルがあります。".into()); } }
        for parent in parents {
            let mut relative = String::new();
            for part in parent.split('/') {
                if !relative.is_empty() { relative.push('/'); } relative.push_str(part);
                if relative == "メモ" || relative == "テーマ" { self.check_existing(&self.root.join(&relative))?; continue; }
                if relative == "資料" { let path = self.root.join(&relative); if path.exists() { self.check_existing(&path)?; } else if !directories.contains(&relative) { directories.push(relative.clone()); } continue; }
                let path = self.operation_path(&relative)?;
                if path.exists() { self.check_existing(&path)?; } else if !directories.contains(&relative) { directories.push(relative.clone()); }
            }
        }
        directories.sort_by_key(|path| path.split('/').count());
        let staging = operation.relocation.as_ref().map(|movement| format!("{}/.lamina-stage-{}-{}", movement.from.rsplit_once('/').unwrap().0, std::process::id(), COUNTER.fetch_add(1, Ordering::Relaxed)));
        let mut journal = Journal { version: 1, committed: false, relocation: operation.relocation, staging, files, directories };
        let path = self.journal_path()?;
        atomic_write(&path, &serde_json::to_vec(&journal).map_err(io_error)?)?;
        let result = (|| {
            for directory in &journal.directories { self.ensure_parent(&self.operation_path(directory)?)?; }
            if let Some(movement) = &journal.relocation {
                let staging = self.operation_path(journal.staging.as_ref().unwrap())?;
                fs::rename(self.operation_path(&movement.from)?, &staging).map_err(io_error)?;
                fs::rename(&staging, self.operation_path(&movement.to)?).map_err(io_error)?;
            }
            for backup in &journal.files {
                let file = self.relative_path(&backup.path)?;
                if file.exists() { self.check_existing(&file)?; }
                let current = if file.exists() { Some(fs::read(&file).map_err(io_error)?) } else { None };
                if current.as_deref() != backup.before.as_ref().map(|before| before.as_bytes()) { return Err(format!("保存直前に外部変更がありました: {}", backup.path)); }
                if let Some(after) = &backup.after { atomic_write(&file, after.as_bytes())?; } else { fs::remove_file(&file).map_err(io_error)?; }
            }
            self.commit_tracking()?;
            journal.committed = true;
            atomic_write(&path, &serde_json::to_vec(&journal).map_err(io_error)?)?;
            fs::remove_file(&path).map_err(io_error)?;
            self.catalog()
        })();
        if let Err(error) = result { return match self.recover_operation() { Ok(()) => Err(error), Err(recovery) => Err(format!("{error}\n回復処理: {recovery}")) }; }
        result
    }
}
