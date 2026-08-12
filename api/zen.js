'use strict';

const MAX_BODY_BYTES = 1024 * 1024;
const ALLOWED_ZEN_PATHS = new Set(['/zen/v1/responses', '/zen/v1/chat/completions']);
const ALLOWED_KIMI_OPENAI_PATHS = new Set(['/coding/v1', '/coding/v1/responses', '/coding/v1/chat/completions']);
const ALLOWED_ANTHROPIC_PATHS = new Set(['/v1/messages', '/coding', '/coding/v1/messages']);
const ANTHROPIC_VERSION = '2023-06-01';
const UPSTREAM_TIMEOUT_MS = 285000;

export const config = {maxDuration: 300};
export const runtime = 'nodejs';

function requestOrigin(request) {
  const protocol = String(request.headers['x-forwarded-proto'] || 'https').split(',')[0].trim();
  return `${protocol}://${request.headers.host || ''}`;
}

function responseHeaders(request, contentType = 'application/json; charset=utf-8') {
  const headers = {
    'Content-Type': contentType,
    'Cache-Control': 'no-store',
    'X-Naming-Proxy': '1',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Expose-Headers': 'X-Naming-Proxy'
  };
  const origin = request.headers.origin;
  if (origin === 'null' || origin === requestOrigin(request)) headers['Access-Control-Allow-Origin'] = origin;
  return headers;
}

function isAllowedOrigin(request) {
  const origin = request.headers.origin;
  return !origin || origin === 'null' || origin === requestOrigin(request);
}

function sendJson(request, response, status, body) {
  response.writeHead(status, responseHeaders(request));
  response.end(JSON.stringify(body));
}

function readJson(request) {
  if (request.body && typeof request.body === 'object') return Promise.resolve(request.body);
  return new Promise((resolve, reject) => {
    let size = 0;
    let raw = '';
    request.setEncoding('utf8');
    request.on('data', chunk => {
      size += Buffer.byteLength(chunk);
      if (size > MAX_BODY_BYTES) {
        reject(new Error('请求内容过大'));
        request.destroy();
        return;
      }
      raw += chunk;
    });
    request.on('end', () => {
      try {
        resolve(JSON.parse(raw || '{}'));
      } catch (error) {
        reject(new Error('请求体不是有效 JSON'));
      }
    });
    request.on('error', reject);
  });
}

function validateTarget(provider, value) {
  let target;
  try {
    target = new URL(value);
  } catch (error) {
    throw new Error(`${provider === 'anthropic' ? 'Anthropic' : 'OpenAI API'} 接口地址无效`);
  }
  const isAnthropic = provider === 'anthropic';
  const normalizedPath = target.pathname.replace(/\/+$/, '') || '/';
  const valid = isAnthropic
    ? target.protocol === 'https:' && (!target.port || target.port === '443') && ((target.hostname === 'api.anthropic.com' && normalizedPath === '/v1/messages') || (target.hostname === 'api.kimi.com' && ALLOWED_ANTHROPIC_PATHS.has(normalizedPath)))
    : target.protocol === 'https:' && (!target.port || target.port === '443') && ((target.hostname === 'opencode.ai' && ALLOWED_ZEN_PATHS.has(normalizedPath)) || (target.hostname === 'api.kimi.com' && ALLOWED_KIMI_OPENAI_PATHS.has(normalizedPath)));
  if (!valid || target.username || target.password || target.search || target.hash) {
    throw new Error(isAnthropic ? 'Vercel 代理只允许转发 Anthropic 兼容 Messages 接口' : 'Vercel 代理只允许转发 OpenAI API 兼容接口');
  }
  return target;
}

function normalizeTarget(provider, format, target) {
  const normalizedPath = target.pathname.replace(/\/+$/, '') || '/';
  if (provider === 'anthropic' && target.hostname === 'api.kimi.com' && normalizedPath === '/coding') return new URL('/coding/v1/messages', target.origin);
  if (provider === 'zen' && target.hostname === 'api.kimi.com' && ALLOWED_KIMI_OPENAI_PATHS.has(normalizedPath)) {
    return new URL(format === 'responses' ? '/coding/v1/responses' : '/coding/v1/chat/completions', target.origin);
  }
  if (normalizedPath !== target.pathname) return new URL(normalizedPath, target.origin);
  return target;
}

export default async function handler(request, response) {
  if (!isAllowedOrigin(request)) {
    sendJson(request, response, 403, {error: {message: '跨域来源不被允许'}});
    return;
  }
  if (request.method === 'OPTIONS') {
    response.writeHead(204, responseHeaders(request));
    response.end();
    return;
  }
  if (request.method !== 'POST') {
    sendJson(request, response, 405, {error: {message: '只支持 POST 请求'}});
    return;
  }

  let body;
  try {
    body = await readJson(request);
  } catch (error) {
    sendJson(request, response, 400, {error: {message: error.message}});
    return;
  }
  if (typeof body.apiKey !== 'string' || !body.apiKey.trim()) {
    sendJson(request, response, 400, {error: {message: '缺少 API Key'}});
    return;
  }

  const provider = body.provider === 'anthropic' ? 'anthropic' : 'zen';
  const format = provider === 'anthropic' ? 'anthropic.messages' : (body.format === 'responses' ? 'responses' : 'chat.completions');
  if (!body.payload || typeof body.payload !== 'object' || Array.isArray(body.payload)) {
    sendJson(request, response, 400, {error: {message: '缺少有效的 AI 请求参数'}});
    return;
  }

  let target;
  try {
    target = normalizeTarget(provider, format, validateTarget(provider, body.baseUrl));
  } catch (error) {
    sendJson(request, response, 400, {error: {message: error.message}});
    return;
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), UPSTREAM_TIMEOUT_MS);
  try {
    const upstream = await fetch(target, {
      method: 'POST',
      signal: controller.signal,
      headers: {
        'Content-Type': 'application/json',
        ...(provider === 'anthropic'
          ? {'x-api-key': body.apiKey.trim(), 'anthropic-version': ANTHROPIC_VERSION}
          : {'Authorization': `Bearer ${body.apiKey.trim()}`})
      },
      body: JSON.stringify(body.payload)
    });
    const text = await upstream.text();
    response.writeHead(upstream.status, {
      ...responseHeaders(request, upstream.headers.get('content-type') || 'application/json; charset=utf-8')
    });
    response.end(text);
  } catch (error) {
    const service = provider === 'anthropic' ? 'Anthropic' : 'OpenAI API';
    const timeoutError = error.name === 'AbortError';
    const message = timeoutError ? `${service} 请求超时` : `Vercel 代理无法连接 ${service}`;
    sendJson(request, response, timeoutError ? 504 : 502, {
      error: {
        message,
        code: timeoutError ? 'UPSTREAM_TIMEOUT' : (error.code || error.name || 'UPSTREAM_FETCH_FAILED'),
        detail: timeoutError ? '上游接口在 285 秒内没有返回' : String(error.message || '').slice(0, 240)
      }
    });
  } finally {
    clearTimeout(timeout);
  }
}
