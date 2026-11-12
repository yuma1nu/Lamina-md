use serde::Serialize;
use std::{fs, path::PathBuf};

pub fn resource_path(value: &str) -> Result<PathBuf, String> {
    if value.chars().any(char::is_control) { return Err("資料のパスを確認してください。".into()); }
    let value = value.trim().trim_matches('"');
    let path = if value.to_ascii_lowercase().starts_with("file:") {
        let url = tauri::Url::parse(value).map_err(|_| "ファイルURLの形式を確認してください。")?;
        if url.query().is_some() || url.fragment().is_some() { return Err("ファイルURLの記号はパーセントエンコードしてください。".into()); }
        url.to_file_path().map_err(|_| "ファイルURLをパスへ変換できません。")?
    } else { PathBuf::from(value) };
    if !path.is_absolute() || value.contains(['\0', '"', '|', '*', '?']) { return Err("絶対パスまたは共有パスを指定してください。".into()); }
    Ok(path)
}
pub fn check_document(path: &std::path::Path) -> Result<(), String> {
    let extension = path.extension().unwrap_or_default().to_string_lossy().to_ascii_lowercase();
    if matches!(extension.as_str(), "exe"|"com"|"bat"|"cmd"|"ps1"|"psm1"|"vbs"|"vbe"|"js"|"jse"|"wsf"|"wsh"|"scr"|"msi"|"msp"|"hta"|"lnk"|"url"|"reg") { return Err("この形式は資料として開けません。".into()); }
    Ok(())
}
#[derive(Serialize)]
pub struct ResourceInfo { pub title: String, pub folder: bool, pub exists: bool }
pub fn inspect(value: &str) -> Result<ResourceInfo, String> {
    let path = resource_path(value)?;
    Ok(ResourceInfo { title: path.file_name().unwrap_or(path.as_os_str()).to_string_lossy().into(), folder: path.is_dir(), exists: path.exists() })
}
#[derive(Default, Serialize)]
pub struct ClipboardResources { pub paths: Vec<String>, pub title: Option<String>, pub text: Option<String> }
#[cfg(windows)]
pub fn clipboard() -> Result<ClipboardResources, String> {
    use windows_sys::Win32::{System::{DataExchange::{OpenClipboard, CloseClipboard, GetClipboardData, RegisterClipboardFormatW}, Memory::{GlobalLock, GlobalUnlock, GlobalSize}}, UI::Shell::DragQueryFileW};
    unsafe fn text(format: u32) -> Option<String> {
        let handle = GetClipboardData(format);
        if handle.is_null() { return None; }
        let data = GlobalLock(handle) as *const u16;
        if data.is_null() { return None; }
        let limit = (GlobalSize(handle) / 2).min(32768);
        let mut length = 0; while length < limit && *data.add(length) != 0 { length += 1; }
        let value = String::from_utf16(std::slice::from_raw_parts(data, length)).ok();
        GlobalUnlock(handle); value
    }
    unsafe {
        if OpenClipboard(std::ptr::null_mut()) == 0 { return Err("クリップボードを読み込めませんでした。もう一度貼り付けてください。".into()); }
        struct Close; impl Drop for Close { fn drop(&mut self) { unsafe { CloseClipboard(); } } }
        let _close = Close;
        let mut result = ClipboardResources { text: text(13), ..Default::default() };
        let hdrop = GetClipboardData(15);
        if !hdrop.is_null() {
            let count = DragQueryFileW(hdrop as _, u32::MAX, std::ptr::null_mut(), 0).min(32);
            for n in 0..count {
                let length = DragQueryFileW(hdrop as _, n, std::ptr::null_mut(), 0);
                let mut buffer = vec![0u16; length as usize + 1];
                DragQueryFileW(hdrop as _, n, buffer.as_mut_ptr(), buffer.len() as u32);
                result.paths.push(String::from_utf16_lossy(&buffer[..length as usize]));
            }
        }
        let format = RegisterClipboardFormatW("FileNameW\0".encode_utf16().collect::<Vec<_>>().as_ptr());
        if let Some(filename) = text(format) {
            result.title = std::path::Path::new(&filename).file_name().map(|name| name.to_string_lossy().into());
            if result.paths.is_empty() { result.paths.push(filename); }
        }
        Ok(result)
    }
}
#[cfg(not(windows))]
pub fn clipboard() -> Result<ClipboardResources, String> { Ok(ClipboardResources::default()) }

#[derive(Serialize)]
pub struct DroppedImage { pub name: String, pub mime: String, pub data: String }
pub fn dropped_image(value: &str) -> Result<DroppedImage, String> {
    use base64::Engine;
    let path = resource_path(value)?;
    let mime = match path.extension().unwrap_or_default().to_string_lossy().to_ascii_lowercase().as_str() { "png" => "image/png", "jpg"|"jpeg" => "image/jpeg", "gif" => "image/gif", "webp" => "image/webp", "bmp" => "image/bmp", _ => return Err("対応する画像ファイルを指定してください。".into()) };
    let metadata = fs::metadata(&path).map_err(crate::vault::io_error)?;
    if !metadata.is_file() || metadata.len() > 32 * 1024 * 1024 { return Err("画像は32MB以内のファイルを指定してください。".into()); }
    let bytes = fs::read(&path).map_err(crate::vault::io_error)?;
    if bytes.len() > 32 * 1024 * 1024 { return Err("画像が大きすぎます。".into()); }
    Ok(DroppedImage { name: path.file_name().unwrap_or_default().to_string_lossy().into(), mime: mime.into(), data: base64::engine::general_purpose::STANDARD.encode(bytes) })
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn document_paths_and_image_reads_do_not_accept_schemes_or_execute_files() {
        assert!(resource_path("javascript:alert(1)").is_err()); assert!(resource_path("relative/report.pdf").is_err());
        assert!(check_document(std::path::Path::new("run.cmd")).is_err()); assert!(check_document(std::path::Path::new("report.xlsx")).is_ok());
        let dir = tempfile::tempdir().unwrap(); let path = dir.path().join("file.pdf"); fs::write(&path, "not an image").unwrap();
        assert!(dropped_image(path.to_str().unwrap()).is_err());
        let info = inspect(dir.path().to_str().unwrap()).unwrap(); assert!(info.folder); assert!(info.exists);
    }
    #[cfg(windows)]
    #[test]
    fn windows_file_urls_preserve_spaces_and_hashes() {
        assert_eq!(resource_path("file:///C:/reports/a%20%231.xlsx").unwrap(), PathBuf::from("C:\\reports\\a #1.xlsx"));
        assert_eq!(resource_path("file://server/share/report.pdf").unwrap(), PathBuf::from("\\\\server\\share\\report.pdf"));
        assert!(resource_path("file:///C:/reports/a.pdf#not-a-filename").is_err());
    }
}
