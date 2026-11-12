use crate::{operations::atomic_write, vault::{digest, io_error, Vault}};
use base64::{engine::general_purpose::STANDARD, Engine};
use serde::{Deserialize, Serialize};
use std::{fs, path::{Component, Path, PathBuf}, sync::atomic::{AtomicU64, Ordering}};

static IMAGE_COUNTER: AtomicU64 = AtomicU64::new(0);
const MAX_BYTES: usize = 32 * 1024 * 1024;
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ImageFile { pub path: String, pub data: String, pub mime: String, pub revision: String, pub annotation: Option<serde_json::Value>, pub original: Option<String> }
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ImageWrite { pub path: Option<String>, pub original: String, pub rendered: String, pub annotation: serde_json::Value, pub expected_revision: Option<String> }
#[derive(Serialize, Deserialize)]
struct ImageJournal { version: u8, path: String, before_annotation: String, after_annotation: String, before_rendered: String, after_rendered: String, committed: bool }

fn bytes(encoded: &str) -> Result<Vec<u8>, String> {
    if encoded.len() > MAX_BYTES * 4 / 3 + 4 { return Err("画像は32MB以下にしてください。".into()); }
    STANDARD.decode(encoded).map_err(|_| "画像データを読み込めませんでした。".into())
}

#[cfg(test)]
mod tests {
    use super::*;
    const PNG: &str = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg==";
    fn annotation(text: &str) -> serde_json::Value { serde_json::json!({ "version": 1, "width": 1, "height": 1, "shapes": [], "test": text }) }
    fn create(vault: &Vault) -> ImageFile { vault.write_image(ImageWrite { path: None, original: PNG.into(), rendered: PNG.into(), annotation: annotation("before"), expected_revision: None }).unwrap() }
    #[test]
    fn imports_and_reopens_editable_images_without_changing_resolution() {
        let dir = tempfile::tempdir().unwrap(); let vault = Vault::open(dir.path().to_str().unwrap(), true).unwrap();
        let image = create(&vault);
        assert_eq!(image.original.as_deref(), Some(PNG));
        let updated = vault.write_image(ImageWrite { path: Some(image.path.clone()), original: PNG.into(), rendered: PNG.into(), annotation: annotation("after"), expected_revision: Some(image.revision.clone()) }).unwrap();
        assert_ne!(updated.revision, image.revision);
        assert!(vault.write_image(ImageWrite { path: Some(image.path.clone()), original: PNG.into(), rendered: PNG.into(), annotation: annotation("stale"), expected_revision: Some(image.revision) }).is_err());
        let reopened = Vault::open(dir.path().to_str().unwrap(), false).unwrap().read_image(&image.path, true).unwrap();
        assert_eq!(reopened.annotation.unwrap()["test"], "after");
        assert!(!dir.path().join(".lamina/image-operation.json").exists());
    }
    #[test]
    fn rejects_escaping_paths_bad_dimensions_and_unrecognized_metadata() {
        let dir = tempfile::tempdir().unwrap(); let vault = Vault::open(dir.path().to_str().unwrap(), true).unwrap();
        assert!(vault.read_image("../outside.png", false).is_err());
        assert!(vault.read_image(".lamina/file.png", false).is_err());
        let bad = serde_json::json!({"version":1,"width":2,"height":1,"shapes":[]});
        assert!(vault.write_image(ImageWrite { path: None, original: PNG.into(), rendered: PNG.into(), annotation: bad, expected_revision: None }).is_err());
    }
    #[test]
    fn recovers_partial_annotation_writes_and_preserves_external_conflicts() {
        let dir = tempfile::tempdir().unwrap(); let vault = Vault::open(dir.path().to_str().unwrap(), true).unwrap(); let image = create(&vault);
        let folder = vault.bundle_folder(&image.path).unwrap();
        let before = fs::read(folder.join("annotation.json")).unwrap(); let after = serde_json::to_vec(&annotation("after")).unwrap();
        let journal = ImageJournal { version:1, path:image.path.clone(), before_annotation:STANDARD.encode(&before), after_annotation:STANDARD.encode(&after), before_rendered:PNG.into(), after_rendered:PNG.into(), committed:false };
        let record = vault.management_dir().unwrap().join("image-operation.json");
        fs::write(&record, serde_json::to_vec(&journal).unwrap()).unwrap(); fs::write(folder.join("annotation.json"), &after).unwrap();
        Vault::open(dir.path().to_str().unwrap(), false).unwrap(); assert_eq!(fs::read(folder.join("annotation.json")).unwrap(), before);
        fs::write(&record, serde_json::to_vec(&journal).unwrap()).unwrap(); fs::write(folder.join("annotation.json"), "external edit").unwrap();
        assert!(Vault::open(dir.path().to_str().unwrap(), false).is_err());
        assert_eq!(fs::read_to_string(folder.join("annotation.json")).unwrap(), "external edit"); assert!(record.exists());
    }
}
fn png_size(data: &[u8]) -> Result<(u32, u32), String> {
    if data.len() < 33 || &data[..8] != b"\x89PNG\r\n\x1a\n" || &data[12..16] != b"IHDR" { return Err("PNG画像の形式が不正です。".into()); }
    let width = u32::from_be_bytes(data[16..20].try_into().unwrap());
    let height = u32::from_be_bytes(data[20..24].try_into().unwrap());
    if width == 0 || height == 0 || u64::from(width) * u64::from(height) > 40_000_000 { return Err("画像は4,000万画素以下にしてください。".into()); }
    Ok((width, height))
}
fn check_annotation(value: &serde_json::Value, size: (u32, u32)) -> Result<Vec<u8>, String> {
    if value["version"].as_u64() != Some(1) || value["width"].as_u64() != Some(size.0.into()) || value["height"].as_u64() != Some(size.1.into()) || !value["shapes"].as_array().is_some_and(|shapes| shapes.len() <= 2000) { return Err("注釈データの形式・画像サイズが一致しません。".into()); }
    let data = serde_json::to_vec_pretty(value).map_err(io_error)?;
    if data.len() > 2 * 1024 * 1024 { return Err("注釈データが大きすぎます。".into()); }
    Ok(data)
}
impl Vault {
    fn image_path(&self, relative: &str) -> Result<PathBuf, String> {
        let path = Path::new(relative);
        if path.components().any(|part| !matches!(part, Component::Normal(_))) || path.components().next().is_none() || relative.contains(':') || relative.split(['/', '\\']).any(|p| p.starts_with('.')) { return Err("保管庫内の画像パスを指定してください。".into()); }
        let extension = path.extension().and_then(|s| s.to_str()).unwrap_or("").to_ascii_lowercase();
        if !matches!(extension.as_str(), "png" | "jpg" | "jpeg" | "gif" | "webp" | "bmp") { return Err("対応していない画像形式です。".into()); }
        self.check_existing(&self.root.join(path))
    }
    fn bundle_folder(&self, path: &str) -> Result<PathBuf, String> {
        let parts: Vec<_> = path.split('/').collect();
        if parts.len() != 3 || parts[0] != "添付" || parts[2] != "rendered.png" || parts[1].is_empty() || !parts[1].chars().all(|c| c.is_ascii_alphanumeric() || c == '-') { return Err("この画像には注釈の保存情報がありません。".into()); }
        let target = self.image_path(path)?;
        Ok(target.parent().unwrap().to_owned())
    }
    pub fn read_image(&self, path: &str, editing: bool) -> Result<ImageFile, String> {
        let target = self.image_path(path)?;
        let data = fs::read(&target).map_err(io_error)?;
        if data.len() > MAX_BYTES { return Err("画像は32MB以下にしてください。".into()); }
        let mime = match target.extension().and_then(|s| s.to_str()).unwrap_or("").to_ascii_lowercase().as_str() { "jpg" | "jpeg" => "image/jpeg", "gif" => "image/gif", "webp" => "image/webp", "bmp" => "image/bmp", _ => "image/png" };
        let mut revision_data = data.clone(); let mut annotation = None; let mut original = None;
        if let Ok(folder) = self.bundle_folder(path) {
            let metadata_path = folder.join("annotation.json"); let original_path = folder.join("original.png");
            self.check_existing(&metadata_path)?; self.check_existing(&original_path)?;
            let metadata = fs::read(metadata_path).map_err(io_error)?;
            if metadata.len() > 2 * 1024 * 1024 { return Err("注釈データが大きすぎます。".into()); }
            revision_data.extend_from_slice(&metadata);
            if editing {
                let value = serde_json::from_slice(&metadata).map_err(|_| "注釈データが破損しています。元のデータは変更しません。")?;
                let source = fs::read(original_path).map_err(io_error)?;
                if source.len() > MAX_BYTES { return Err("元画像が大きすぎます。".into()); }
                check_annotation(&value, png_size(&source)?)?;
                original = Some(STANDARD.encode(source)); annotation = Some(value);
            }
        }
        Ok(ImageFile { path: path.into(), data: STANDARD.encode(data), mime: mime.into(), revision: digest(&revision_data), annotation, original })
    }
    pub fn write_image(&self, write: ImageWrite) -> Result<ImageFile, String> {
        self.recover_image()?;
        let original = bytes(&write.original)?; let rendered = bytes(&write.rendered)?;
        let size = png_size(&original)?;
        if png_size(&rendered)? != size { return Err("元画像の解像度を変更できません。".into()); }
        let annotation = check_annotation(&write.annotation, size)?;
        if let Some(path) = write.path {
            let folder = self.bundle_folder(&path)?;
            let current = self.read_image(&path, true)?;
            if write.expected_revision.as_deref() != Some(&current.revision) || current.original.as_deref() != Some(&write.original) { return Err("画像が別の場所で変更されています。注釈の編集内容は保持しています。".into()); }
            let previous = fs::read(folder.join("annotation.json")).map_err(io_error)?;
            let mut journal = ImageJournal { version: 1, path: path.clone(), before_annotation: STANDARD.encode(previous), after_annotation: STANDARD.encode(&annotation), before_rendered: current.data, after_rendered: write.rendered, committed: false };
            let record = self.management_dir()?.join("image-operation.json");
            atomic_write(&record, &serde_json::to_vec(&journal).map_err(io_error)?)?;
            let result = (|| {
                atomic_write(&folder.join("annotation.json"), &annotation)?;
                atomic_write(&folder.join("rendered.png"), &rendered)?;
                journal.committed = true;
                atomic_write(&record, &serde_json::to_vec(&journal).map_err(io_error)?)?;
                fs::remove_file(&record).map_err(io_error)
            })();
            if let Err(error) = result { self.recover_image().map_err(|recovery| format!("{error}\n{recovery}"))?; return Err(error); }
            self.read_image(&path, true)
        } else {
            let attachments = self.root.join("添付");
            if !attachments.exists() { fs::create_dir(&attachments).map_err(io_error)?; }
            self.check_existing(&attachments)?;
            let stamp = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map_err(io_error)?.as_millis();
            let id = format!("{stamp}-{}-{}", std::process::id(), IMAGE_COUNTER.fetch_add(1, Ordering::Relaxed));
            let staging = attachments.join(format!(".lamina-image-{id}")); let destination = attachments.join(&id);
            fs::create_dir(&staging).map_err(io_error)?;
            atomic_write(&staging.join("original.png"), &original)?;
            atomic_write(&staging.join("annotation.json"), &annotation)?;
            atomic_write(&staging.join("rendered.png"), &rendered)?;
            fs::rename(&staging, &destination).map_err(io_error)?;
            self.read_image(&format!("添付/{id}/rendered.png"), true)
        }
    }
    pub fn recover_image(&self) -> Result<(), String> {
        let path = self.root.join(".lamina/image-operation.json");
        if !path.exists() { return Ok(()); }
        self.check_existing(&path)?;
        let journal: ImageJournal = serde_json::from_slice(&fs::read(&path).map_err(io_error)?).map_err(|_| "画像の回復記録を読み込めません。".to_owned())?;
        if journal.version != 1 { return Err("画像の回復記録の形式が未対応です。".into()); }
        if !journal.committed {
            let folder = self.bundle_folder(&journal.path)?;
            let entries = [("annotation.json", journal.before_annotation, journal.after_annotation), ("rendered.png", journal.before_rendered, journal.after_rendered)];
            // Inspect both first so a conflicting external edit is never overwritten.
            for (name, before, after) in &entries {
                let target = self.check_existing(&folder.join(name))?;
                let current = fs::read(target).map_err(io_error)?;
                if current != bytes(before)? && current != bytes(after)? { return Err("画像の回復対象が外部で変更されています。上書きを止め、回復記録を保持しています。".into()); }
            }
            for (name, before, _) in entries { atomic_write(&folder.join(name), &bytes(&before)?)?; }
        }
        fs::remove_file(path).map_err(io_error)
    }
}
