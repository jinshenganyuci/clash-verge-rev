use crate::cmd::{CmdResult, CommandFailure, coded_error};
use reqwest::{Client, StatusCode, header};
use semver::Version;
use serde::{Deserialize, Serialize};
use std::{collections::HashSet, time::Duration};

const API: &str = "https://api.github.com/repos/jinshenganyuci/clash-verge-rev/releases";
const RELEASES: &str = "https://github.com/jinshenganyuci/clash-verge-rev/releases";
const PAGE_SIZE: usize = 30;
const MAX_PAGES: usize = 3;
const MAX_RESPONSE: usize = 2 * 1024 * 1024;

#[derive(Debug, Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct IkunUpdateInfo {
    pub version: String,
    pub tag: String,
    pub release_url: String,
    pub download_url: String,
    pub body: String,
    pub published_at: Option<String>,
    pub size: u64,
}

#[derive(Deserialize)]
struct GithubRelease {
    draft: bool,
    tag_name: String,
    html_url: String,
    body: Option<String>,
    published_at: Option<String>,
    assets: Vec<GithubAsset>,
}

#[derive(Deserialize)]
struct GithubAsset {
    name: String,
    browser_download_url: String,
    state: String,
    size: u64,
}

struct Candidate {
    version: Version,
    info: IkunUpdateInfo,
}

impl Candidate {
    fn is_newer_than(&self, other: &Self) -> bool {
        let ordering = self.version.cmp_precedence(&other.version);
        ordering.is_gt() || (ordering.is_eq() && self.info.published_at > other.info.published_at)
    }
}

fn invalid_response() -> CommandFailure {
    coded_error(
        "IKUN_UPDATE_INVALID_RESPONSE",
        "GitHub returned invalid IKUN release information.",
    )
}

fn network_error(error: &reqwest::Error) -> CommandFailure {
    if error.is_timeout() {
        timeout_error()
    } else {
        coded_error(
            "IKUN_UPDATE_NETWORK",
            "Could not reach GitHub. Check your network and try again.",
        )
    }
}

fn timeout_error() -> CommandFailure {
    coded_error(
        "IKUN_UPDATE_TIMEOUT",
        "The GitHub update check timed out. Please try again.",
    )
}

fn check_status(status: StatusCode, rate_limited: bool) -> CmdResult<()> {
    if status == StatusCode::TOO_MANY_REQUESTS || (status == StatusCode::FORBIDDEN && rate_limited) {
        return Err(coded_error(
            "IKUN_UPDATE_RATE_LIMITED",
            "GitHub's request limit has been reached. Please try again later.",
        ));
    }
    if status != StatusCode::OK {
        return Err(coded_error(
            "IKUN_UPDATE_REQUEST_FAILED",
            format!("GitHub returned HTTP {} while checking IKUN updates.", status.as_u16()),
        ));
    }
    Ok(())
}

fn is_ikun_tag(tag: &str) -> bool {
    tag.starts_with("ikun-")
        && tag.len() > "ikun-".len()
        && tag
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || b"-._+".contains(&byte))
}

fn asset_version(name: &str) -> Option<Version> {
    let version = name.strip_prefix("IKUN_")?.strip_suffix("_x64-setup.exe")?;
    Version::parse(version).ok()
}

fn candidate(release: GithubRelease, current: &Version) -> CmdResult<Option<Candidate>> {
    if release.draft || !is_ikun_tag(&release.tag_name) {
        return Ok(None);
    }
    let mut selected: Option<(Version, GithubAsset)> = None;
    let mut names = HashSet::new();
    for asset in release.assets {
        let Some(version) = asset_version(&asset.name) else {
            continue;
        };
        if asset.state != "uploaded" || asset.size == 0 || !version.cmp_precedence(current).is_gt() {
            continue;
        }
        if release.html_url != format!("{RELEASES}/tag/{}", release.tag_name)
            || asset.browser_download_url != format!("{RELEASES}/download/{}/{}", release.tag_name, asset.name)
            || !names.insert(asset.name.clone())
        {
            return Err(invalid_response());
        }
        if selected
            .as_ref()
            .is_none_or(|(previous, _)| version.cmp_precedence(previous).is_gt())
        {
            selected = Some((version, asset));
        }
    }
    Ok(selected.map(|(version, asset)| Candidate {
        info: IkunUpdateInfo {
            version: version.to_string(),
            tag: release.tag_name,
            release_url: release.html_url,
            download_url: asset.browser_download_url,
            body: release.body.unwrap_or_default(),
            published_at: release.published_at,
            size: asset.size,
        },
        version,
    }))
}

fn select_page(releases: Vec<GithubRelease>, current: &Version, latest: &mut Option<Candidate>) -> CmdResult<()> {
    for release in releases {
        if let Some(candidate) = candidate(release, current)?
            && latest.as_ref().is_none_or(|previous| candidate.is_newer_than(previous))
        {
            *latest = Some(candidate);
        }
    }
    Ok(())
}

fn decode_page(bytes: &[u8]) -> CmdResult<Vec<GithubRelease>> {
    let releases: Vec<GithubRelease> = serde_json::from_slice(bytes).map_err(|_| invalid_response())?;
    if releases.len() > PAGE_SIZE {
        return Err(invalid_response());
    }
    Ok(releases)
}

async fn read_page(mut response: reqwest::Response) -> CmdResult<Vec<GithubRelease>> {
    if response
        .content_length()
        .is_some_and(|length| length > MAX_RESPONSE as u64)
    {
        return Err(invalid_response());
    }
    let mut body = Vec::new();
    while let Some(chunk) = response.chunk().await.map_err(|error| network_error(&error))? {
        if body.len().saturating_add(chunk.len()) > MAX_RESPONSE {
            return Err(invalid_response());
        }
        body.extend_from_slice(&chunk);
    }
    decode_page(&body)
}

fn client() -> CmdResult<Client> {
    let mut builder = Client::builder()
        .no_proxy()
        .redirect(reqwest::redirect::Policy::none())
        .connect_timeout(Duration::from_secs(8))
        .timeout(Duration::from_secs(15))
        .user_agent(concat!("IKUN-Windows/", env!("CARGO_PKG_VERSION")));
    if let Ok(proxy) = sysproxy::Sysproxy::get_system_proxy()
        && proxy.enable
    {
        let proxy = reqwest::Proxy::all(format!("http://{}:{}", proxy.host, proxy.port))
            .map_err(|error| network_error(&error))?;
        builder = builder.proxy(proxy);
    }
    builder.build().map_err(|error| network_error(&error))
}

async fn check_releases() -> CmdResult<Option<IkunUpdateInfo>> {
    let current = Version::parse(env!("CARGO_PKG_VERSION")).map_err(|_| invalid_response())?;
    let client = client()?;
    let mut latest = None;
    for page in 1..=MAX_PAGES {
        let response = client
            .get(API)
            .query(&[("per_page", PAGE_SIZE), ("page", page)])
            .header(header::ACCEPT, "application/vnd.github+json")
            .header("X-GitHub-Api-Version", "2022-11-28")
            .send()
            .await
            .map_err(|error| network_error(&error))?;
        let rate_limited = response
            .headers()
            .get("x-ratelimit-remaining")
            .is_some_and(|value| value == "0");
        check_status(response.status(), rate_limited)?;
        let has_next = response
            .headers()
            .get(header::LINK)
            .and_then(|value| value.to_str().ok())
            .is_some_and(|value| value.split(',').any(|link| link.contains("rel=\"next\"")));
        select_page(read_page(response).await?, &current, &mut latest)?;
        if !has_next {
            return Ok(latest.map(|candidate| candidate.info));
        }
    }
    match latest {
        Some(candidate) => Ok(Some(candidate.info)),
        None => Err(coded_error(
            "IKUN_UPDATE_LIMIT_REACHED",
            "There are too many release pages to finish the update check. Please check the project releases page.",
        )),
    }
}

pub async fn check() -> CmdResult<Option<IkunUpdateInfo>> {
    tokio::time::timeout(Duration::from_secs(30), check_releases())
        .await
        .map_err(|_| timeout_error())?
}

#[cfg(test)]
mod tests {
    use super::{Candidate, RELEASES, candidate, check_status, decode_page, select_page};
    use reqwest::StatusCode;
    use semver::Version;
    use serde_json::{Value, json};

    fn release(version: &str) -> Value {
        let tag = format!("ikun-preview-{version}.1");
        let name = format!("IKUN_{version}_x64-setup.exe");
        json!({
            "draft": false,
            "prerelease": true,
            "tag_name": tag,
            "html_url": format!("{RELEASES}/tag/{tag}"),
            "body": "New IKUN preview",
            "published_at": "2026-11-25T00:00:00Z",
            "assets": [{
                "name": name,
                "browser_download_url": format!("{RELEASES}/download/{tag}/{name}"),
                "state": "uploaded",
                "size": 60_000_000,
            }],
        })
    }

    fn select(values: Vec<Value>, current: &str) -> anyhow::Result<Option<Candidate>> {
        let mut latest = None;
        select_page(
            serde_json::from_value(json!(values))?,
            &Version::parse(current)?,
            &mut latest,
        )
        .map_err(|error| anyhow::anyhow!(error.detail))?;
        Ok(latest)
    }

    #[test]
    fn previews_are_included_and_versions_use_semver_precedence() -> anyhow::Result<()> {
        let preview = select(vec![release("2.5.13")], "2.5.12")?.ok_or_else(|| anyhow::anyhow!("missing preview"))?;
        assert_eq!(preview.info.version, "2.5.13");
        let latest = select(
            vec![
                release("2.5.9"),
                release("2.5.10"),
                release("2.6.0-beta.2"),
                release("2.6.0-beta.11"),
            ],
            "2.5.8",
        )?
        .ok_or_else(|| anyhow::anyhow!("missing newest preview"))?;
        assert_eq!(latest.info.version, "2.6.0-beta.11");
        let stable = select(vec![release("2.6.0-rc.1"), release("2.6.0")], "2.5.12")?
            .ok_or_else(|| anyhow::anyhow!("missing stable version"))?;
        assert_eq!(stable.info.version, "2.6.0");
        assert!(select(vec![release("2.5.12+build.2")], "2.5.12")?.is_none());
        Ok(())
    }

    #[test]
    fn old_drafts_upstream_and_incompatible_packages_are_not_updates() -> anyhow::Result<()> {
        let mut draft = release("2.5.13");
        draft["draft"] = json!(true);
        let mut upstream = release("9.0.0");
        upstream["tag_name"] = json!("v9.0.0");
        let mut arm = release("2.5.14");
        arm["assets"][0]["name"] = json!("IKUN_2.5.14_arm64-setup.exe");
        let mut msi = release("2.5.15");
        msi["assets"][0]["name"] = json!("IKUN_2.5.15_x64.msi");
        let mut empty = release("2.5.16");
        empty["assets"] = json!([]);
        assert!(
            select(
                vec![release("2.5.11"), release("2.5.12"), draft, upstream, arm, msi, empty],
                "2.5.12"
            )?
            .is_none()
        );
        assert!(select(Vec::new(), "2.5.12")?.is_none());
        Ok(())
    }

    #[test]
    fn untrusted_release_links_and_duplicate_installers_are_errors() -> anyhow::Result<()> {
        let current = Version::parse("2.5.12")?;
        for (field, replacement) in [
            (
                "html_url",
                "https://github.com/clash-verge-rev/clash-verge-rev/releases/tag/ikun-preview-2.5.13.1",
            ),
            (
                "html_url",
                "http://github.com/jinshenganyuci/clash-verge-rev/releases/tag/ikun-preview-2.5.13.1",
            ),
            ("browser_download_url", "https://example.com/IKUN_2.5.13_x64-setup.exe"),
            (
                "browser_download_url",
                "https://github.com/jinshenganyuci/clash-verge-rev/releases/download/wrong-tag/IKUN_2.5.13_x64-setup.exe",
            ),
            (
                "browser_download_url",
                "https://github.com/jinshenganyuci/clash-verge-rev/releases/download/ikun-preview-2.5.13.1/IKUN_2.5.13_x64-setup.exe?redirect=other",
            ),
        ] {
            let mut value = release("2.5.13");
            if field == "html_url" {
                value[field] = json!(replacement);
            } else {
                value["assets"][0][field] = json!(replacement);
            }
            assert!(candidate(serde_json::from_value(value)?, &current).is_err());
        }
        let mut duplicate = release("2.5.13");
        duplicate["assets"] = json!([duplicate["assets"][0], duplicate["assets"][0]]);
        assert!(candidate(serde_json::from_value(duplicate)?, &current).is_err());
        Ok(())
    }

    #[test]
    fn failed_requests_and_malformed_data_never_report_no_update() {
        assert!(check_status(StatusCode::OK, false).is_ok());
        for status in [
            StatusCode::FORBIDDEN,
            StatusCode::NOT_FOUND,
            StatusCode::BAD_GATEWAY,
            StatusCode::FOUND,
            StatusCode::PARTIAL_CONTENT,
        ] {
            assert!(check_status(status, false).is_err());
        }
        assert_eq!(
            check_status(StatusCode::TOO_MANY_REQUESTS, false)
                .err()
                .and_then(|error| error.code)
                .as_deref(),
            Some("IKUN_UPDATE_RATE_LIMITED")
        );
        assert!(decode_page(b"not json").is_err());
        assert!(decode_page(b"{\"message\":\"rate limit\"}").is_err());
    }
}
