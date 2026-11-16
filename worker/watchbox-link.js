/*
 * The Watch Box — "Add from link" fetcher (Cloudflare Worker)
 * ----------------------------------------------------------
 * A tiny, stateless pass-through. The app (a static page) can't read other
 * websites because browsers block cross-site reads (CORS). This Worker does
 * that read server-side and hands back just the bits we need:
 *
 *     GET  https://<your-worker>.workers.dev/?url=<the shop link>
 *     ->   { brand, model, price, currency, image, sourceUrl }   (any field may be empty)
 *
 * PRIVACY (this is the whole point of the app): it logs nothing, stores
 * nothing, sets no cookies. It reads the one page you asked for and forgets it.
 *
 * ----------------------------------------------------------
 * HOW TO DEPLOY (no coding, ~10 min, free — no credit card):
 *   1. Make a free account at https://dash.cloudflare.com  (or sign in).
 *   2. Left menu -> "Workers & Pages" -> "Create" -> "Create Worker".
 *   3. Give it a name (e.g. "watchbox-link"), click "Deploy".
 *   4. Click "Edit code", delete the sample, paste THIS whole file, "Deploy".
 *   5. Copy the URL it shows (looks like https://watchbox-link.<you>.workers.dev).
 *   6. Send me that URL — I drop it into the app as WORKER_URL and we're live.
 * Free tier is ~100,000 requests/day. We'll use a handful. No card needed.
 * ----------------------------------------------------------
 */

// Only our own pages may call this Worker (keeps randoms from using it as a proxy).
const ALLOWED_ORIGINS = [
  "https://thewatchboxguy.github.io",
  "http://localhost:8787",
  "http://127.0.0.1:8787",
  "http://localhost:5500",
  "http://127.0.0.1:5500",
];

// Pretend to be a normal browser so shops serve us the real page.
const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/125.0 Safari/537.36";

const MAX_BYTES = 1_500_000; // don't slurp huge pages

export default {
  async fetch(request) {
    const origin = request.headers.get("Origin") || "";
    const cors = corsHeaders(origin);

    if (request.method === "OPTIONS") return new Response(null, { headers: cors });
    if (request.method !== "GET") return json({ error: "method_not_allowed" }, 405, cors);

    const target = new URL(request.url).searchParams.get("url");
    const parsed = safeTarget(target);
    if (!parsed) return json({ error: "bad_url" }, 400, cors);

    try {
      const data = await extract(parsed);
      return json(data, 200, cors);
    } catch (err) {
      // Never leak internals; just say we couldn't read it.
      return json({ error: "fetch_failed", sourceUrl: parsed.href }, 200, cors);
    }
  },
};

/* ---------- core ---------- */

async function extract(targetUrl) {
  const result = { brand: "", model: "", price: "", currency: "", image: "", sourceUrl: targetUrl.href };

  // Fetch the product page once (we need it for OG/JSON-LD/title and currency).
  const html = await fetchText(targetUrl.href);
  if (html) {
    const fromHtml = parseHtml(html, targetUrl);
    assign(result, fromHtml);
  }

  // If it's a Shopify-style product URL, its .json gives the cleanest data.
  // That's the bulk of indie / microbrand shops — make it a first-class case.
  if (/\/products\/[^/?#]+/.test(targetUrl.pathname)) {
    const shop = await tryShopifyJson(targetUrl);
    if (shop) assign(result, shop, /* prefer */ true);
  }

  return result;
}

/* ---------- Shopify ---------- */

async function tryShopifyJson(targetUrl) {
  // https://shop.com/products/handle(.anything) -> https://shop.com/products/handle.json
  const m = targetUrl.pathname.match(/\/products\/([^/?#.]+)/);
  if (!m) return null;
  const jsonUrl = `${targetUrl.origin}/products/${m[1]}.json`;

  const body = await fetchText(jsonUrl);
  if (!body) return null;

  let p;
  try {
    p = JSON.parse(body).product;
  } catch {
    return null; // not actually Shopify
  }
  if (!p) return null;

  const variant = Array.isArray(p.variants) ? p.variants.find((v) => v && v.price != null) : null;
  const img =
    (variant && variant.featured_image && variant.featured_image.src) ||
    (Array.isArray(p.images) && p.images[0] && p.images[0].src) ||
    "";

  return {
    brand: cleanText(p.vendor || ""),
    model: cleanText(p.title || ""),
    price: variant ? String(variant.price) : "",
    image: img,
    // Shopify's product .json doesn't carry a currency code — leave it for the
    // HTML pass (og:price:currency / JSON-LD) to supply.
    currency: "",
  };
}

/* ---------- generic HTML (OG tags + JSON-LD + <title>) ---------- */

function parseHtml(html, targetUrl) {
  const out = { brand: "", model: "", price: "", currency: "", image: "" };

  // Open Graph / product meta tags.
  out.model = meta(html, "og:title");
  out.image = absolutize(meta(html, "og:image"), targetUrl);
  out.price = meta(html, "product:price:amount") || meta(html, "og:price:amount");
  out.currency = meta(html, "product:price:currency") || meta(html, "og:price:currency");

  // schema.org Product in JSON-LD is the richest source — let it override.
  const ld = parseJsonLd(html);
  if (ld) {
    if (ld.name) out.model = cleanText(ld.name);
    if (ld.brand) out.brand = ld.brand;
    if (ld.image) out.image = absolutize(ld.image, targetUrl);
    if (ld.price) out.price = ld.price;
    if (ld.currency) out.currency = ld.currency;
  }

  // Last resort for a name: the page <title>.
  if (!out.model) {
    const t = (html.match(/<title[^>]*>([\s\S]*?)<\/title>/i) || [])[1];
    if (t) out.model = cleanText(decodeEntities(t)).split(/\s[|–—-]\s/)[0].trim();
  }

  // Shops often append " - Shop Name" / " | Shop Name" to og:title. Strip it,
  // but ONLY when the tail matches the site name or domain (never a real dash).
  out.model = stripSiteSuffix(out.model, meta(html, "og:site_name"), targetUrl);

  return out;
}

function parseJsonLd(html) {
  const blocks = [...html.matchAll(/<script[^>]+type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi)];
  for (const b of blocks) {
    let node;
    try {
      node = JSON.parse(b[1].trim());
    } catch {
      continue;
    }
    const product = findProduct(node);
    if (product) {
      const offers = Array.isArray(product.offers) ? product.offers[0] : product.offers || {};
      return {
        name: typeof product.name === "string" ? product.name : "",
        brand:
          typeof product.brand === "string"
            ? cleanText(product.brand)
            : product.brand && product.brand.name
            ? cleanText(product.brand.name)
            : "",
        image: firstString(product.image),
        price: offers && offers.price != null ? String(offers.price) : "",
        currency: offers && offers.priceCurrency ? String(offers.priceCurrency) : "",
      };
    }
  }
  return null;
}

// Walk a JSON-LD node (object, array, or @graph) for the first Product.
function findProduct(node) {
  if (!node || typeof node !== "object") return null;
  if (Array.isArray(node)) {
    for (const n of node) {
      const f = findProduct(n);
      if (f) return f;
    }
    return null;
  }
  const type = node["@type"];
  const isProduct = type === "Product" || (Array.isArray(type) && type.includes("Product"));
  if (isProduct) return node;
  if (Array.isArray(node["@graph"])) return findProduct(node["@graph"]);
  return null;
}

/* ---------- helpers ---------- */

function meta(html, key) {
  // Handle both attribute orders: property/name before or after content.
  const esc = key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const a = new RegExp(`<meta[^>]+(?:property|name)=["']${esc}["'][^>]+content=["']([^"']*)["']`, "i");
  const b = new RegExp(`<meta[^>]+content=["']([^"']*)["'][^>]+(?:property|name)=["']${esc}["']`, "i");
  const m = html.match(a) || html.match(b);
  return m ? cleanText(decodeEntities(m[1])) : "";
}

function firstString(v) {
  if (!v) return "";
  if (typeof v === "string") return v;
  if (Array.isArray(v)) return firstString(v[0]);
  if (typeof v === "object" && typeof v.url === "string") return v.url;
  return "";
}

function absolutize(src, base) {
  if (!src) return "";
  try {
    return new URL(src, base).href;
  } catch {
    return src;
  }
}

function assign(target, src, prefer = false) {
  if (!src) return;
  for (const k of ["brand", "model", "price", "currency", "image"]) {
    const v = (src[k] || "").toString().trim();
    if (v && (prefer || !target[k])) target[k] = v;
  }
}

// Remove a trailing " - Shop Name" / " | Shop Name" when the tail matches the
// site's og:site_name or its domain. Never strips a genuine model dash, because
// the tail has to look like the shop itself (e.g. "Baltic Watches" on baltic-watches.com).
function stripSiteSuffix(model, siteName, targetUrl) {
  if (!model) return model;
  model = model.trim();
  const parts = model.split(/\s[|–—-]\s/);
  if (parts.length < 2) return model;
  const tail = parts[parts.length - 1].trim();
  if (!tail) return model;
  const alnum = (s) => (s || "").toLowerCase().replace(/[^a-z0-9]/g, "");
  const host = ((targetUrl && targetUrl.hostname) || "").toLowerCase().replace(/^www\./, "");
  const hostA = alnum(host.split(".").slice(0, -1).join(""));
  const tailA = alnum(tail);
  const siteA = alnum(siteName);
  const matches =
    (siteA && siteA === tailA) ||
    (tailA.length >= 4 && hostA.length >= 4 && (hostA.includes(tailA) || tailA.includes(hostA)));
  if (!matches) return model;
  const esc = tail.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const stripped = model.replace(new RegExp(`\\s*[|\\u2013\\u2014-]\\s*${esc}\\s*$`), "").trim();
  return stripped.length >= 2 ? stripped : model;
}

function cleanText(s) {
  return (s || "").replace(/\s+/g, " ").trim();
}

function decodeEntities(s) {
  return (s || "")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#0?39;|&apos;|&#x27;/gi, "'")
    .replace(/&#8217;|&#x2019;/gi, "’")
    .replace(/&nbsp;/gi, " ");
}

async function fetchText(url) {
  const res = await fetch(url, {
    headers: { "User-Agent": UA, Accept: "text/html,application/json;q=0.9,*/*;q=0.8" },
    redirect: "follow",
    cf: { cacheTtl: 0 },
  });
  if (!res.ok) return "";
  const reader = res.body && res.body.getReader ? res.body.getReader() : null;
  if (!reader) return (await res.text()).slice(0, MAX_BYTES);
  // Read with a byte cap so a giant page can't blow the Worker's limits.
  const chunks = [];
  let total = 0;
  const dec = new TextDecoder();
  let text = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.length;
    text += dec.decode(value, { stream: true });
    if (total >= MAX_BYTES) break;
  }
  return text;
}

/* ---------- security / plumbing ---------- */

// Only allow public http(s) hosts; block localhost + private ranges (SSRF guard).
function safeTarget(raw) {
  if (!raw || !/^https?:\/\//i.test(raw)) return null;
  let u;
  try {
    u = new URL(raw);
  } catch {
    return null;
  }
  const h = u.hostname.toLowerCase();
  if (
    h === "localhost" ||
    h === "0.0.0.0" ||
    h.endsWith(".localhost") ||
    /^127\./.test(h) ||
    /^10\./.test(h) ||
    /^192\.168\./.test(h) ||
    /^169\.254\./.test(h) ||
    /^172\.(1[6-9]|2\d|3[01])\./.test(h) ||
    !h.includes(".")
  ) {
    return null;
  }
  return u;
}

function corsHeaders(origin) {
  const allow = ALLOWED_ORIGINS.includes(origin) ? origin : ALLOWED_ORIGINS[0];
  return {
    "Access-Control-Allow-Origin": allow,
    "Access-Control-Allow-Methods": "GET, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
    "Vary": "Origin",
  };
}

function json(obj, status, cors) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8", ...cors },
  });
}
