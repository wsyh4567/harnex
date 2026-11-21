use crate::{
    persist_json,
    pricing_catalog::{find_price, lookup_candidates, PricingCatalog, PricingTable},
    protocol::{BudgetStatus, ModelPricing, PricingSyncParams, PricingSyncResult, TokenUsage},
};
use chrono::{Local, NaiveDate};
use serde::{Deserialize, Serialize};
use std::{
    fs, io,
    path::{Path, PathBuf},
    sync::Mutex,
};

#[derive(Debug, thiserror::Error)]
pub enum BudgetError {
    #[error("daily budget exhausted")]
    Exceeded,
    #[error("invalid budget amount or token counts")]
    InvalidUsage,
    #[error("model has no price: {0}")]
    UnknownModel(String),
    #[error(transparent)]
    Storage(#[from] io::Error),
}

#[derive(Clone, Serialize, Deserialize)]
struct Ledger {
    day: NaiveDate,
    usd_limit: f64,
    token_limit: u64,
    spent: f64,
    tokens: u64,
    pricing: PricingTable,
    #[serde(default, skip_serializing_if = "PricingTable::is_empty")]
    discovered_pricing: PricingTable,
    #[serde(default)]
    unpriced_tokens_today: u64,
    #[serde(default)]
    unpriced_models_today: Vec<String>,
    #[serde(default)]
    cost_source: Option<String>,
}

impl Ledger {
    fn refresh(&mut self) {
        let today = Local::now().date_naive();
        if today > self.day {
            self.day = today;
            self.spent = 0.0;
            self.tokens = 0;
            self.unpriced_tokens_today = 0;
            self.unpriced_models_today.clear();
            self.cost_source = None;
        }
    }

    fn status(&self) -> BudgetStatus {
        BudgetStatus {
            daily_limit_usd: self.usd_limit,
            spent_today_usd: self.spent,
            tokens_today: self.tokens,
            unpriced_tokens_today: self.unpriced_tokens_today,
            unpriced_models_today: self.unpriced_models_today.clone(),
            cost_source: self.cost_source.as_deref().map(|source| match source {
                "catalog" => "estimated".into(),
                _ => source.into(),
            }),
            tripped: self.spent >= self.usd_limit || self.tokens >= self.token_limit,
            pricing_table: self.pricing.values().cloned().collect(),
        }
    }
}

pub struct Budget {
    path: PathBuf,
    ledger: Mutex<Ledger>,
    catalog: PricingCatalog,
}

fn valid_amount(value: f64) -> bool {
    value.is_finite() && value >= 0.0
}

impl Budget {
    pub fn open(path: impl AsRef<Path>) -> Result<Self, BudgetError> {
        let path = path.as_ref().to_owned();
        let mut ledger = match fs::read(&path) {
            Ok(data) => serde_json::from_slice(&data).map_err(io::Error::other)?,
            Err(e) if e.kind() == io::ErrorKind::NotFound => Ledger {
                day: Local::now().date_naive(),
                usd_limit: 5.0,
                token_limit: 1_000_000,
                spent: 0.0,
                tokens: 0,
                pricing: PricingTable::new(),
                discovered_pricing: PricingTable::new(),
                unpriced_tokens_today: 0,
                unpriced_models_today: Vec::new(),
                cost_source: None,
            },
            Err(e) => return Err(e.into()),
        };
        if ledger.cost_source.is_none() && (ledger.tokens > 0 || ledger.spent > 0.0) {
            ledger.cost_source = Some("estimated".into());
        }
        Ok(Self {
            catalog: PricingCatalog::open(path.with_file_name("pricing_cache.json")),
            path,
            ledger: Mutex::new(ledger),
        })
    }

    fn price(&self, ledger: &Ledger, model_id: &str) -> Option<(ModelPricing, &'static str)> {
        let keys = lookup_candidates(model_id);
        find_price(&ledger.pricing, &keys)
            .cloned()
            .map(|price| (price, "estimated"))
            .or_else(|| {
                self.catalog
                    .price(&keys, &ledger.discovered_pricing)
                    .map(|price| (price, "catalog"))
            })
    }

    pub fn model_pricing(&self, model_id: &str) -> Option<ModelPricing> {
        self.price(&self.ledger.lock().unwrap(), model_id)
            .map(|(price, _)| price)
    }

    pub async fn pricing_sync(&self, params: PricingSyncParams) -> PricingSyncResult {
        self.catalog.sync(params).await
    }

    pub fn status(&self) -> BudgetStatus {
        let mut ledger = self.ledger.lock().unwrap();
        ledger.refresh();
        ledger.status()
    }

    pub fn check_budget(
        &self,
        estimated_usd: f64,
        estimated_tokens: u64,
    ) -> Result<BudgetStatus, BudgetError> {
        if !valid_amount(estimated_usd) {
            return Err(BudgetError::InvalidUsage);
        }
        let mut ledger = self.ledger.lock().unwrap();
        ledger.refresh();
        let status = ledger.status();
        if status.tripped
            || ledger.spent + estimated_usd > ledger.usd_limit
            || estimated_tokens > ledger.token_limit - ledger.tokens
        {
            return Err(BudgetError::Exceeded);
        }
        Ok(status)
    }

    pub fn record_usage(
        &self,
        model_id: &str,
        usage: &TokenUsage,
    ) -> Result<BudgetStatus, BudgetError> {
        self.update(|ledger| {
            // Cached and reasoning tokens are subsets of the input and output totals.
            if usage.cached_input_tokens > usage.input_tokens
                || usage.reasoning_tokens > usage.output_tokens
            {
                return Err(BudgetError::InvalidUsage);
            }
            let tokens = usage.input_tokens.saturating_add(usage.output_tokens);
            let charge =
                if let Some(cost) = usage.upstream_cost_usd.filter(|cost| valid_amount(*cost)) {
                    Some((cost, "upstream_actual"))
                } else {
                    self.price(ledger, model_id).map(|(price, source)| {
                        let cost = ((usage.input_tokens - usage.cached_input_tokens) as f64
                            * price.input_per_1m_usd
                            + usage.cached_input_tokens as f64
                                * price
                                    .cached_input_per_1m_usd
                                    .unwrap_or(price.input_per_1m_usd)
                            + usage.output_tokens as f64 * price.output_per_1m_usd)
                            / 1_000_000.0;
                        (cost, source)
                    })
                };
            if let Some((cost, source)) = charge {
                let spent = ledger.spent + cost;
                if !valid_amount(spent) {
                    return Err(BudgetError::InvalidUsage);
                }
                ledger.spent = spent;
                ledger.cost_source = Some(match (ledger.cost_source.as_deref(), source) {
                    (Some("mixed"), _)
                    | (Some("estimated" | "catalog"), "upstream_actual")
                    | (Some("upstream_actual"), "estimated" | "catalog") => "mixed".into(),
                    (Some("estimated"), "catalog") => "estimated".into(),
                    _ => source.into(),
                });
            } else {
                ledger.unpriced_tokens_today = ledger.unpriced_tokens_today.saturating_add(tokens);
                if !ledger.unpriced_models_today.iter().any(|id| id == model_id) {
                    ledger.unpriced_models_today.push(model_id.into());
                }
                ledger.cost_source.get_or_insert_with(|| "unpriced".into());
            }
            ledger.tokens = ledger.tokens.saturating_add(tokens);
            Ok(())
        })
    }

    pub fn update_limit(&self, usd: f64, tokens: u64) -> Result<BudgetStatus, BudgetError> {
        if !valid_amount(usd) {
            return Err(BudgetError::InvalidUsage);
        }
        self.update(|ledger| {
            ledger.usd_limit = usd;
            ledger.token_limit = tokens;
            Ok(())
        })
    }

    pub fn update_pricing(&self, price: ModelPricing) -> Result<BudgetStatus, BudgetError> {
        validate_price(&price)?;
        self.update(move |ledger| {
            ledger.pricing.insert(price.model_id.clone(), price);
            Ok(())
        })
    }

    pub fn merge_pricing(&self, pricing: Vec<ModelPricing>) -> Result<BudgetStatus, BudgetError> {
        for price in &pricing {
            validate_price(price)?;
        }
        self.update(move |ledger| {
            for price in pricing {
                if !ledger.pricing.contains_key(&price.model_id) {
                    ledger
                        .discovered_pricing
                        .entry(price.model_id.clone())
                        .or_insert(price);
                }
            }
            Ok(())
        })
    }

    pub fn update_settings(
        &self,
        usd: f64,
        pricing: Vec<ModelPricing>,
    ) -> Result<BudgetStatus, BudgetError> {
        if !valid_amount(usd) {
            return Err(BudgetError::InvalidUsage);
        }
        for price in &pricing {
            validate_price(price)?;
        }
        self.update(move |ledger| {
            ledger.usd_limit = usd;
            ledger.pricing = pricing
                .into_iter()
                .map(|price| (price.model_id.clone(), price))
                .collect();
            Ok(())
        })
    }

    fn update(
        &self,
        change: impl FnOnce(&mut Ledger) -> Result<(), BudgetError>,
    ) -> Result<BudgetStatus, BudgetError> {
        let mut locked = self.ledger.lock().unwrap();
        let mut next = locked.clone();
        next.refresh();
        change(&mut next)?;
        persist_json(&self.path, &next)?;
        let status = next.status();
        *locked = next;
        Ok(status)
    }
}

fn validate_price(price: &ModelPricing) -> Result<(), BudgetError> {
    if price.model_id.trim().is_empty()
        || !valid_amount(price.input_per_1m_usd)
        || !valid_amount(price.output_per_1m_usd)
        || !valid_amount(price.cached_input_per_1m_usd.unwrap_or(0.0))
    {
        return Err(BudgetError::InvalidUsage);
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn usage() -> TokenUsage {
        TokenUsage {
            input_tokens: 1_000,
            cached_input_tokens: 400,
            output_tokens: 200,
            reasoning_tokens: 80,
            cost_usd: 42.0,
            upstream_cost_usd: None,
        }
    }

    #[test]
    fn first_open_uses_embedded_prices_and_estimates_namespaced_models() {
        let dir = tempfile::tempdir().unwrap();
        let budget = Budget::open(dir.path().join("budget.json")).unwrap();
        assert!(budget.status().pricing_table.is_empty());
        let gpt = budget.model_pricing("gpt-4.1-mini").unwrap();
        assert!((gpt.input_per_1m_usd - 0.4).abs() < 1e-10);
        assert!((gpt.output_per_1m_usd - 1.6).abs() < 1e-10);
        assert!((gpt.cached_input_per_1m_usd.unwrap() - 0.1).abs() < 1e-10);
        let status = budget
            .record_usage("ai-studio/gemini-2.5-pro", &usage())
            .unwrap();
        assert!((status.spent_today_usd - 0.0028).abs() < 1e-10);
        assert_eq!(status.tokens_today, 1_200);
        assert_eq!(status.cost_source.as_deref(), Some("estimated"));
    }

    #[test]
    fn deepseek_v41_catalog_prices_resolve_release_and_gateway_ids() {
        for model in [
            "deepseek-v4.1-flash",
            "DeepSeek-V4.1-Flash-1017",
            "vendor/deepseek-v4.1-flash:high",
        ] {
            let dir = tempfile::tempdir().unwrap();
            let budget = Budget::open(dir.path().join("budget.json")).unwrap();
            let price = budget.model_pricing(model).unwrap();
            assert_eq!(price.model_id, "deepseek-v4.1-flash");
            assert_eq!(price.input_per_1m_usd, 0.15);
            assert_eq!(price.output_per_1m_usd, 0.6);
            assert_eq!(price.cached_input_per_1m_usd, Some(0.003));
            let status = budget.record_usage(model, &usage()).unwrap();
            assert!((status.spent_today_usd - 0.0002112).abs() < 1e-10);
            assert_eq!(status.unpriced_tokens_today, 0);
            assert_eq!(status.cost_source.as_deref(), Some("estimated"));
            assert_eq!(
                budget.ledger.lock().unwrap().cost_source.as_deref(),
                Some("catalog")
            );
        }
    }

    #[test]
    fn upstream_actual_cost_precedes_prices_and_zero_is_valid() {
        let dir = tempfile::tempdir().unwrap();
        let budget = Budget::open(dir.path().join("budget.json")).unwrap();
        let mut usage = usage();
        usage.upstream_cost_usd = Some(0.25);
        usage.cached_input_tokens = 1_001;
        assert!(matches!(
            budget.record_usage("gpt-4.1", &usage),
            Err(BudgetError::InvalidUsage)
        ));
        assert_eq!(budget.status().tokens_today, 0);
        usage.cached_input_tokens = 400;
        let actual = budget.record_usage("gpt-4.1", &usage).unwrap();
        assert_eq!(actual.spent_today_usd, 0.25);
        assert_eq!(actual.cost_source.as_deref(), Some("upstream_actual"));
        usage.upstream_cost_usd = Some(0.0);
        let free = budget.record_usage("gateway/unknown", &usage).unwrap();
        assert_eq!(free.spent_today_usd, 0.25);
        assert_eq!(free.unpriced_tokens_today, 0);
        usage.upstream_cost_usd = Some(f64::NAN);
        let mixed = budget.record_usage("gpt-4.1", &usage).unwrap();
        assert!((mixed.spent_today_usd - 0.253).abs() < 1e-10);
        assert_eq!(mixed.cost_source.as_deref(), Some("mixed"));
    }

    #[test]
    fn unpriced_usage_persists_and_consumes_the_daily_token_budget() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("budget.json");
        let budget = Budget::open(&path).unwrap();
        budget.update_limit(5.0, 3_600).unwrap();
        budget.record_usage("group/smart-split", &usage()).unwrap();
        budget.record_usage("group/smart-split", &usage()).unwrap();
        budget.record_usage("other/unknown", &usage()).unwrap();
        let reopened = Budget::open(path).unwrap();
        let status = reopened.status();
        assert_eq!(status.spent_today_usd, 0.0);
        assert_eq!(status.tokens_today, 3_600);
        assert_eq!(status.unpriced_tokens_today, 3_600);
        assert_eq!(
            status.unpriced_models_today,
            ["group/smart-split", "other/unknown"]
        );
        assert_eq!(status.cost_source.as_deref(), Some("unpriced"));
        assert!(matches!(
            reopened.check_budget(0.0, 0),
            Err(BudgetError::Exceeded)
        ));
    }

    #[test]
    fn rollover_clears_usage_and_cost_sources_but_keeps_prices() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("budget.json");
        let budget = Budget::open(&path).unwrap();
        budget.record_usage("gateway/unknown", &usage()).unwrap();
        let status = budget.record_usage("gpt-4.1", &usage()).unwrap();
        assert_eq!(status.cost_source.as_deref(), Some("estimated"));
        assert_eq!(status.unpriced_tokens_today, 1_200);
        let mut ledger: serde_json::Value =
            serde_json::from_slice(&fs::read(&path).unwrap()).unwrap();
        ledger["day"] = serde_json::json!(Local::now().date_naive().pred_opt().unwrap());
        persist_json(&path, &ledger).unwrap();
        let reopened = Budget::open(path).unwrap();
        let status = reopened.status();
        assert_eq!(status.spent_today_usd, 0.0);
        assert_eq!(status.tokens_today, 0);
        assert_eq!(status.unpriced_tokens_today, 0);
        assert!(status.unpriced_models_today.is_empty());
        assert_eq!(status.cost_source, None);
        assert_eq!(
            reopened.model_pricing("gpt-4.1").unwrap().input_per_1m_usd,
            2.0
        );
    }

    #[test]
    fn discovered_prices_fill_missing_exact_entries_without_overwriting_user_prices() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("budget.json");
        let budget = Budget::open(&path).unwrap();
        let custom = ModelPricing {
            model_id: "gpt-4.1".into(),
            input_per_1m_usd: 11.0,
            output_per_1m_usd: 22.0,
            cached_input_per_1m_usd: None,
        };
        budget.update_pricing(custom.clone()).unwrap();
        budget
            .merge_pricing(vec![
                ModelPricing {
                    input_per_1m_usd: 99.0,
                    ..custom.clone()
                },
                ModelPricing {
                    model_id: "gateway/gpt-4.1".into(),
                    input_per_1m_usd: 31.0,
                    ..custom.clone()
                },
                ModelPricing {
                    model_id: "gateway/unique".into(),
                    ..custom
                },
            ])
            .unwrap();
        let reopened = Budget::open(path).unwrap();
        let status = reopened.record_usage("gateway/gpt-4.1", &usage()).unwrap();
        assert!((status.spent_today_usd - 0.0154).abs() < 1e-10);
        assert_eq!(
            reopened
                .model_pricing("gateway/unique")
                .unwrap()
                .input_per_1m_usd,
            11.0
        );
        assert_eq!(status.pricing_table.len(), 1);
        assert_eq!(
            status
                .pricing_table
                .iter()
                .find(|price| price.model_id == "gpt-4.1")
                .unwrap()
                .input_per_1m_usd,
            11.0
        );
    }

    #[test]
    fn custom_prices_outrank_exact_cache_entries_and_the_cache_outranks_embedded() {
        let dir = tempfile::tempdir().unwrap();
        let model_id = "demo-gateway/gpt-6.2-sol:xhigh";
        persist_json(
            &dir.path().join("pricing_cache.json"),
            &serde_json::json!({
                model_id: { "input_cost_per_token": 7e-6, "output_cost_per_token": 9e-6 }
            }),
        )
        .unwrap();
        let budget = Budget::open(dir.path().join("budget.json")).unwrap();
        assert_eq!(
            budget.model_pricing(model_id).unwrap().input_per_1m_usd,
            7.0
        );
        budget
            .update_pricing(ModelPricing {
                model_id: "gpt-6.1-sol".into(),
                input_per_1m_usd: 3.0,
                output_per_1m_usd: 12.0,
                cached_input_per_1m_usd: Some(0.2),
            })
            .unwrap();
        let status = budget.record_usage(model_id, &usage()).unwrap();
        assert!((status.spent_today_usd - 0.00428).abs() < 1e-10);
        assert_eq!(status.unpriced_tokens_today, 0);
        budget
            .update_pricing(ModelPricing {
                model_id: "demo-gateway/gpt-6.2-sol".into(),
                input_per_1m_usd: 12.0,
                output_per_1m_usd: 14.0,
                cached_input_per_1m_usd: None,
            })
            .unwrap();
        assert_eq!(
            budget
                .model_pricing("demo-gateway/GPT-6.2-SOL-2026-08-01:xhigh")
                .unwrap()
                .input_per_1m_usd,
            12.0
        );
    }

    #[test]
    fn legacy_usage_without_cost_source_is_estimated() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("budget.json");
        persist_json(
            &path,
            &serde_json::json!({ "day": Local::now().date_naive(), "usd_limit": 5.0,
            "token_limit": 1_000_000, "spent": 0.1, "tokens": 20, "pricing": {} }),
        )
        .unwrap();
        let budget = Budget::open(path).unwrap();
        let status = budget
            .record_usage(
                "gateway/model",
                &TokenUsage {
                    upstream_cost_usd: Some(0.2),
                    ..usage()
                },
            )
            .unwrap();
        assert!((status.spent_today_usd - 0.3).abs() < 1e-10);
        assert_eq!(status.cost_source.as_deref(), Some("mixed"));
        assert!(status.pricing_table.is_empty());
    }

    #[test]
    fn limits_stop_calls_and_usage_survives_restart() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("budget.json");
        let budget = Budget::open(&path).unwrap();
        budget.update_limit(0.50, 100).unwrap();
        budget
            .update_pricing(ModelPricing {
                model_id: "test".into(),
                input_per_1m_usd: 10_000.0,
                output_per_1m_usd: 20_000.0,
                cached_input_per_1m_usd: Some(5_000.0),
            })
            .unwrap();
        assert!(budget.check_budget(0.51, 0).is_err());
        assert!(budget.check_budget(0.01, 101).is_err());
        assert!(budget.check_budget(0.50, 100).is_ok());
        let usage = TokenUsage {
            input_tokens: 10,
            cached_input_tokens: 4,
            output_tokens: 22,
            reasoning_tokens: 3,
            cost_usd: 0.0,
            upstream_cost_usd: None,
        };
        let status = budget.record_usage("test", &usage).unwrap();
        assert!((status.spent_today_usd - 0.52).abs() < 1e-8);
        assert!(status.tripped);
        let reopened = Budget::open(path).unwrap();
        assert!(matches!(
            reopened.check_budget(0.0, 0),
            Err(BudgetError::Exceeded)
        ));
        reopened.update_limit(5.0, 32).unwrap();
        assert!(reopened.status().tripped);
    }
}
