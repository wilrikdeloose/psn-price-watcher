#!/usr/bin/env node
"use strict";

require("dotenv").config();

const STORE_GRAPHQL_OP = "https://web.np.playstation.com/api/graphql/v1/op";
const MET_GET_PRODUCT_BY_ID_HASH = "a128042177bd93dd831164103d53b73ef790d56f51dae647064cb8f9d9fc9d1a";
const MET_GET_PRICING_DATA_BY_CONCEPT_ID_HASH = "abcb311ea830e679fe2b697a27f755764535d825b24510ab1239a4ca3092bd09";
const BATCH_SIZE = 3;
const DELAY_MS = 1000;
const PSN_URL_RE = /store\.playstation\.com/i;

function dig(obj, ...keys) {
  let v = obj;
  for (const k of keys) {
    if (v == null) return undefined;
    v = v[k];
  }
  return v;
}

function parseEuroPrice(val) {
  if (val == null) return NaN;
  if (typeof val === "number" && !Number.isNaN(val)) return val;
  const str = String(val).replace(/€\s*/g, "").replace(/\s/g, "").replace(",", ".");
  return parseFloat(str) || NaN;
}

function extractProductId(url) {
  try {
    const m = new URL(url.trim()).pathname.match(/\/product\/([^/?#]+)/);
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
    let p = u.pathname.replace(/^\/[a-z]{2}-[a-z]{2}/, "") || "/";
    if (!p.startsWith("/product")) p = "/product" + (p === "/" ? "" : p);
    u.pathname = "/nl-nl" + p;
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
  return conceptId ? { name, conceptId } : null;
}

function extractPricingFromApiResponse(data) {
  const concept = dig(data, "data", "conceptRetrieve");
  const priceObj = concept?.defaultProduct?.price ?? concept?.price;
  if (!priceObj) return null;
  const baseCents = priceObj.basePriceValue ?? priceObj.originalPriceValue;
  const discCents = priceObj.discountedValue ?? priceObj.discountedPriceValue;
  if (typeof baseCents === "number" || typeof discCents === "number") {
    const original = typeof baseCents === "number" ? baseCents / 100 : parseEuroPrice(priceObj.basePrice);
    const current = typeof discCents === "number" ? discCents / 100 : parseEuroPrice(priceObj.discountedPrice ?? priceObj.basePrice);
    if (!Number.isNaN(current) && current > 0) {
      return { current, original: Number.isNaN(original) || original <= 0 ? current : original };
    }
  }
  const current = parseEuroPrice(priceObj.discountedPrice ?? priceObj.basePrice);
  const original = parseEuroPrice(priceObj.basePrice ?? priceObj.originalPrice);
  if (!Number.isNaN(current)) return { current, original: Number.isNaN(original) || original <= 0 ? current : original };
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
  const data = await res.json().catch(() => ({}));
  return res.ok ? extractPricingFromApiResponse(data) : null;
}

async function fetchProductById(productId, token) {
  const params = new URLSearchParams();
  params.set("operationName", "metGetProductById");
  params.set("variables", JSON.stringify({ productId }));
  params.set("extensions", JSON.stringify({ persistedQuery: { version: 1, sha256Hash: MET_GET_PRODUCT_BY_ID_HASH } }));
  const headers = { "Content-Type": "application/json", "x-psn-store-locale-override": "nl-NL", Accept: "application/json" };
  if (token) headers["Authorization"] = `Bearer ${token}`;
  const res = await fetch(`${STORE_GRAPHQL_OP}?${params}`, { headers });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) return null;
  const product = extractProductFromApiResponse(data);
  if (!product?.conceptId) return null;
  const pricing = await fetchPricingByConceptId(product.conceptId, token);
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
        const url = normalizeUrl(r.url);
        if (!url) return null;
        const productId = extractProductId(url);
        if (!productId) return null;

        const out = await fetchProductById(productId, token);
        if (!out) {
          console.log(`✗ Row ${r.row}: ${r.game || r.url} — no data`);
          return null;
        }

        const pricing = out.pricing;
        const original = pricing?.original ?? null;
        const current = pricing?.current ?? null;
        const discount =
          original != null && current != null && original > 0
            ? Math.round((1 - current / original) * 100)
            : null;

        const discLabel = discount != null ? (discount > 0 ? `-${discount}%` : "0%") : "";
        console.log(`✓ ${out.name}${discount > 0 ? ` ${discLabel}` : ""}`);

        return {
          row: r.row,
          game: out.name,
          url,
          originalPrice: original != null ? `€ ${original.toFixed(2)}` : "",
          currentPrice: current != null ? `€ ${current.toFixed(2)}` : "",
          discount: discLabel,
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
