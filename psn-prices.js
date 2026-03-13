#!/usr/bin/env node
"use strict";

require("dotenv").config();
const fs = require("fs");

const STORE_GRAPHQL_OP = "https://web.np.playstation.com/api/graphql/v1/op";
const MET_GET_PRODUCT_BY_ID_HASH = "a128042177bd93dd831164103d53b73ef790d56f51dae647064cb8f9d9fc9d1a";
const MET_GET_PRICING_DATA_BY_CONCEPT_ID_HASH = "abcb311ea830e679fe2b697a27f755764535d825b24510ab1239a4ca3092bd09";
const PRODUCT_RETRIEVE_FOR_CTAS_WITH_PRICE_HASH = "737838e0e3fe50986b4087b51327970a71c80497576bea07904e9ecf4a2dab02";
const CONCEPT_RETRIEVE_FOR_CTAS_WITH_PRICE_HASH = "4ec6effdcdb6e041936c79acecd44aeea347ae3055d2b23ee2c794084b6e9c60";
const BATCH_SIZE = 3;
const DELAY_MS = 1000;
const PSN_URL_RE = /store\.playstation\.com/i;
const TEMP_FILES = ["psn-debug-response.json", "psn-debug-pricing.json"];

function dig(obj, ...keys) {
  let v = obj;
  for (const k of keys) {
    if (v == null) return undefined;
    v = v[k];
  }
  return v;
}

function cleanupTempFiles() {
  for (const file of TEMP_FILES) {
    try {
      fs.unlinkSync(file);
    } catch (err) {
      if (!err || err.code !== "ENOENT") {
        console.warn(`Failed to remove temp file ${file}`, err);
      }
    }
  }
}

function parseEuroPrice(val) {
  if (val == null) return NaN;
  if (typeof val === "number" && !Number.isNaN(val)) return val;
  const str = String(val).replace(/€\s*/g, "").trim();
  // Treat localized "free" labels as zero price.
  if (/^(gratis|free)$/i.test(str)) return 0;
  const normalized = str.replace(/\s/g, "").replace(",", ".");
  return parseFloat(normalized) || NaN;
}

function extractPricingFromPriceObject(priceObj) {
  if (!priceObj) return null;
  const baseCents = priceObj.basePriceValue ?? priceObj.originalPriceValue;
  const discCents = priceObj.discountedValue ?? priceObj.discountedPriceValue;
  if (typeof baseCents === "number" || typeof discCents === "number") {
    const original = typeof baseCents === "number" ? baseCents / 100 : parseEuroPrice(priceObj.basePrice);
    const current = typeof discCents === "number" ? discCents / 100 : parseEuroPrice(priceObj.discountedPrice ?? priceObj.basePrice);
    if (!Number.isNaN(current) && (current > 0 || priceObj.isFree === true || discCents === 0)) {
      return { current, original: Number.isNaN(original) || original <= 0 ? current : original };
    }
  }
  const current = parseEuroPrice(priceObj.discountedPrice ?? priceObj.basePrice);
  const original = parseEuroPrice(priceObj.basePrice ?? priceObj.originalPrice);
  if (!Number.isNaN(current)) return { current, original: Number.isNaN(original) || original <= 0 ? current : original };
  return null;
}

function extractProductId(url) {
  try {
    const m = new URL(url.trim()).pathname.match(/\/product\/([^/?#]+)/i);
    return m ? m[1] : null;
  } catch {
    return null;
  }
}

function extractConceptId(url) {
  try {
    const m = new URL(url.trim()).pathname.match(/\/concept\/([^/?#]+)/i);
    return m ? m[1] : null;
  } catch {
    return null;
  }
}

function normalizeUrl(url) {
  const trimmed = String(url).trim();
  if (!trimmed || !PSN_URL_RE.test(trimmed)) return null;
  try {
    const u = new URL(trimmed);
    u.hostname = "store.playstation.com";
    const localeStripped = u.pathname.replace(/^\/[a-z]{2}-[a-z]{2}(?=\/|$)/i, "") || "/";
    let path = localeStripped;
    const conceptMatch = path.match(/(\/concept\/[^/?#]+)/i);
    if (conceptMatch) {
      path = conceptMatch[1];
    } else {
      const productMatch = path.match(/(\/product\/[^/?#]+)/i);
      if (productMatch) {
        path = productMatch[1];
      } else if (!path.startsWith("/product/")) {
        path = `/product${path.startsWith("/") ? path : `/${path}`}`;
      }
    }
    u.pathname = `/nl-nl${path}`;
    return u.toString();
  } catch {
    return trimmed.startsWith("http") ? trimmed : null;
  }
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function extractProductFromApiResponse(data) {
  const product =
    dig(data, "data", "productRetrieve") ??
    dig(data, "data", "product") ??
    dig(data, "product");
  if (!product) return null;
  const name =
    product.name ??
    product.invariantName ??
    dig(product, "concept", "name") ??
    dig(product, "concept", "invariantName") ??
    "Unknown";
  const conceptId = dig(product, "concept", "id");
  return {
    name,
    conceptId: conceptId ?? null,
  };
}

async function fetchPricingForProductCtas(productId, token) {
  const params = new URLSearchParams();
  params.set("operationName", "productRetrieveForCtasWithPrice");
  params.set("variables", JSON.stringify({ productId }));
  params.set("extensions", JSON.stringify({ persistedQuery: { version: 1, sha256Hash: PRODUCT_RETRIEVE_FOR_CTAS_WITH_PRICE_HASH } }));
  const headers = { "Content-Type": "application/json", "x-psn-store-locale-override": "nl-NL", Accept: "application/json" };
  if (token) headers["Authorization"] = `Bearer ${token}`;
  const res = await fetch(`${STORE_GRAPHQL_OP}?${params}`, { headers });
  let data;
  try {
    data = await res.json();
  } catch (e) {
    console.warn("Failed to parse CTAs pricing response JSON", e);
    return null;
  }
  if (!res.ok) {
    console.warn("CTAs pricing request failed", { status: res.status, statusText: res.statusText, body: data });
    return null;
  }
  const product = dig(data, "data", "productRetrieve");
  if (!product) {
    return null;
  }
  // Prefer CTA price (base/discounted euro strings); fall back to sku price if needed.
  const webctas = Array.isArray(product.webctas) ? product.webctas : [];
  // Try to find a CTA that represents a normal purchase, not a PS Plus upsell.
  const preferredCta =
    webctas.find((c) => c?.price?.applicability === "APPLICABLE" || c?.type === "ADD_TO_CART") ||
    webctas.find((c) => c?.price) ||
    null;

  const ctaPrice = preferredCta?.price;
  const pricingFromCta = extractPricingFromPriceObject({
    basePrice: ctaPrice?.basePrice,
    discountedPrice: ctaPrice?.discountedPrice,
    basePriceValue: ctaPrice?.basePriceValue,
    discountedValue: ctaPrice?.discountedValue,
    originalPriceValue: ctaPrice?.originalPriceValue,
    originalPrice: ctaPrice?.originalPrice,
    isFree: ctaPrice?.isFree,
  });
  if (pricingFromCta) return pricingFromCta;

  const sku = Array.isArray(product.skus) && product.skus.length > 0 ? product.skus[0] : null;
  if (sku && typeof sku.price === "number") {
    const current = sku.price / 100;
    if (current > 0) {
      return { current, original: current };
    }
  }
  console.warn(`Pricing debug: no price in CTAs or skus for product ${productId}`);
  return null;
}

async function fetchPricingByConceptId(conceptId, token) {
  const params = new URLSearchParams();
  params.set("operationName", "metGetPricingDataByConceptId");
  params.set("variables", JSON.stringify({ conceptId }));
  params.set("extensions", JSON.stringify({ persistedQuery: { version: 1, sha256Hash: MET_GET_PRICING_DATA_BY_CONCEPT_ID_HASH } }));
  const headers = { "Content-Type": "application/json", "x-psn-store-locale-override": "nl-NL", Accept: "application/json" };
  if (token) headers["Authorization"] = `Bearer ${token}`;
  const res = await fetch(`${STORE_GRAPHQL_OP}?${params}`, { headers });
  let data;
  try {
    data = await res.json();
  } catch (e) {
    console.warn(`Could not retrieve price for concept ${conceptId}: invalid pricing response`);
    return null;
  }
  if (!res.ok) {
    console.warn(`Could not retrieve price for concept ${conceptId}: HTTP ${res.status}`);
    return null;
  }
  const priceObj =
    dig(data, "data", "conceptRetrieve", "defaultProduct", "price") ??
    dig(data, "data", "conceptRetrieve", "price");
  const pricing = extractPricingFromPriceObject(priceObj);
  if (!pricing) {
    console.warn(`Could not retrieve price for concept ${conceptId}: no pricing in response`);
  }
  return pricing;
}

async function fetchPricingForConceptCtas(conceptId, token) {
  const params = new URLSearchParams();
  params.set("operationName", "conceptRetrieveForCtasWithPrice");
  params.set("variables", JSON.stringify({ conceptId }));
  params.set("extensions", JSON.stringify({ persistedQuery: { version: 1, sha256Hash: CONCEPT_RETRIEVE_FOR_CTAS_WITH_PRICE_HASH } }));
  const headers = { "Content-Type": "application/json", "x-psn-store-locale-override": "nl-NL", Accept: "application/json" };
  if (token) headers["Authorization"] = `Bearer ${token}`;
  const res = await fetch(`${STORE_GRAPHQL_OP}?${params}`, { headers });
  let data;
  try {
    data = await res.json();
  } catch (e) {
    console.warn(`Pricing debug: failed to parse CTAs concept response for ${conceptId}`, e);
    return null;
  }
  if (!res.ok) {
    console.warn(`Pricing debug: CTAs concept request failed for ${conceptId} with HTTP ${res.status}`);
    return null;
  }
  const defaultProduct = dig(data, "data", "conceptRetrieve", "defaultProduct");
  if (!defaultProduct) return null;
  const webctas = Array.isArray(defaultProduct.webctas) ? defaultProduct.webctas : [];
  const preferredCta =
    webctas.find((c) => c?.price?.applicability === "APPLICABLE" || c?.type === "ADD_TO_CART") ||
    webctas.find((c) => c?.price) ||
    null;
  const ctaPrice = preferredCta?.price;
  const pricingFromCta = extractPricingFromPriceObject({
    basePrice: ctaPrice?.basePrice,
    discountedPrice: ctaPrice?.discountedPrice,
    basePriceValue: ctaPrice?.basePriceValue,
    discountedValue: ctaPrice?.discountedValue,
    originalPriceValue: ctaPrice?.originalPriceValue,
    originalPrice: ctaPrice?.originalPrice,
    isFree: ctaPrice?.isFree,
  });
  if (pricingFromCta) return pricingFromCta;
  const sku = Array.isArray(defaultProduct.skus) && defaultProduct.skus.length > 0 ? defaultProduct.skus[0] : null;
  if (sku && typeof sku.price === "number") {
    const current = sku.price / 100;
    if (current >= 0) {
      return { current, original: current };
    }
  }
  console.warn(`Pricing debug: no price in concept CTAs or skus for concept ${conceptId}`);
  return null;
}

async function resolveConceptToProductUrl(conceptId, token) {
  const params = new URLSearchParams();
  params.set("operationName", "conceptRetrieveForCtasWithPrice");
  params.set("variables", JSON.stringify({ conceptId }));
  params.set("extensions", JSON.stringify({ persistedQuery: { version: 1, sha256Hash: CONCEPT_RETRIEVE_FOR_CTAS_WITH_PRICE_HASH } }));
  const headers = { "Content-Type": "application/json", "x-psn-store-locale-override": "nl-NL", Accept: "application/json" };
  if (token) headers["Authorization"] = `Bearer ${token}`;
  const res = await fetch(`${STORE_GRAPHQL_OP}?${params}`, { headers });
  let data;
  try {
    data = await res.json();
  } catch {
    return null;
  }
  if (!res.ok) return null;
  const defaultProduct = dig(data, "data", "conceptRetrieve", "defaultProduct");
  const productId = defaultProduct?.id;
  if (!productId) return null;
  return `https://store.playstation.com/nl-nl/product/${productId}`;
}

async function fetchProductById(productId, token) {
  const params = new URLSearchParams();
  params.set("operationName", "metGetProductById");
  params.set("variables", JSON.stringify({ productId }));
  params.set("extensions", JSON.stringify({ persistedQuery: { version: 1, sha256Hash: MET_GET_PRODUCT_BY_ID_HASH } }));
  const headers = { "Content-Type": "application/json", "x-psn-store-locale-override": "nl-NL", Accept: "application/json" };
  if (token) headers["Authorization"] = `Bearer ${token}`;
  const res = await fetch(`${STORE_GRAPHQL_OP}?${params}`, { headers });
  let data;
  try {
    data = await res.json();
  } catch (e) {
    console.warn("Failed to parse product response JSON", e);
    return null;
  }
  if (!res.ok) {
    console.warn("Product request failed", { status: res.status, statusText: res.statusText, body: data });
    return null;
  }
  const product = extractProductFromApiResponse(data);
  if (!product) {
    return null;
  }
  let pricing = await fetchPricingForProductCtas(productId, token);
  if (!pricing && product.conceptId) {
    // First, try concept-level CTAs pricing (used by some free games like Avatar Island).
    pricing = await fetchPricingForConceptCtas(product.conceptId, token);
  }
  if (!pricing && product.conceptId) {
    // Fallback to generic metGetPricingDataByConceptId for older flows.
    pricing = await fetchPricingByConceptId(product.conceptId, token);
  }
  if (!pricing) {
    console.warn(`Could not retrieve price for product ${productId} (${product.name})`);
  }
  return { name: product.name, pricing };
}

async function getPsnToken() {
  const npsso = process.env.PSN_NPSSO?.trim();
  if (!npsso) return null;
  try {
    const { exchangeNpssoForAccessCode, exchangeAccessCodeForAuthTokens } = await import("psn-api");
    const code = await exchangeNpssoForAccessCode(npsso);
    const auth = await exchangeAccessCodeForAuthTokens(code);
    return auth.accessToken;
  } catch {
    return null;
  }
}

async function readSheet(scriptUrl) {
  const res = await fetch(scriptUrl, { redirect: "follow" });
  if (!res.ok) throw new Error(`Apps Script GET failed: HTTP ${res.status}`);
  return res.json();
}

async function writeSheet(scriptUrl, updates) {
  const res = await fetch(scriptUrl, {
    method: "POST",
    redirect: "follow",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ updates }),
  });
  if (!res.ok) throw new Error(`Apps Script POST failed: HTTP ${res.status}`);
  return res.json();
}

async function main() {
  process.on("exit", cleanupTempFiles);

  const scriptUrl = process.env.APPS_SCRIPT_URL?.trim();
  if (!scriptUrl) {
    console.error("Error: APPS_SCRIPT_URL is required in .env");
    process.exit(1);
  }

  console.log("Reading sheet...");
  const sheet = await readSheet(scriptUrl);
  const rows = sheet.rows || [];
  if (rows.length === 0) {
    console.log("No data rows in sheet.");
    return;
  }

  const withLinks = rows.filter((r) => r.url && PSN_URL_RE.test(r.url));

  if (withLinks.length === 0) {
    console.log("No rows with PSN store links in the Game column.");
    return;
  }

  console.log(`Found ${withLinks.length} row(s) with PSN links. Fetching prices...\n`);
  const token = await getPsnToken();
  const updates = [];

  for (let i = 0; i < withLinks.length; i += BATCH_SIZE) {
    const batch = withLinks.slice(i, i + BATCH_SIZE);
    const results = await Promise.all(
      batch.map(async (r) => {
        const displayName = r.game || r.url || "Unknown title";
        let url = normalizeUrl(r.url);
        if (!url) {
          console.log(`✗ ${displayName} - invalid PSN URL`);
          return null;
        }

        const conceptId = extractConceptId(url);
        if (conceptId) {
          const productUrl = await resolveConceptToProductUrl(conceptId, token);
          if (productUrl) {
            url = productUrl;
          } else {
            console.log(`✗ ${displayName} - concept has no product page`);
            return null;
          }
        }

        const productId = extractProductId(url);
        if (!productId) {
          console.log(`✗ ${displayName} - could not extract product ID`);
          return null;
        }

        const out = await fetchProductById(productId, token);
        if (!out || !out.pricing) {
          console.log(`✗ ${out?.name || displayName} - could not retrieve price`);
          return null;
        }

        const pricing = out.pricing;
        const original = pricing?.original ?? null;
        const current = pricing?.current ?? null;
        let discount = null;
        if (original != null && current != null) {
          discount = original > 0 ? Math.round((1 - current / original) * 100) : 0;
        }

        const discountLabel = discount != null ? (discount > 0 ? `-${discount}%` : "0%") : "";
        console.log(`✓ ${out.name}`);

        return {
          row: r.row,
          game: out.name,
          url,
          originalPrice: original != null ? `€ ${original.toFixed(2)}` : "",
          currentPrice: current != null ? `€ ${current.toFixed(2)}` : "",
          discount: discountLabel,
        };
      })
    );

    for (const u of results) {
      if (u) updates.push(u);
    }
    if (i + BATCH_SIZE < withLinks.length) await sleep(DELAY_MS);
  }

  if (updates.length === 0) {
    console.log("\nNo prices fetched.");
    return;
  }

  console.log(`\nWriting ${updates.length} row(s) back to sheet...`);
  const result = await writeSheet(scriptUrl, updates);
  console.log(`Done. Updated ${result.updated ?? updates.length} row(s).`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
