// api/diagnose.js  ── AI Web集客診断ツール用サーバーレス関数
// faq.js / report.js と同パターン。CLAUDE_API_KEY は Vercel 環境変数から取得。
// 依存パッケージなし（素のfetch・正規表現のみ）。

const FETCH_TIMEOUT_MS = 8000;   // 対象サイト取得のタイムアウト
const MAX_BYTES = 150 * 1024;    // 対象サイトHTMLの読み取り上限（先頭〜150KB）
const EXCERPT_CHARS = 4000;      // Claudeに渡すHTML冒頭抜粋の文字数
const USER_AGENT = 'Mozilla/5.0 (compatible; AlnairDiagnoseBot/1.0; +https://alnair-hp.vercel.app/)';

export default async function handler(req, res) {
  // CORS headers
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const apiKey = process.env.CLAUDE_API_KEY;
  if (!apiKey) {
    return res.status(500).json({ error: 'API key not configured' });
  }

  const { url } = req.body || {};

  if (!url || typeof url !== 'string') {
    return res.status(400).json({ error: 'url is required' });
  }

  let parsedUrl;
  try {
    parsedUrl = new URL(url.trim());
  } catch (e) {
    return res.status(400).json({ error: '不正なURLです' });
  }

  if (parsedUrl.protocol !== 'http:' && parsedUrl.protocol !== 'https:') {
    return res.status(400).json({ error: 'http/httpsのURLのみ対応しています' });
  }

  // 簡易SSRFガード：ローカル・プライベートアドレスへの診断は拒否
  const hostname = parsedUrl.hostname.toLowerCase();
  const isPrivateHost =
    hostname === 'localhost' ||
    hostname === '127.0.0.1' ||
    hostname === '0.0.0.0' ||
    hostname === '::1' ||
    hostname.endsWith('.local') ||
    /^10\.|^192\.168\.|^172\.(1[6-9]|2\d|3[0-1])\.|^169\.254\./.test(hostname);

  if (isPrivateHost) {
    return res.status(400).json({ error: 'このURLは診断できません' });
  }

  const fetchResult = await fetchTargetSite(parsedUrl.toString());
  const signals = buildSignals(fetchResult, parsedUrl.toString());
  const excerpt = fetchResult.fetched ? fetchResult.html.slice(0, EXCERPT_CHARS) : null;

  const systemPrompt = 'あなたは中小事業者向けのWeb集客診断士です。辛口だが建設的にアドバイスしてください。' +
    'ユーザーから渡されるサイトのシグナル情報（と可能であればHTML冒頭抜粋）をもとに診断し、' +
    '必ず指定されたJSON形式のみを出力してください。説明文・前置き・マークダウンのコードブロックなど、' +
    'JSON以外のテキストは一切含めないでください。';

  const schemaInstruction = `以下のJSON形式で、日本語の値を入れて出力してください（これ以外は一切出力禁止。{ から始まり } で終わる有効なJSONのみ）：

{
  "overall_score": 0から100の整数,
  "one_line": "総評を一文で（辛口・具体的）",
  "categories": [
    { "key": "design", "label": "デザイン・第一印象", "score": 0-100の整数, "findings": ["..."], "suggestions": ["..."] },
    { "key": "seo", "label": "SEO・検索対策", "score": 0-100の整数, "findings": ["..."], "suggestions": ["..."] },
    { "key": "mobile", "label": "モバイル対応", "score": 0-100の整数, "findings": ["..."], "suggestions": ["..."] },
    { "key": "cta", "label": "集客導線・CTA", "score": 0-100の整数, "findings": ["..."], "suggestions": ["..."] },
    { "key": "trust", "label": "信頼性・安全性", "score": 0-100の整数, "findings": ["..."], "suggestions": ["..."] }
  ],
  "priority_actions": [
    { "title": "...", "impact": "高|中|低", "effort": "小|中|大", "why": "..." }
  ]
}

findings と suggestions はそれぞれ2〜3個の配列、各項目は50字以内で簡潔に書いてください。priority_actions は最も重要な3件のみにしてください。文字列の値の中では改行やダブルクォート(")を使わず、有効なJSONを壊さないよう注意してください。`;

  let userContent = schemaInstruction + '\n\n【診断対象】\nURL: ' + parsedUrl.toString() +
    '\n取得成否: ' + (fetchResult.fetched ? '成功' : '失敗（' + fetchResult.reason + '）') +
    '\n\nシグナル情報:\n' + JSON.stringify(signals, null, 2);

  if (fetchResult.fetched) {
    userContent += '\n\nHTML冒頭抜粋（生データ、参考情報）:\n' + excerpt;
  } else {
    userContent += '\n\n(サイトを取得できなかったため、この業種・URLから一般的に推測できる範囲で、' +
      '中小事業者サイトによくある課題を辛口だが建設的に診断・提案してください。' +
      'one_line にはサイトを直接確認できなかった旨を一言含めてください。)';
  }

  try {
    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 4096,
        system: systemPrompt,
        messages: [{ role: 'user', content: userContent }],
      }),
    });

    if (!response.ok) {
      const errText = await response.text();
      console.error('Anthropic API error:', response.status, errText);
      return res.status(response.status).json({ error: `API error: ${response.status}` });
    }

    const data = await response.json();
    const rawText = data.content?.[0]?.text || '';

    const firstBrace = rawText.indexOf('{');
    const lastBrace = rawText.lastIndexOf('}');

    if (firstBrace === -1 || lastBrace === -1 || lastBrace <= firstBrace) {
      console.error('Diagnose parse error: no JSON braces found');
      return res.status(502).json({ error: '診断結果の生成に失敗しました' });
    }

    const jsonStr = rawText.slice(firstBrace, lastBrace + 1);
    let report;
    try {
      report = JSON.parse(jsonStr);
    } catch (e) {
      console.error('Diagnose JSON parse error:', e.message);
      return res.status(502).json({ error: '診断結果の生成に失敗しました' });
    }

    return res.status(200).json(report);

  } catch (err) {
    console.error('Fetch error:', err);
    return res.status(500).json({ error: 'Internal server error' });
  }
}

// ===== 対象サイト取得（タイムアウト・バイト上限つき） =====
async function fetchTargetSite(targetUrl) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);

  let response;
  try {
    response = await fetch(targetUrl, {
      signal: controller.signal,
      redirect: 'follow',
      headers: { 'User-Agent': USER_AGENT },
    });
  } catch (err) {
    clearTimeout(timeout);
    return { fetched: false, reason: err.name === 'AbortError' ? 'timeout' : 'network_error' };
  }
  clearTimeout(timeout);

  if (!response.ok) {
    return { fetched: false, reason: `http_${response.status}` };
  }

  const contentType = (response.headers.get('content-type') || '').toLowerCase();
  if (contentType && !contentType.includes('html') && !contentType.includes('xhtml')) {
    return { fetched: false, reason: 'non_html_content_type' };
  }

  let received = 0;
  let truncated = false;
  const chunks = [];

  try {
    if (response.body && typeof response.body.getReader === 'function') {
      const reader = response.body.getReader();
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        if (received + value.length > MAX_BYTES) {
          chunks.push(value.slice(0, MAX_BYTES - received));
          received = MAX_BYTES;
          truncated = true;
          try { await reader.cancel(); } catch (_) { /* noop */ }
          break;
        }
        chunks.push(value);
        received += value.length;
      }
    } else {
      const buf = new Uint8Array(await response.arrayBuffer());
      truncated = buf.length > MAX_BYTES;
      chunks.push(truncated ? buf.slice(0, MAX_BYTES) : buf);
      received = Math.min(buf.length, MAX_BYTES);
    }
  } catch (err) {
    return { fetched: false, reason: 'body_read_error' };
  }

  const merged = new Uint8Array(received);
  let offset = 0;
  for (const c of chunks) {
    merged.set(c, offset);
    offset += c.length;
  }

  const html = new TextDecoder('utf-8', { fatal: false }).decode(merged);

  if (!html || html.trim().length === 0) {
    return { fetched: false, reason: 'empty_body' };
  }

  if (!/<html[\s>]|<!doctype html/i.test(html) && !contentType.includes('html')) {
    return { fetched: false, reason: 'not_html' };
  }

  return {
    fetched: true,
    html,
    finalUrl: response.url || targetUrl,
    statusCode: response.status,
    approxBytes: received,
    truncated,
  };
}

// ===== 軽量シグナル抽出（正規表現） =====
function buildSignals(fetchResult, requestedUrl) {
  if (!fetchResult.fetched) {
    return { fetched: false, reason: fetchResult.reason, requestedUrl };
  }

  const html = fetchResult.html;

  return {
    fetched: true,
    finalUrl: fetchResult.finalUrl,
    isHttps: /^https:\/\//i.test(fetchResult.finalUrl || requestedUrl),
    title: extractTitle(html),
    metaDescription: extractMetaContent(html, 'description'),
    hasViewport: hasMetaViewport(html),
    h1Count: countTag(html, 'h1'),
    h2Count: countTag(html, 'h2'),
    images: imgStats(html),
    hasTelLink: /href\s*=\s*["']tel:/i.test(html),
    hasMailtoLink: /href\s*=\s*["']mailto:/i.test(html),
    hasContactForm: /<form\b/i.test(html),
    hasOgp: /<meta\b[^>]*property\s*=\s*["']og:[^"']+["']/i.test(html),
    hasStructuredData: /<script\b[^>]*type\s*=\s*["']application\/ld\+json["'][^>]*>/i.test(html),
    approxHtmlBytes: fetchResult.approxBytes,
    truncated: fetchResult.truncated,
  };
}

function extractTitle(html) {
  const m = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  return m ? decodeEntities(m[1].trim()).slice(0, 200) : null;
}

function extractMetaContent(html, nameOrProperty) {
  const metaTags = html.match(/<meta\b[^>]*>/gi) || [];
  for (const tag of metaTags) {
    const nameMatch = tag.match(/\b(?:name|property)\s*=\s*["']([^"']+)["']/i);
    if (nameMatch && nameMatch[1].toLowerCase() === nameOrProperty.toLowerCase()) {
      const contentMatch = tag.match(/\bcontent\s*=\s*["']([^"']*)["']/i);
      if (contentMatch) return decodeEntities(contentMatch[1].trim()).slice(0, 300);
    }
  }
  return null;
}

function hasMetaViewport(html) {
  return /<meta\b[^>]*name\s*=\s*["']viewport["'][^>]*>/i.test(html);
}

function countTag(html, tagName) {
  const re = new RegExp(`<${tagName}\\b`, 'gi');
  return (html.match(re) || []).length;
}

function imgStats(html) {
  const imgs = html.match(/<img\b[^>]*>/gi) || [];
  let withAlt = 0;
  for (const tag of imgs) {
    const altMatch = tag.match(/\balt\s*=\s*["']([^"']*)["']/i);
    if (altMatch && altMatch[1].trim().length > 0) withAlt++;
  }
  return { count: imgs.length, withAlt };
}

function decodeEntities(str) {
  return str
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, ' ');
}
