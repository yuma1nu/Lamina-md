use crate::{catalog::Catalog, vault::{digest, io_error, Vault}};
use std::{fs, path::Component, sync::atomic::{AtomicU64, Ordering}, time::{SystemTime, UNIX_EPOCH}};

static NEXT: AtomicU64 = AtomicU64::new(0);

impl Vault {
    pub fn trash_note(&self, path: &str, expected_revision: &str) -> Result<Catalog, String> {
        self.recover_operation()?;
        let source = self.relative_path(path)?;
        if !path.starts_with("メモ/") || fs::symlink_metadata(&source).map_err(io_error)?.file_type().is_symlink() {
            return Err("削除できるのは通常のメモだけです。".into());
        }
        self.check_existing(&source)?;
        if self.read(path)?.revision != expected_revision { return Err("メモが外部で変更されています。再読み込みしてから削除してください。".into()); }
        if !self.catalog()?.moves.is_empty() { return Err("移動されたファイルがあります。再読み込みしてから削除してください。".into()); }
        let mut destination = self.management_dir()?;
        let id = format!("{}-{}-{}", SystemTime::now().duration_since(UNIX_EPOCH).map_err(io_error)?.as_nanos(), std::process::id(), NEXT.fetch_add(1, Ordering::Relaxed));
        let folders = std::path::Path::new("trash").join(id).join(std::path::Path::new(path).parent().ok_or("削除元のパスが不正です。")?);
        for component in folders.components() {
            let Component::Normal(part) = component else { return Err("削除先のパスが不正です。".into()); };
            destination.push(part);
            if !destination.exists() { fs::create_dir(&destination).map_err(io_error)?; }
            self.check_existing(&destination)?;
        }
        destination.push(source.file_name().ok_or("削除元のファイル名が不正です。")?);
        if destination.exists() { return Err("削除したメモの保存先が使用中です。".into()); }
        // A rename on the same volume keeps the original bytes intact. The
        // deleted note is outside the catalog and can be recovered manually.
        fs::rename(&source, &destination).map_err(io_error)?;
        let result = (|| {
            if digest(&fs::read(&destination).map_err(io_error)?) != expected_revision { return Err("削除直前にメモが外部で変更されました。元に戻します。".into()); }
            self.commit_tracking()?;
            self.catalog()
        })();
        if let Err(error) = result {
            if source.exists() { return Err(format!("{error}\n元の場所に別のファイルがあります。削除したメモは {} に保持しています。", destination.display())); }
            fs::rename(&destination, &source).map_err(|restore| format!("{error}\n復元に失敗しました: {restore}\n元のメモは {} に保持しています。", destination.display()))?;
            let _ = self.commit_tracking();
            return Err(error);
        }
        result
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn deletion_retains_original_bytes_and_removes_only_the_note_from_catalog() {
        let dir = tempfile::tempdir().unwrap(); let vault = Vault::open(dir.path().to_str().unwrap(), true).unwrap();
        let content = "\u{feff}# 記録\r\n本文\r\n";
        fs::create_dir(dir.path().join("メモ/整理")).unwrap();
        let note = vault.save("メモ/整理/対象.md", content, None).unwrap();
        let other = vault.save("メモ/参照元.md", "[[整理/対象]]", None).unwrap();
        let catalog = vault.trash_note(&note.path, &note.revision).unwrap();
        assert!(!dir.path().join(&note.path).exists()); assert_eq!(catalog.snapshot.notes.len(), 1);
        let trash = fs::read_dir(dir.path().join(".lamina/trash")).unwrap().next().unwrap().unwrap().path();
        assert_eq!(fs::read(trash.join("メモ/整理/対象.md")).unwrap(), content.as_bytes());
        assert_eq!(vault.read(&other.path).unwrap().content, "[[整理/対象]]");
        assert!(catalog.moves.is_empty());
    }
    #[test]
    fn stale_revision_and_non_note_paths_are_rejected_without_deletion() {
        let dir = tempfile::tempdir().unwrap(); let vault = Vault::open(dir.path().to_str().unwrap(), true).unwrap();
        let note = vault.create_note("対象").unwrap();
        assert!(vault.trash_note(&note.path, "古い版").is_err()); assert!(vault.read(&note.path).is_ok());
        let material = vault.save("資料/対象.md", "内容", None).unwrap();
        assert!(vault.trash_note(&material.path, &material.revision).is_err()); assert!(vault.read(&material.path).is_ok());
        assert!(vault.trash_note("メモ/../対象.md", "").is_err());
    }
}
