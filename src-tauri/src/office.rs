use crate::links::web_url;

/// Only construct the three supported Office launch schemes from validated
/// SharePoint HTTPS URLs. Never accept an arbitrary scheme from Markdown.
pub fn office_uri(value: &str, hint: Option<&str>) -> Result<Option<String>, String> {
    let url = web_url(value)?;
    if url.scheme() != "https" || !url.host_str().is_some_and(|host| host.ends_with(".sharepoint.com"))
        || !url.username().is_empty() || url.password().is_some() || url.port().is_some() { return Ok(None); }
    let path = url.path().to_ascii_lowercase();
    let code = path.split('/').nth(1).unwrap_or("");
    let extension = path.rsplit('/').next().unwrap_or("").rsplit_once('.').map(|(_, ext)| ext);
    let kind = match code {
        ":x:" => Some("excel"), ":w:" => Some("word"), ":p:" => Some("powerpoint"),
        ":b:" | ":f:" | ":v:" | ":o:" => return Ok(None),
        _ => match extension {
            Some("pdf" | "aspx" | "html" | "htm") => return Ok(None),
            _ if path.starts_with("/_layouts/") => return Ok(None),
            Some("xls" | "xlsx" | "xlsm" | "xlsb" | "xlt" | "xltx" | "xltm" | "csv") => Some("excel"),
            Some("doc" | "docx" | "docm" | "dot" | "dotx" | "dotm") => Some("word"),
            Some("ppt" | "pptx" | "pptm" | "pot" | "potx" | "potm" | "pps" | "ppsx" | "ppsm") => Some("powerpoint"),
            _ => hint,
        },
    };
    let scheme = match kind { Some("excel") => "ms-excel", Some("word") => "ms-word", Some("powerpoint") => "ms-powerpoint", _ => return Ok(None) };
    // A literal | would otherwise become a second Office command argument.
    // Preserve all other URL components, including sharing tokens and fragments.
    Ok(Some(format!("{scheme}:ofe|u|{}", url.as_str().replace('|', "%7C"))))
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn sharing_urls_launch_the_matching_office_application_without_losing_tokens() {
        for (code, scheme) in [("x", "ms-excel"), ("w", "ms-word"), ("p", "ms-powerpoint")] {
            let url = format!("https://team.sharepoint.com/:{code}:/s/Dev/opaque?e=a%2Bb&d=123#view");
            assert_eq!(office_uri(&url, None).unwrap(), Some(format!("{scheme}:ofe|u|{url}")));
        }
    }
    #[test]
    fn direct_files_and_metadata_are_supported_but_non_office_pages_stay_in_browser() {
        for (file, kind) in [("測定.xlsx", "excel"), ("仕様.docm", "word"), ("報告.ppsx", "powerpoint")] {
            let url = format!("https://team.sharepoint.com/sites/Dev/{file}?web=1");
            assert!(office_uri(&url, None).unwrap().unwrap().starts_with(&format!("ms-{kind}:ofe|u|")));
        }
        assert!(office_uri("https://team.sharepoint.com/:u:/s/Dev/opaque", Some("word")).unwrap().unwrap().starts_with("ms-word:"));
        for path in ["/:b:/s/Dev/id", "/:f:/s/Dev/id", "/sites/Dev/file.pdf", "/_layouts/15/Doc.aspx?file=book.xlsx", "/sites/Dev/AllItems.aspx"] {
            assert_eq!(office_uri(&format!("https://team.sharepoint.com{path}"), Some("excel")).unwrap(), None);
        }
    }
    #[test]
    fn launch_target_is_restricted_and_office_argument_delimiters_are_escaped() {
        for url in ["https://example.com/a.xlsx", "http://team.sharepoint.com/a.xlsx", "https://evilsharepoint.com/a.xlsx", "https://team.sharepoint.com.evil.test/a.xlsx", "https://user:pass@team.sharepoint.com/a.xlsx", "https://team.sharepoint.com:8443/a.xlsx"] {
            assert_eq!(office_uri(url, Some("excel")).unwrap(), None);
        }
        for invalid in ["ms-excel:ofe|u|https://example.com/a", "javascript:alert(1)", "https://team.sharepoint.com/a.xlsx\n"] { assert!(office_uri(invalid, None).is_err()); }
        assert_eq!(office_uri("https://team.sharepoint.com/a.xlsx?e=a|b", None).unwrap().unwrap(), "ms-excel:ofe|u|https://team.sharepoint.com/a.xlsx?e=a%7Cb");
        assert_eq!(office_uri("https://team.sharepoint.com/opaque", Some("shell")).unwrap(), None);
    }
}
