/**
 * Vercel API Route: /api/kaitorix
 * GET /api/kaitorix?jan=4902370536058
 *
 * フォルダ構成 (必須):
 *   project/
 *   ├─ step5_ebay_api_test.html
 *   ├─ vercel.json
 *   └─ api/
 *      └─ kaitorix.js  ← このファイル
 *
 * デプロイ:
 *   vercel --prod
 *
 * ローカル確認:
 *   vercel dev → http://localhost:3000/api/kaitorix?jan=4902370536058
 *   ※ HTMLを直接ブラウザで開いても /api/kaitorix は存在しないため動かない
 */

'use strict';

// ── インメモリキャッシュ (5分) ────────────────────────────────────────────
const CACHE     = new Map();
const CACHE_TTL = 5 * 60 * 1000;

// ── JAN バリデーション ────────────────────────────────────────────────────
const JAN_RE = /^(\d{8}|\d{13}|\d{14})$/;

// ────────────────────────────────────────────────────────────────────────────
module.exports = async function handler(req, res) {

  // CORS
  res.setHeader('Access-Control-Allow-Origin',  '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'GET')    return res.status(405).json({ ok: false, error: 'method_not_allowed' });

  const jan = String(req.query.jan || '').trim();

  // JAN バリデーション
  if (!jan || !JAN_RE.test(jan)) {
    return res.status(400).json({
      ok: false, jan,
      error: 'invalid_jan',
      message: 'jan は 8桁・13桁・14桁の数字で指定してください',
    });
  }

  // キャッシュヒット
  const cached = CACHE.get(jan);
  if (cached && (Date.now() - cached.ts) < CACHE_TTL) {
    res.setHeader('X-Cache', 'HIT');
    return res.status(200).json(cached.data);
  }

  const sourceUrl = `https://kaitorix.app/dp/${jan}?from=search`;
  const debug     = { step: 'start', fetchStatus: null, htmlLength: 0, pricesFound: [] };

  // ── 必ずJSONを返す大枠 try/catch ────────────────────────────────────────
  try {

    // ── fetch (10秒タイムアウト) ──────────────────────────────────────────
    debug.step = 'fetching';
    let html = '';

    try {
      const controller = new AbortController();
      const timer      = setTimeout(() => controller.abort(), 10000);

      const fetchRes = await fetch(sourceUrl, {
        signal: controller.signal,
        headers: {
          'User-Agent':      'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
          'Accept':          'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
          'Accept-Language': 'ja,en-US;q=0.8,en;q=0.6',
          'Cache-Control':   'no-cache',
        },
      });
      clearTimeout(timer);

      debug.fetchStatus = fetchRes.status;
      debug.step        = 'fetch_ok';

      if (fetchRes.status === 404) {
        return res.status(200).json({
          ok: false, jan, sourceUrl,
          error:   'product_not_found',
          message: '買取Xに該当JANの商品が見つかりませんでした (404)',
          debug,
        });
      }

      if (!fetchRes.ok) {
        return res.status(200).json({
          ok: false, jan, sourceUrl,
          error:   'fetch_http_error',
          message: `買取Xサーバーエラー HTTP ${fetchRes.status}`,
          debug,
        });
      }

      html             = await fetchRes.text();
      debug.htmlLength = html.length;
      debug.step       = 'html_received';

    } catch (fetchErr) {
      const isTimeout = fetchErr.name === 'AbortError';
      return res.status(200).json({
        ok: false, jan, sourceUrl,
        error:   isTimeout ? 'timeout' : 'fetch_failed',
        message: isTimeout
          ? '買取Xへのアクセスがタイムアウトしました (10秒)'
          : `買取Xへのアクセス失敗: ${fetchErr.message}`,
        debug,
      });
    }

    // ── 価格抽出 ─────────────────────────────────────────────────────────
    debug.step = 'parsing';

    const allPrices = extractAllPrices(html);
    debug.pricesFound = allPrices.slice(0, 20);

    if (allPrices.length === 0) {
      return res.status(200).json({
        ok: false, jan, sourceUrl,
        error:   'price_not_found',
        message: 'ページ内に価格表記が見つかりませんでした',
        debug,
      });
    }

    const maxPrice = Math.max(...allPrices);

    if (maxPrice <= 0) {
      return res.status(200).json({
        ok: false, jan, sourceUrl,
        error:   'price_zero',
        message: '取得できた価格が0円でした',
        debug,
      });
    }

    // ── 追加情報 ─────────────────────────────────────────────────────────
    debug.step        = 'extracting_meta';
    const productName = extractProductName(html);
    const shopCount   = extractShopCount(html);
    const topShopName = extractTopShopName(html, maxPrice);

    debug.step = 'done';

    const result = {
      ok: true,
      jan,
      maxPrice,
      productName:  productName || null,
      shopCount:    shopCount   || null,
      topShopName:  topShopName || null,
      sourceUrl,
      checkedAt: new Date().toISOString(),
      debug,
    };

    // キャッシュ保存
    CACHE.set(jan, { ts: Date.now(), data: result });
    if (CACHE.size > 200) {
      [...CACHE.keys()].slice(0, 50).forEach(k => CACHE.delete(k));
    }

    res.setHeader('Cache-Control', 'public, max-age=300, stale-while-revalidate=600');
    return res.status(200).json(result);

  } catch (unexpectedErr) {
    // 予期しないエラー：絶対にここで止める（画面が真っ白にならないように）
    return res.status(200).json({
      ok: false, jan, sourceUrl,
      error:   'unexpected_error',
      message: `予期しないエラー: ${unexpectedErr.message}`,
      debug: { ...debug, unexpectedError: unexpectedErr.message },
    });
  }
};

// ────────────────────────────────────────────────────────────────────────────
// 価格抽出：¥5,900 / ￥5900 / 5,900円 を全部拾い 100〜300,000 でフィルタ
// ────────────────────────────────────────────────────────────────────────────
function extractAllPrices(html) {
  const found = new Set();

  // パターン1: ¥5,900 / ¥5900
  for (const m of html.matchAll(/[¥￥]\s*([\d,]+)/g)) {
    const n = toInt(m[1]);
    if (n >= 100 && n <= 300_000) found.add(n);
  }

  // パターン2: 5,900円
  for (const m of html.matchAll(/([\d,]{3,9})円/g)) {
    const n = toInt(m[1]);
    if (n >= 100 && n <= 300_000) found.add(n);
  }

  // パターン3: "price": 5900
  for (const m of html.matchAll(/"price"\s*:\s*"?([\d,]+)"?/g)) {
    const n = toInt(m[1]);
    if (n >= 100 && n <= 300_000) found.add(n);
  }

  return [...found].sort((a, b) => b - a); // 降順
}

// ────────────────────────────────────────────────────────────────────────────
// 商品名
// ────────────────────────────────────────────────────────────────────────────
function extractProductName(html) {
  const h1 = html.match(/<h1[^>]*>([\s\S]*?)<\/h1>/i);
  if (h1) {
    const t = stripTags(h1[1]).trim();
    if (t.length >= 3 && t.length <= 200) return t;
  }
  const og = html.match(/<meta[^>]+property="og:title"[^>]+content="([^"]{3,200})"/i)
          || html.match(/<meta[^>]+content="([^"]{3,200})"[^>]+property="og:title"/i);
  if (og) return og[1].trim();
  const title = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  if (title) {
    return stripTags(title[1]).split(/[|\-–—]/).map(s => s.trim()).find(s => s.length >= 5) || null;
  }
  return null;
}

// ────────────────────────────────────────────────────────────────────────────
// 掲載店舗数
// ────────────────────────────────────────────────────────────────────────────
function extractShopCount(html) {
  const m = html.match(/掲載店舗数[\s\S]{0,100}?(\d+)\s*店舗/)
         || html.match(/(\d+)\s*店舗/);
  return m ? parseInt(m[1], 10) : null;
}

// ────────────────────────────────────────────────────────────────────────────
// 最高値店舗名
// ────────────────────────────────────────────────────────────────────────────
function extractTopShopName(html, maxPrice) {
  const priceStr = maxPrice.toLocaleString('ja-JP');
  const escaped  = priceStr.replace(/,/g, '[,，]?');
  const re = new RegExp(
    `([\\u3040-\\u9FFF\\uFF00-\\uFFEFa-zA-Z0-9（）()]{2,20})` +
    `[\\s\\S]{0,80}?[¥￥]\\s*${escaped}`
  );
  const m = html.match(re);
  if (m && isValidShopName(m[1].trim())) return m[1].trim();
  const jm = html.match(/"(?:shopName|storeName|seller)"\s*:\s*"([^"]{2,30})"/i);
  if (jm && isValidShopName(jm[1])) return jm[1].trim();
  return null;
}

// ────────────────────────────────────────────────────────────────────────────
// ユーティリティ
// ────────────────────────────────────────────────────────────────────────────
function toInt(str) {
  return parseInt(String(str).replace(/[,，\s]/g, ''), 10) || 0;
}

function stripTags(html) {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<[^>]+>/g, '')
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&nbsp;/g, ' ')
    .replace(/\s+/g, ' ').trim();
}

function isValidShopName(s) {
  if (!s || s.length < 2 || s.length > 30) return false;
  if (/最高|買取|価格|店舗|ランキング|一覧|比較|送料|評価|コメント/.test(s)) return false;
  if (/^\d+$/.test(s)) return false;
  return true;
}
