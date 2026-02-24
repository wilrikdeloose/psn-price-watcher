#!/usr/bin/env node
"use strict";

const fs = require("fs");
const path = require("path");

const STORE_GRAPHQL_OP =
  "https://web.np.playstation.com/api/graphql/v1/op";
const MET_GET_PRODUCT_BY_ID_HASH =
  "a128042177bd93dd831164103d53b73ef790d56f51dae647064cb8f9d9fc9d1a";
const MET_GET_PRICING_DATA_BY_CONCEPT_ID_HASH =
  "abcb311ea830e679fe2b697a27f755764535d825b24510ab1239a4ca3092bd09";
const BATCH_SIZE = 3;
const DELAY_BETWEEN_BATCHES_MS = 1500;
const REPORT_PATH = "psn-report.html";

function usage() {
  console.error(`
Usage: node psn-prices.js <path-to-urls.csv> [options]

  <path-to-urls.csv>  Plain text file with one PlayStation Store URL per line.

  Optional: set PSN_NPSSO in the environment to use authenticated requests
  (obtain NPSSO from https://ca.account.sony.com/api/v1/ssocookie while logged into PSN).

Example:
  node psn-prices.js list.csv
`);
}

function normalizeUrl(url) {
  const trimmed = url.trim();
  if (!trimmed) return null;
  try {
    const u = new URL(trimmed);
    u.hostname = "store.playstation.com";
    let pathname = u.pathname.replace(/^\/[a-z]{2}-[a-z]{2}/, "") || "/";
    if (!pathname.startsWith("/product")) pathname = "/product" + (pathname === "/" ? "" : pathname);
    u.pathname = "/nl-nl" + pathname;
    return u.toString();
  } catch {
    return trimmed.startsWith("http") ? trimmed : null;
  }
}

function extractProductId(url) {
  try {
    const match = new URL(url).pathname.match(/\/product\/([^/?#]+)/);
    return match ? match[1] : null;
  } catch {
    return null;
  }
}

function parseEuroPrice(val) {
  if (val == null) return NaN;
  if (typeof val === "number" && !Number.isNaN(val)) return val;
  const str = String(val).replace(/€\s*/g, "").replace(/\s/g, "").replace(",", ".");
  return parseFloat(str) || NaN;
}

function parseCsvLines(filePath) {
  const content = fs.readFileSync(filePath, "utf-8");
  return content
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.startsWith("#"));
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function dig(obj, ...keys) {
  let v = obj;
  for (const k of keys) {
    if (v == null) return undefined;
    v = v[k];
  }
  return v;
}

function extractProductFromApiResponse(data) {
  const product =
    dig(data, "data", "productRetrieve") ??
    dig(data, "data", "product") ??
    dig(data, "data", "metGetProductById") ??
    dig(data, "product");
  if (!product) return null;

  const name =
    product.name ??
    product.title ??
    product.invariantName ??
    dig(product, "concept", "name") ??
    dig(product, "concept", "invariantName") ??
    dig(product, "localizedNames", "default") ??
    "Unknown";

  const skus = product.skus ?? product.editions ?? [];
  const defaultSku = product.defaultSku ?? skus[0];
  const offer = defaultSku ?? product;
  const prices = offer.prices ?? offer.price ?? product.prices ?? product.price;
  const offers = product.offers ?? (Array.isArray(prices) ? prices : prices ? [prices] : []);

  let current = NaN;
  let original = NaN;

  if (offers && Array.isArray(offers) && offers.length > 0) {
    const o = offers[0];
    current = parseEuroPrice(o.finalPrice ?? o.discountedPrice ?? o.price ?? o.value);
    original = parseEuroPrice(o.originalPrice ?? o.listPrice ?? o.basePrice ?? o.price ?? o.value);
  }
  if (Number.isNaN(current) && prices) {
    const arr = Array.isArray(prices) ? prices : [prices];
    const withValue = arr
      .map((p) => (typeof p === "object" ? parseEuroPrice(p.value ?? p.amount ?? p.finalPrice ?? p.price) : parseEuroPrice(p)))
      .filter((n) => !Number.isNaN(n) && n > 0);
    if (withValue.length >= 2) {
      withValue.sort((a, b) => a - b);
      current = withValue[0];
      original = withValue[withValue.length - 1];
    } else if (withValue.length === 1) {
      current = original = withValue[0];
    }
  }
  if (typeof offer === "object" && Number.isNaN(current)) {
    current = parseEuroPrice(offer.finalPrice ?? offer.price ?? offer.value);
    original = parseEuroPrice(offer.originalPrice ?? offer.listPrice ?? offer.basePrice ?? offer.price ?? offer.value);
  }

  if (Number.isNaN(original) || original <= 0) original = current;
  if (Number.isNaN(current)) return { name, current: null, original: null };

  return {
    name,
    current,
    original: Number.isNaN(original) || original <= 0 ? current : original,
  };
}

function extractPricingFromApiResponse(data) {
  const concept = dig(data, "data", "conceptRetrieve");
  const defaultProduct = concept?.defaultProduct;
  const priceObj = defaultProduct?.price ?? concept?.price;
  if (priceObj) {
    const baseCents = priceObj.basePriceValue ?? priceObj.originalPriceValue;
    const discountedCents = priceObj.discountedValue ?? priceObj.discountedPriceValue ?? priceObj.finalPriceValue;
    if (typeof baseCents === "number" || typeof discountedCents === "number") {
      const original = typeof baseCents === "number" ? baseCents / 100 : parseEuroPrice(priceObj.basePrice ?? priceObj.originalPrice);
      const current = typeof discountedCents === "number" ? discountedCents / 100 : parseEuroPrice(priceObj.discountedPrice ?? priceObj.finalPrice ?? priceObj.basePrice);
      if (!Number.isNaN(current) && current > 0) {
        return {
          current,
          original: Number.isNaN(original) || original <= 0 ? current : original,
        };
      }
    }
    const current = parseEuroPrice(priceObj.discountedPrice ?? priceObj.finalPrice ?? priceObj.basePrice);
    const original = parseEuroPrice(priceObj.basePrice ?? priceObj.originalPrice ?? priceObj.listPrice);
    if (!Number.isNaN(current) && current > 0) {
      return {
        current,
        original: Number.isNaN(original) || original <= 0 ? current : original,
      };
    }
  }
  const root = dig(data, "data", "metGetPricingDataByConceptId") ?? dig(data, "data", "pricingData") ?? dig(data, "data") ?? data;
  const offers = root?.offers ?? root?.prices ?? (Array.isArray(root) ? root : [root]);
  const arr = Array.isArray(offers) ? offers : offers ? [offers] : [];
  if (arr.length === 0) return null;
  const o = arr[0];
  const current = parseEuroPrice(o?.finalPrice ?? o?.discountedPrice ?? o?.price ?? o?.value ?? o?.amount);
  const original = parseEuroPrice(o?.originalPrice ?? o?.listPrice ?? o?.basePrice ?? o?.price ?? o?.value ?? o?.amount);
  if (Number.isNaN(current)) return null;
  return {
    current,
    original: Number.isNaN(original) || original <= 0 ? current : original,
  };
}

async function fetchPricingByConceptId(conceptId, accessToken) {
  const params = new URLSearchParams();
  params.set("operationName", "metGetPricingDataByConceptId");
  params.set("variables", JSON.stringify({ conceptId }));
  params.set(
    "extensions",
    JSON.stringify({
      persistedQuery: { version: 1, sha256Hash: MET_GET_PRICING_DATA_BY_CONCEPT_ID_HASH },
    })
  );
  const url = `${STORE_GRAPHQL_OP}?${params.toString()}`;
  const headers = {
    "Content-Type": "application/json",
    "x-psn-store-locale-override": "nl-NL",
    Accept: "application/json",
  };
  if (accessToken) headers["Authorization"] = `Bearer ${accessToken}`;

  const res = await fetch(url, { method: "GET", headers });
  const data = await res.json().catch(() => ({}));
  if (process.env.PSN_DEBUG && data) {
    fs.writeFileSync(
      path.join(process.cwd(), "psn-debug-pricing.json"),
      JSON.stringify(data, null, 2),
      "utf-8"
    );
  }
  if (!res.ok) return null;
  return extractPricingFromApiResponse(data);
}

async function fetchProductById(productId, accessToken) {
  const params = new URLSearchParams();
  params.set("operationName", "metGetProductById");
  params.set("variables", JSON.stringify({ productId }));
  params.set(
    "extensions",
    JSON.stringify({
      persistedQuery: { version: 1, sha256Hash: MET_GET_PRODUCT_BY_ID_HASH },
    })
  );
  const url = `${STORE_GRAPHQL_OP}?${params.toString()}`;
  const headers = {
    "Content-Type": "application/json",
    "x-psn-store-locale-override": "nl-NL",
    Accept: "application/json",
  };
  if (accessToken) headers["Authorization"] = `Bearer ${accessToken}`;

  const res = await fetch(url, { method: "GET", headers });
  const data = await res.json().catch(() => ({}));

  if (!res.ok) {
    return {
      error: `HTTP ${res.status}`,
      data: null,
    };
  }
  const extracted = extractProductFromApiResponse(data);
  const conceptId = dig(data, "data", "productRetrieve", "concept", "id") ?? dig(data, "data", "product", "concept", "id");
  if (extracted?.name && conceptId) {
    const pricing = await fetchPricingByConceptId(conceptId, accessToken);
    if (pricing) {
      return {
        name: extracted.name,
        current: pricing.current,
        original: pricing.original,
        error: null,
        data,
      };
    }
  }
  if (extracted && extracted.current != null) return { ...extracted, error: null, data };
  if (extracted?.name) return { ...extracted, error: "No price in response", data };
  const errMsg = dig(data, "errors", "0", "message") || dig(data, "errors", "0") || "No product data in response";
  return {
    name: null,
    current: null,
    original: null,
    error: typeof errMsg === "string" ? errMsg : JSON.stringify(errMsg).slice(0, 80),
    data,
  };
}

async function getAuthToken() {
  const npsso = process.env.PSN_NPSSO?.trim();
  if (!npsso) return null;
  try {
    const {
      exchangeNpssoForAccessCode,
      exchangeAccessCodeForAuthTokens,
    } = await import("psn-api");
    const accessCode = await exchangeNpssoForAccessCode(npsso);
    const auth = await exchangeAccessCodeForAuthTokens(accessCode);
    return auth.accessToken;
  } catch (err) {
    console.error("Warning: PSN auth failed (invalid or expired PSN_NPSSO). Continuing without auth.", err?.message || err);
    return null;
  }
}

async function main() {
  const csvPath = process.argv[2];
  if (!csvPath) {
    usage();
    process.exit(1);
  }
  const resolved = path.resolve(process.cwd(), csvPath);
  if (!fs.existsSync(resolved)) {
    console.error(`Error: File not found: ${resolved}`);
    usage();
    process.exit(1);
  }

  const lines = parseCsvLines(resolved);
  const urls = lines.map(normalizeUrl).filter(Boolean);
  if (urls.length === 0) {
    console.error("Error: No valid URLs found in the CSV file.");
    process.exit(1);
  }

  console.log(`Tracking ${urls.length} product(s) via Store API...\n`);

  const accessToken = await getAuthToken();
  if (accessToken) console.log("Using PSN auth (PSN_NPSSO).\n");

  const results = [];
  for (let i = 0; i < urls.length; i += BATCH_SIZE) {
    const batch = urls.slice(i, i + BATCH_SIZE);
    const batchResults = await Promise.all(
      batch.map(async (url) => {
        const productId = extractProductId(url);
        if (!productId) {
          return { url, name: null, originalPrice: null, currentPrice: null, discount: null, error: "Invalid URL (no product ID)" };
        }
        const out = await fetchProductById(productId, accessToken);
        const result = {
          url,
          name: out.name ?? null,
          originalPrice: out.original ?? null,
          currentPrice: out.current ?? null,
          discount: null,
          error: out.error ?? null,
        };
        if (result.currentPrice != null && result.originalPrice != null && result.originalPrice > 0) {
          result.discount = Math.round((1 - result.currentPrice / result.originalPrice) * 100);
        }
        return result;
      })
    );
    for (const r of batchResults) {
      results.push(r);
      if (r.error) {
        console.log(`✗ ${r.url}: ${r.error}`);
      } else {
        const disc = r.discount != null && !Number.isNaN(r.discount) && r.discount > 0 ? ` -${r.discount}%` : "";
        console.log(`✓ ${r.name}${disc}`);
      }
    }
    if (i + BATCH_SIZE < urls.length) await sleep(DELAY_BETWEEN_BATCHES_MS);
  }

  const withPrices = results.filter((r) => r.currentPrice != null && r.originalPrice != null);
  const sorted = [...withPrices].sort((a, b) => (b.discount ?? -1) - (a.discount ?? -1));
  const failed = results.filter((r) => r.currentPrice == null || r.originalPrice == null);
  const reportRows = [...sorted, ...failed];

  const withDiscount = sorted.filter((r) => r.discount != null && r.discount > 0);
  const totalSavings = withDiscount.reduce(
    (sum, r) => sum + (r.originalPrice - r.currentPrice),
    0
  );
  const biggestDiscount = withDiscount.length
    ? Math.max(...withDiscount.map((r) => r.discount))
    : null;

  const summary = {
    total: results.length,
    onSale: withDiscount.length,
    failed: failed.length,
    totalSavings,
    biggestDiscount,
  };

  const html = buildHtmlReport(reportRows, summary);
  const reportResolved = path.resolve(process.cwd(), REPORT_PATH);
  fs.writeFileSync(reportResolved, html, "utf-8");
  console.log(`\nReport written to ${reportResolved}`);

  printTextTable(reportRows);

  const open = (await import("open")).default;
  await open(reportResolved);
}

function buildHtmlReport(results, summary) {
  const rows = results
    .map(
      (r, i) => `
    <tr>
      <td>${i + 1}</td>
      <td><a href="${escapeHtml(r.url)}" target="_blank" rel="noopener">${escapeHtml(r.name || r.url)}</a></td>
      <td>${r.originalPrice != null ? "€ " + r.originalPrice.toFixed(2) : "—"}</td>
      <td>${r.currentPrice != null ? "€ " + r.currentPrice.toFixed(2) : "—"}</td>
      <td>${formatDiscountBadge(r.discount)}</td>
      <td>${r.error ? `<span class="status-error">${escapeHtml(r.error)}</span>` : "—"}</td>
    </tr>`
    )
    .join("");

  return `<!DOCTYPE html>
<html lang="nl">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>PSN Price Report</title>
  <style>
    :root { --bg: #0d1117; --card: #161b22; --text: #e6edf3; --muted: #8b949e; --accent: #58a6ff; --sale: #3fb950; --border: #30363d; }
    * { box-sizing: border-box; }
    body { font-family: 'Segoe UI', system-ui, sans-serif; background: var(--bg); color: var(--text); margin: 0; padding: 2rem; line-height: 1.5; }
    .container { max-width: 900px; margin: 0 auto; }
    h1 { font-size: 1.5rem; margin-bottom: 1rem; }
    .summary { display: grid; grid-template-columns: repeat(auto-fit, minmax(140px, 1fr)); gap: 1rem; margin-bottom: 2rem; }
    .stat { background: var(--card); border: 1px solid var(--border); border-radius: 8px; padding: 1rem; }
    .stat strong { display: block; font-size: 1.25rem; color: var(--accent); }
    .stat span { font-size: 0.875rem; color: var(--muted); }
    table { width: 100%; border-collapse: collapse; background: var(--card); border-radius: 8px; overflow: hidden; border: 1px solid var(--border); }
    th, td { padding: 0.75rem 1rem; text-align: left; border-bottom: 1px solid var(--border); }
    th { background: rgba(88, 166, 255, 0.1); font-weight: 600; }
    tr:last-child td { border-bottom: none; }
    a { color: var(--accent); text-decoration: none; }
    a:hover { text-decoration: underline; }
    .badge { display: inline-block; padding: 0.2em 0.5em; border-radius: 4px; font-weight: 600; font-size: 0.875rem; }
    .badge-sale { background: rgba(63, 185, 80, 0.2); color: var(--sale); }
    .badge-none { background: var(--border); color: var(--muted); }
    .status-error { color: #f85149; font-size: 0.875rem; }
  </style>
</head>
<body>
  <div class="container">
    <h1>PSN Wishlist Price Report</h1>
    <div class="summary">
      <div class="stat"><strong>${summary.total}</strong><span>Tracked</span></div>
      <div class="stat"><strong>${summary.onSale}</strong><span>On sale</span></div>
      <div class="stat"><strong>${summary.failed}</strong><span>Failed</span></div>
      <div class="stat"><strong>€ ${summary.totalSavings.toFixed(2)}</strong><span>Potential savings</span></div>
      <div class="stat"><strong>${summary.biggestDiscount != null ? summary.biggestDiscount + "%" : "—"}</strong><span>Biggest discount</span></div>
    </div>
    <table>
      <thead>
        <tr><th>#</th><th>Game</th><th>Original</th><th>Current</th><th>Discount</th><th>Status</th></tr>
      </thead>
      <tbody>${rows}</tbody>
    </table>
  </div>
</body>
</html>`;
}

function escapeHtml(s) {
  if (s == null) return "";
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function formatDiscountBadge(discount) {
  if (discount == null || Number.isNaN(discount)) return '<span class="badge badge-none">—</span>';
  if (discount <= 0) return '<span class="badge badge-none">0%</span>';
  return `<span class="badge badge-sale">−${discount}%</span>`;
}

function printTextTable(results) {
  const col = (s, w) => String(s).padEnd(w).slice(0, w);
  const w1 = 4;
  const w2 = 36;
  const w3 = 10;
  const w4 = 10;
  const w5 = 8;
  const w6 = 28;
  console.log("\n" + col("#", w1) + col("Game", w2) + col("Original", w3) + col("Current", w4) + col("Discount", w5) + col("Status", w6));
  console.log("-".repeat(w1 + w2 + w3 + w4 + w5 + w6));
  results.forEach((r, i) => {
    const orig = r.originalPrice != null ? "€ " + r.originalPrice.toFixed(2) : "—";
    const cur = r.currentPrice != null ? "€ " + r.currentPrice.toFixed(2) : "—";
    const disc = r.discount != null && !Number.isNaN(r.discount) ? "-" + r.discount + "%" : "—";
    const status = (r.error || "—").slice(0, w6);
    console.log(col(i + 1, w1) + col((r.name || r.url).slice(0, w2), w2) + col(orig, w3) + col(cur, w4) + col(disc, w5) + col(status, w6));
  });
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
