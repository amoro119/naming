'use strict';

const MAX_BODY_BYTES = 1024 * 1024;
const ALLOWED_ZEN_PATHS = new Set(['/zen/v1/responses', '/zen/v1/chat/completions']);

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

function validateZenTarget(value) {
  let target;
  try {
    target = new URL(value);
  } catch (error) {
    throw new Error('Zen 接口地址无效');
  }
  if (
    target.protocol !== 'https:' ||
    target.hostname !== 'opencode.ai' ||
    (target.port && target.port !== '443') ||
    target.username ||
    target.password ||
    target.search ||
    target.hash ||
    !ALLOWED_ZEN_PATHS.has(target.pathname)
  ) {
    throw new Error('Vercel 代理只允许转发 OpenCode Zen 官方接口');
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
  if (!body.payload || typeof body.payload !== 'object' || Array.isArray(body.payload)) {
    return jsonResponse(request, 400, {error: {message: '缺少有效的 AI 请求参数'}});
  }

  let target;
  try {
    target = validateZenTarget(body.baseUrl);
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
        'Authorization': `Bearer ${body.apiKey.trim()}`
      },
      body: JSON.stringify(body.payload)
    });
    const text = await upstream.text();
    return new Response(text, {
      status: upstream.status,
      headers: responseHeaders(request, upstream.headers.get('content-type') || 'application/json; charset=utf-8')
    });
  } catch (error) {
    const message = error.name === 'AbortError' ? 'Zen 请求超时' : 'Vercel 代理无法连接 Zen';
    return jsonResponse(request, 502, {error: {message}});
  } finally {
    clearTimeout(timeout);
  }
}
