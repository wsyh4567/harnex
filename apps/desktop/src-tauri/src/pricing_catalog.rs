use crate::{
    persist_json,
    protocol::{ModelPricing, PricingSyncParams, PricingSyncResult, PricingSyncSource},
};
use chrono::{DateTime, Utc};
use regex::Regex;
use reqwest::{Client, Url};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use sha2::{Digest, Sha256};
use std::{
    collections::BTreeMap,
    fs,
    io::{self, Read},
    path::{Path, PathBuf},
    sync::{LazyLock, Mutex},
    time::Duration,
};

const EMBEDDED: &str = include_str!("../resources/model_prices_and_context_window.json");
const DEFAULT_REMOTE_URL: &str =
    "https://raw.githubusercontent.com/BerriAI/litellm/main/model_prices_and_context_window.json";
pub(crate) const REFRESH_INTERVAL: Duration = Duration::from_secs(24 * 60 * 60);
const MAX_CATALOG_BYTES: usize = 8 * 1024 * 1024;
const MAX_HASH_BYTES: usize = 4096;

pub(crate) type PricingTable = BTreeMap<String, ModelPricing>;

#[derive(Deserialize)]
struct LiteLlmPrice {
    input_cost_per_token: f64,
    output_cost_per_token: f64,
    cache_read_input_token_cost: Option<Value>,
}

fn per_million(value: f64) -> Option<f64> {
    let amount = value * 1_000_000.0;
    (amount.is_finite() && amount >= 0.0).then_some(amount)
}

fn parse_prices(catalog: &Value) -> PricingTable {
    catalog
        .as_object()
        .into_iter()
        .flatten()
        .filter_map(|(model_id, value)| {
            if model_id.trim().is_empty() || model_id == "sample_spec" {
                return None;
            }
            let price = LiteLlmPrice::deserialize(value).ok()?;
            Some((
                model_id.clone(),
                ModelPricing {
                    model_id: model_id.clone(),
                    input_per_1m_usd: per_million(price.input_cost_per_token)?,
                    output_per_1m_usd: per_million(price.output_cost_per_token)?,
                    cached_input_per_1m_usd: price
                        .cache_read_input_token_cost
                        .and_then(|value| per_million(value.as_f64()?)),
                },
            ))
        })
        .collect()
}

static EMBEDDED_PRICES: LazyLock<PricingTable> = LazyLock::new(|| {
    let mut pricing =
        parse_prices(&serde_json::from_str(EMBEDDED).expect("invalid bundled pricing catalog"));
    for (id, input, output, cached) in [
        ("gpt-6-astra", 10.0, 50.0, 1.0),
        ("gpt-6.1-sol", 2.0, 10.0, 0.1),
        ("gpt-6.1-terra", 1.0, 5.0, 0.05),
        ("gpt-6-sol", 2.0, 10.0, 0.2),
        ("gpt-6-luna", 0.1, 0.5, 0.01),
        ("gpt-5.6-sol", 5.0, 30.0, 0.5),
        ("gpt-5.6-terra", 2.0, 12.0, 0.2),
        ("gpt-5.6-luna", 0.2, 1.2, 0.02),
        ("gpt-5.4", 2.5, 15.0, 0.25),
        ("gpt-5.4-mini", 0.75, 4.5, 0.075),
        ("gpt-5.4-nano", 0.2, 1.25, 0.02),
        ("claude-fable-5-2", 8.0, 40.0, 0.2),
        ("claude-mythos-5-2", 8.0, 40.0, 0.2),
        ("claude-opus-5-5", 4.0, 20.0, 0.2),
        ("claude-sonnet-5-5", 2.0, 10.0, 0.1),
        ("claude-haiku-5-5", 0.1, 0.5, 0.01),
        ("gemini-4-argon", 2.0, 10.0, 0.1),
        ("gemini-4-argon-cyber-permissive", 4.0, 20.0, 0.2),
        ("deepseek-v4-flash", 0.15, 0.6, 0.003),
        ("deepseek-v4-flash-vision-exp", 0.15, 0.6, 0.003),
        ("deepseek-v4-pro", 0.66, 1.98, 0.022),
        ("deepseek-v4.1-flash", 0.15, 0.6, 0.003),
        ("deepseek-v4.1-pro", 0.66, 1.98, 0.022),
        ("claude-3-5-haiku", 0.8, 4.0, 0.08),
        ("deepseek-chat", 0.27, 1.1, 0.07),
        ("deepseek-reasoner", 0.55, 2.19, 0.14),
    ] {
        pricing.entry(id.into()).or_insert_with(|| ModelPricing {
            model_id: id.into(),
            input_per_1m_usd: input,
            output_per_1m_usd: output,
            cached_input_per_1m_usd: Some(cached),
        });
    }
    pricing
});

static DATE_SUFFIX: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"-(?:20[0-9]{6}|20[0-9]{2}-[0-9]{2}-[0-9]{2}|(?:0[1-9]|1[0-2])(?:0[1-9]|[12][0-9]|3[01]))$").unwrap()
});

pub(crate) fn lookup_candidates(model_id: &str) -> Vec<String> {
    let lowercase = model_id.trim().to_lowercase();
    let suffix = lowercase.rsplit('/').next().unwrap_or(&lowercase);
    let effortless = match suffix.rsplit_once(':') {
        Some((base, "xhigh" | "high" | "medium" | "low")) => base,
        _ => suffix,
    };
    let undated = DATE_SUFFIX
        .find(effortless)
        .map_or(effortless, |date| &effortless[..date.start()]);
    let prefix_length = lowercase.len() - suffix.len();
    let qualified_effortless = &lowercase[..prefix_length + effortless.len()];
    let qualified_undated = &lowercase[..prefix_length + undated.len()];
    let alias = match undated {
        "gpt-6" | "gpt-6.2-astra" => "gpt-6-astra",
        "gpt-6.2-sol" => "gpt-6.1-sol",
        "gpt-6-terra" => "gpt-6.1-terra",
        "gpt-5.6" | "gpt-5.6-max" | "gpt-5.6-codex" => "gpt-5.6-sol",
        _ => undated
            .rsplit_once('-')
            .filter(|(base, tier)| {
                matches!(
                    *base,
                    "claude-opus-5-5"
                        | "claude-sonnet-5-5"
                        | "gemini-4-argon"
                        | "gemini-3.6-flash"
                        | "gemini-3.7-flash"
                        | "gemini-3.8-flash"
                ) && matches!(*tier, "high" | "medium" | "low" | "tiered")
            })
            .map_or(undated, |(base, _)| base),
    };
    let mut candidates = Vec::with_capacity(8);
    for candidate in [
        model_id,
        &lowercase,
        suffix,
        qualified_effortless,
        effortless,
        qualified_undated,
        undated,
        alias,
    ] {
        if !candidate.is_empty() && !candidates.iter().any(|item| item == candidate) {
            candidates.push(candidate.to_owned());
        }
    }
    candidates
}

pub(crate) fn find_price<'a>(
    prices: &'a PricingTable,
    keys: &[String],
) -> Option<&'a ModelPricing> {
    keys.iter().find_map(|key| prices.get(key))
}

#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct CacheFile {
    remote_url: String,
    hash_url: Option<String>,
    sha256: String,
    updated_at: DateTime<Utc>,
    checked_at: DateTime<Utc>,
    catalog: Value,
}

struct CachedCatalog {
    file: CacheFile,
    prices: PricingTable,
}

impl CachedCatalog {
    fn load(path: &Path) -> Option<Self> {
        let file = fs::File::open(path).ok()?;
        let modified = DateTime::from(file.metadata().ok()?.modified().ok()?);
        let mut body = Vec::new();
        file.take(MAX_CATALOG_BYTES as u64 + 1)
            .read_to_end(&mut body)
            .ok()?;
        if body.len() > MAX_CATALOG_BYTES {
            return None;
        }
        let file = serde_json::from_slice::<CacheFile>(&body)
            .ok()
            .or_else(|| {
                Some(CacheFile {
                    remote_url: DEFAULT_REMOTE_URL.into(),
                    hash_url: None,
                    sha256: sha256(&body),
                    updated_at: modified,
                    checked_at: modified,
                    catalog: serde_json::from_slice(&body).ok()?,
                })
            })?;
        let prices = parse_prices(&file.catalog);
        (!prices.is_empty()).then_some(Self { file, prices })
    }
}

pub(crate) struct PricingCatalog {
    path: PathBuf,
    cached: Mutex<Option<CachedCatalog>>,
    sync_lock: tokio::sync::Mutex<()>,
}

impl PricingCatalog {
    pub(crate) fn open(path: PathBuf) -> Self {
        Self {
            cached: Mutex::new(CachedCatalog::load(&path)),
            path,
            sync_lock: tokio::sync::Mutex::new(()),
        }
    }

    pub(crate) fn price(&self, keys: &[String], discovered: &PricingTable) -> Option<ModelPricing> {
        self.cached
            .lock()
            .unwrap()
            .as_ref()
            .and_then(|cache| find_price(&cache.prices, keys).cloned())
            .or_else(|| find_price(discovered, keys).cloned())
            .or_else(|| find_price(&EMBEDDED_PRICES, keys).cloned())
    }

    pub(crate) async fn sync(&self, params: PricingSyncParams) -> PricingSyncResult {
        let _sync_guard = self.sync_lock.lock().await;
        match self.refresh(params).await {
            Ok(true) => self.result(true, None),
            Ok(false) => self.result(false, None),
            Err(error) => self.result(false, Some(error.to_string())),
        }
    }

    fn result(&self, synced: bool, error: Option<String>) -> PricingSyncResult {
        let cached = self.cached.lock().unwrap();
        match cached.as_ref() {
            Some(cache) => PricingSyncResult {
                synced,
                source: if synced {
                    PricingSyncSource::Remote
                } else {
                    PricingSyncSource::Cache
                },
                model_count: cache.prices.len(),
                updated_at: Some(cache.file.updated_at),
                error,
            },
            None => PricingSyncResult {
                synced: false,
                source: PricingSyncSource::Embedded,
                model_count: EMBEDDED_PRICES.len(),
                updated_at: None,
                error,
            },
        }
    }

    async fn refresh(&self, params: PricingSyncParams) -> io::Result<bool> {
        let remote = pricing_url(
            &params
                .remote_url
                .or_else(|| std::env::var("HARNEX_PRICING_REMOTE_URL").ok())
                .unwrap_or_else(|| DEFAULT_REMOTE_URL.into()),
        )?;
        let hash = params
            .hash_url
            .or_else(|| std::env::var("HARNEX_PRICING_HASH_URL").ok())
            .filter(|value| !value.trim().is_empty())
            .map(|value| pricing_url(&value))
            .transpose()?;
        let hash_url = hash.as_ref().map(|url| url.as_str().to_owned());
        if !params.force
            && self.cached.lock().unwrap().as_ref().is_some_and(|cache| {
                cache.file.remote_url == remote.as_str()
                    && cache.file.hash_url == hash_url
                    && (Utc::now() - cache.file.checked_at)
                        .to_std()
                        .is_ok_and(|age| age < REFRESH_INTERVAL)
            })
        {
            return Ok(false);
        }
        let client = Client::builder()
            .timeout(Duration::from_secs(8))
            .redirect(reqwest::redirect::Policy::none())
            .build()
            .map_err(request_error)?;
        let expected = if let Some(url) = hash {
            let body = fetch(&client, url, MAX_HASH_BYTES).await?;
            let text = std::str::from_utf8(&body).map_err(invalid_data)?;
            let digest = text
                .split_whitespace()
                .next()
                .filter(|text| {
                    text.len() == 64 && text.bytes().all(|byte| byte.is_ascii_hexdigit())
                })
                .ok_or_else(|| invalid_data("invalid pricing SHA-256 response"))?;
            if !params.force {
                let mut cached = self.cached.lock().unwrap();
                if let Some(cache) = cached.as_mut().filter(|cache| {
                    cache.file.remote_url == remote.as_str()
                        && cache.file.sha256.eq_ignore_ascii_case(digest)
                }) {
                    let mut refreshed = cache.file.clone();
                    refreshed.checked_at = Utc::now();
                    refreshed.hash_url = hash_url;
                    persist_json(&self.path, &refreshed)?;
                    cache.file = refreshed;
                    return Ok(false);
                }
            }
            Some(digest.to_ascii_lowercase())
        } else {
            None
        };

        let body = fetch(&client, remote.clone(), MAX_CATALOG_BYTES - 4096).await?;
        let digest = sha256(&body);
        if expected.is_some_and(|expected| expected != digest) {
            return Err(invalid_data("pricing catalog SHA-256 mismatch"));
        }
        let catalog = serde_json::from_slice(&body).map_err(invalid_data)?;
        let prices = parse_prices(&catalog);
        if prices.is_empty() {
            return Err(invalid_data(
                "pricing catalog contains no valid token rates",
            ));
        }
        let timestamp = Utc::now();
        let file = CacheFile {
            remote_url: remote.into(),
            hash_url,
            sha256: digest,
            updated_at: timestamp,
            checked_at: timestamp,
            catalog,
        };
        persist_json(&self.path, &file)?;
        *self.cached.lock().unwrap() = Some(CachedCatalog { file, prices });
        Ok(true)
    }
}

fn invalid_data(error: impl std::fmt::Display) -> io::Error {
    io::Error::new(io::ErrorKind::InvalidData, error.to_string())
}

fn request_error(error: reqwest::Error) -> io::Error {
    io::Error::other(error.without_url())
}

fn pricing_url(value: &str) -> io::Result<Url> {
    let url = Url::parse(value.trim()).map_err(invalid_data)?;
    let loopback = matches!(url.host_str(), Some("127.0.0.1" | "localhost" | "[::1]"));
    if (url.scheme() != "https" && !(url.scheme() == "http" && loopback))
        || url.host().is_none()
        || !url.username().is_empty()
        || url.password().is_some()
        || url.query().is_some()
        || url.fragment().is_some()
    {
        return Err(invalid_data(
            "pricing URL must use HTTPS or loopback HTTP without credentials, query, or fragment",
        ));
    }
    Ok(url)
}

fn sha256(body: &[u8]) -> String {
    hex::encode(Sha256::digest(body))
}

async fn fetch(client: &Client, url: Url, limit: usize) -> io::Result<Vec<u8>> {
    let mut response = client.get(url).send().await.map_err(request_error)?;
    if !response.status().is_success() {
        return Err(io::Error::other(format!(
            "pricing server returned HTTP {}",
            response.status().as_u16()
        )));
    }
    let mut body = Vec::new();
    while let Some(chunk) = response.chunk().await.map_err(request_error)? {
        if chunk.len() > limit - body.len() {
            return Err(invalid_data("pricing response exceeds size limit"));
        }
        body.extend_from_slice(&chunk);
    }
    Ok(body)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::{
        atomic::{AtomicBool, Ordering},
        Arc,
    };
    use tokio::{
        io::{AsyncReadExt, AsyncWriteExt},
        net::TcpListener,
    };

    #[test]
    fn parses_bundled_litellm_prices_as_per_million_token_rates() {
        let snapshot = parse_prices(&serde_json::from_str(EMBEDDED).unwrap());
        assert!(snapshot.len() > 200);
        let price = &snapshot["gemini-2.5-pro"];
        assert_eq!(
            (
                price.input_per_1m_usd,
                price.output_per_1m_usd,
                price.cached_input_per_1m_usd
            ),
            (1.25, 10.0, Some(0.125))
        );
        assert!(!snapshot.contains_key("sample_spec"));
    }

    #[test]
    fn resolves_frontier_aliases_and_preserves_exact_normalized_candidates() {
        for (id, base, input) in [
            ("demo-gateway/GPT-6.2-SOL:xhigh", "gpt-6.1-sol", 2.0),
            ("gpt-6.2-astra-2026-08-01:high", "gpt-6-astra", 10.0),
            ("vendor/gpt-6-terra", "gpt-6.1-terra", 1.0),
            ("group/gpt-5.6-max", "gpt-5.6-sol", 5.0),
            (
                "vendor/claude-opus-5-5-20250514:low",
                "claude-opus-5-5",
                4.0,
            ),
            (
                "projects/google/models/gemini-4-argon-medium",
                "gemini-4-argon",
                2.0,
            ),
            ("deepseek-v4-pro", "deepseek-v4-pro", 0.66),
        ] {
            let price = find_price(&EMBEDDED_PRICES, &lookup_candidates(id)).unwrap();
            assert_eq!(price.model_id, base);
            assert!((price.input_per_1m_usd - input).abs() < 1e-10);
        }
        assert!(find_price(
            &EMBEDDED_PRICES,
            &lookup_candidates("group/my-unknown-model:xhigh")
        )
        .is_none());
    }

    #[tokio::test]
    async fn sync_checks_freshness_and_hash_persists_verified_data_and_falls_back_offline() {
        const CATALOG: &str =
            r#"{"new/test":{"input_cost_per_token":0.000003,"output_cost_per_token":0.000009}}"#;
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let endpoint = format!("http://{}", listener.local_addr().unwrap());
        let paths = Arc::new(Mutex::new(Vec::new()));
        let reject = Arc::new(AtomicBool::new(false));
        let server = tokio::spawn({
            let paths = paths.clone();
            let reject = reject.clone();
            async move {
                while let Ok((mut socket, _)) = listener.accept().await {
                    let mut request = Vec::new();
                    while !request.ends_with(b"\r\n\r\n") {
                        let Ok(byte) = socket.read_u8().await else {
                            break;
                        };
                        request.push(byte);
                    }
                    let request = std::str::from_utf8(&request).unwrap();
                    let path = request.split_whitespace().nth(1).unwrap_or_default();
                    paths.lock().unwrap().push(path.to_owned());
                    let body = match path {
                        "/sha256" if reject.load(Ordering::Relaxed) => "0".repeat(64),
                        "/sha256" => format!(
                            "{}  catalog.json\n",
                            sha256(CATALOG.as_bytes()).to_uppercase()
                        ),
                        "/catalog" => CATALOG.to_owned(),
                        _ => String::new(),
                    };
                    let response = format!(
                        "HTTP/1.1 200 OK\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
                        body.len()
                    );
                    socket.write_all(response.as_bytes()).await.unwrap();
                }
            }
        });
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("pricing_cache.json");
        let options = |force| PricingSyncParams {
            remote_url: Some(format!("{endpoint}/catalog")),
            hash_url: Some(format!("{endpoint}/sha256")),
            force,
        };
        let catalog = PricingCatalog::open(path.clone());
        let remote = catalog.sync(options(false)).await;
        assert!(remote.synced);
        assert_eq!(remote.source, PricingSyncSource::Remote);
        assert_eq!(remote.model_count, 1);
        let reopened = PricingCatalog::open(path.clone());
        let cache = reopened.sync(options(false)).await;
        assert_eq!(cache.source, PricingSyncSource::Cache);
        assert_eq!(cache.updated_at, remote.updated_at);
        assert_eq!(*paths.lock().unwrap(), ["/sha256", "/catalog"]);
        assert_eq!(
            reopened
                .price(&lookup_candidates("new/test"), &PricingTable::new())
                .unwrap()
                .input_per_1m_usd,
            3.0
        );
        reopened
            .cached
            .lock()
            .unwrap()
            .as_mut()
            .unwrap()
            .file
            .checked_at -= chrono::Duration::hours(25);
        assert_eq!(
            reopened.sync(options(false)).await.source,
            PricingSyncSource::Cache
        );
        assert_eq!(*paths.lock().unwrap(), ["/sha256", "/catalog", "/sha256"]);

        let last_good = fs::read(&path).unwrap();
        reject.store(true, Ordering::Relaxed);
        let mismatch = reopened.sync(options(true)).await;
        assert_eq!(mismatch.source, PricingSyncSource::Cache);
        assert_eq!(
            mismatch.error.as_deref(),
            Some("pricing catalog SHA-256 mismatch")
        );
        assert_eq!(fs::read(&path).unwrap(), last_good);
        server.abort();
        let _ = server.await;
        let offline = reopened.sync(options(true)).await;
        assert!(!offline.synced);
        assert_eq!(offline.source, PricingSyncSource::Cache);
        assert!(offline.error.is_some());
        let missing = PricingCatalog::open(dir.path().join("missing.json"))
            .sync(options(true))
            .await;
        assert_eq!(missing.source, PricingSyncSource::Embedded);
        assert!(missing.model_count > 200);
        assert!(missing.error.is_some());
    }
}
