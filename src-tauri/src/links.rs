pub fn web_url(value: &str) -> Result<tauri::Url, String> {
    if value.chars().any(char::is_control) { return Err("Webリンクの形式を確認してください。".into()); }
    let url = tauri::Url::parse(value).map_err(|_| "Webリンクの形式を確認してください。")?;
    if !matches!(url.scheme(), "http" | "https") || url.host_str().is_none() {
        return Err("HTTPまたはHTTPSのWebリンクを指定してください。".into());
    }
    Ok(url)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn opens_only_valid_web_links() {
        assert_eq!(web_url("https://example.com/a?x=1&y=2#section").unwrap().as_str(), "https://example.com/a?x=1&y=2#section");
        assert!(web_url("http://intranet/report").is_ok());
        for invalid in ["javascript:alert(1)", "data:text/html,test", "file:///C:/test.exe", "shell:AppsFolder", "not a url", "https://", "https://example.com/\nnext"] { assert!(web_url(invalid).is_err(), "{invalid}"); }
    }
}
