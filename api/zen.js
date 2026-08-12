'use strict';

const MAX_BODY_BYTES = 1024 * 1024;
const ALLOWED_ZEN_PATHS = new Set(['/zen/v1/responses', '/zen/v1/chat/completions']);
const ALLOWED_ANTHROPIC_PATHS = new Set(['/v1/messages']);
const ANTHROPIC_VERSION = '2023-06-01';

export const maxDuration = 30;
export const runtime = 'nodejs';

function responseHeaders(request, contentType = 'application/json; charset=utf-8') {
  const headers = {
    'Content-Type': contentType,
    'Cache-Control': 'no-store',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type'
  };
  const origin = request.headers.get('origin');
  const requestOrigin = new URL(request.url).origin;
  if (origin === 'null' || origin === requestOrigin) headers['Access-Control-Allow-Origin'] = origin;
  return headers;
}

function jsonResponse(request, status, body) {
  return new Response(JSON.stringify(body), {
    status,
    headers: responseHeaders(request)
  });
}

function validateTarget(provider, value) {
  let target;
  try {
    target = new URL(value);
  } catch (error) {
    throw new Error(`${provider === 'anthropic' ? 'Anthropic' : 'Zen'} 接口地址无效`);
  }
  const isAnthropic = provider === 'anthropic';
  const valid = isAnthropic
    ? target.protocol === 'https:' && target.hostname === 'api.anthropic.com' && (!target.port || target.port === '443') && ALLOWED_ANTHROPIC_PATHS.has(target.pathname)
    : target.protocol === 'https:' && target.hostname === 'opencode.ai' && (!target.port || target.port === '443') && ALLOWED_ZEN_PATHS.has(target.pathname);
  if (!valid || target.username || target.password || target.search || target.hash) {
    throw new Error(isAnthropic ? 'Vercel 代理只允许转发 Anthropic 官方 Messages 接口' : 'Vercel 代理只允许转发 OpenCode Zen 官方接口');
  }
  return target;
}

async function readJson(request) {
  const raw = await request.text();
  if (new TextEncoder().encode(raw).byteLength > MAX_BODY_BYTES) throw new Error('请求内容过大');
  try {
    return JSON.parse(raw || '{}');
  } catch (error) {
    throw new Error('请求体不是有效 JSON');
  }
}

function isAllowedOrigin(request) {
  const origin = request.headers.get('origin');
  if (!origin || origin === 'null') return true;
  return origin === new URL(request.url).origin;
}

export function OPTIONS(request) {
  if (!isAllowedOrigin(request)) return jsonResponse(request, 403, {error: {message: '跨域来源不被允许'}});
  return new Response(null, {status: 204, headers: responseHeaders(request)});
}

export function GET(request) {
  return jsonResponse(request, 405, {error: {message: '只支持 POST 请求'}});
}

export async function POST(request) {
  if (!isAllowedOrigin(request)) {
    return jsonResponse(request, 403, {error: {message: '跨域来源不被允许'}});
  }

  let body;
  try {
    body = await readJson(request);
  } catch (error) {
    return jsonResponse(request, 400, {error: {message: error.message}});
  }

  if (typeof body.apiKey !== 'string' || !body.apiKey.trim()) {
    return jsonResponse(request, 400, {error: {message: '缺少 API Key'}});
  }
  const provider = body.provider === 'anthropic' ? 'anthropic' : 'zen';
  if (!body.payload || typeof body.payload !== 'object' || Array.isArray(body.payload)) {
    return jsonResponse(request, 400, {error: {message: '缺少有效的 AI 请求参数'}});
  }

  let target;
  try {
    target = validateTarget(provider, body.baseUrl);
  } catch (error) {
    return jsonResponse(request, 400, {error: {message: error.message}});
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 30000);
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
    return new Response(text, {
      status: upstream.status,
      headers: responseHeaders(request, upstream.headers.get('content-type') || 'application/json; charset=utf-8')
    });
  } catch (error) {
    const service = provider === 'anthropic' ? 'Anthropic' : 'Zen';
    const message = error.name === 'AbortError' ? `${service} 请求超时` : `Vercel 代理无法连接 ${service}`;
    return jsonResponse(request, 502, {error: {message}});
  } finally {
    clearTimeout(timeout);
  }
}
