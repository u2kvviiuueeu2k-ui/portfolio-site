// Cloudflare Workers エントリポイント。
// api/*.js（Vercel Serverless Function形式）を書き換えずにそのまま動かすため、
// req/res 互換のアダプタを噛ませている。
import chatHandler from './api/chat.js';
import faqHandler from './api/faq.js';
import reportHandler from './api/report.js';
import diagnoseHandler from './api/diagnose.js';

const ROUTES = {
  '/api/chat': chatHandler,
  '/api/faq': faqHandler,
  '/api/report': reportHandler,
  '/api/diagnose': diagnoseHandler,
};

// ==== アクセス制御 ====
// 公開デモのため、外部サイトからの直接利用と過剰な連打を防ぐ。
const ALLOWED_ORIGIN_HOSTS = [
  'portfolio-site.webprod-alnair.workers.dev',
];

const DAILY_LIMIT = 5;

function isAllowedOrigin(request) {
  const origin = request.headers.get('origin');
  const referer = request.headers.get('referer');
  const source = origin || referer;

  // ブラウザ以外（curl等）からの直接呼び出しは Origin も Referer も付かない
  if (!source) return false;

  try {
    return ALLOWED_ORIGIN_HOSTS.includes(new URL(source).hostname);
  } catch {
    return false;
  }
}

function clientKey(request) {
  const ip =
    request.headers.get('cf-connecting-ip') ||
    request.headers.get('x-forwarded-for') ||
    'unknown';
  const day = new Date().toISOString().slice(0, 10);
  return `demo:${day}:${ip}`;
}

// 上限を超えていれば 429 を返す。超えていなければカウントを進めて null を返す。
async function enforceDailyLimit(request, env) {
  if (!env.RATE_LIMIT) return null; // KV未設定時は素通し（ローカル開発用）

  const key = clientKey(request);
  const current = parseInt((await env.RATE_LIMIT.get(key)) || '0', 10);

  if (current >= DAILY_LIMIT) {
    return jsonResponse(
      {
        error: `デモの1日あたりの利用上限（${DAILY_LIMIT}回）に達しました。導入のご相談は運営までお問い合わせください。`,
        limit: DAILY_LIMIT,
      },
      429
    );
  }

  // 25時間で自動失効（日付が変わればキー自体も変わる）
  await env.RATE_LIMIT.put(key, String(current + 1), { expirationTtl: 60 * 60 * 25 });
  return null;
}

function jsonResponse(data, status) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

async function toVercelReq(request) {
  const url = new URL(request.url);
  let body;

  if (request.method !== 'GET' && request.method !== 'HEAD') {
    const contentType = request.headers.get('content-type') || '';
    if (contentType.includes('application/json')) {
      try {
        body = await request.json();
      } catch {
        body = {};
      }
    } else {
      try {
        body = await request.text();
      } catch {
        body = undefined;
      }
    }
  }

  return {
    method: request.method,
    headers: Object.fromEntries(request.headers),
    query: Object.fromEntries(url.searchParams),
    body,
    url: url.pathname + url.search,
  };
}

function createRes() {
  let settle;
  const done = new Promise((resolve) => {
    settle = resolve;
  });

  const state = { responded: false, status: 200 };
  const headers = new Headers();

  const finish = (bodyInit) => {
    state.responded = true;
    settle(new Response(bodyInit ?? null, { status: state.status, headers }));
  };

  const res = {
    setHeader(key, value) {
      headers.set(key, String(value));
      return res;
    },
    getHeader(key) {
      return headers.get(key);
    },
    status(code) {
      state.status = code;
      return res;
    },
    json(obj) {
      if (!headers.has('content-type')) {
        headers.set('Content-Type', 'application/json');
      }
      finish(JSON.stringify(obj));
      return res;
    },
    send(bodyInit) {
      finish(bodyInit);
      return res;
    },
    end(bodyInit) {
      finish(bodyInit);
      return res;
    },
  };

  return { res, done, state };
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const handler = ROUTES[url.pathname];

    if (!handler) {
      return env.ASSETS.fetch(request);
    }

    // api/*.js は process.env.CLAUDE_API_KEY を参照するため、
    // Workerのsecret/varsをprocess.envへブリッジする。
    if (typeof globalThis.process === 'undefined') {
      globalThis.process = { env: {} };
    } else if (!globalThis.process.env) {
      globalThis.process.env = {};
    }
    for (const [key, value] of Object.entries(env)) {
      if (typeof value === 'string') {
        globalThis.process.env[key] = value;
      }
    }


    // OPTIONS（CORSプリフライト）は制限対象外
    if (request.method !== 'OPTIONS') {
      if (!isAllowedOrigin(request)) {
        return jsonResponse({ error: 'このAPIはデモサイトからのみ利用できます。' }, 403);
      }
      const limited = await enforceDailyLimit(request, env);
      if (limited) return limited;
    }

    const req = await toVercelReq(request);
    const { res, done, state } = createRes();

    try {
      await handler(req, res);
    } catch (err) {
      console.error('Handler threw:', err);
      return jsonResponse({ error: 'Internal server error' }, 500);
    }

    if (!state.responded) {
      console.error('Handler finished without sending a response:', url.pathname);
      return jsonResponse({ error: 'Internal server error' }, 500);
    }

    return done;
  },
};
