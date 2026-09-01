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
