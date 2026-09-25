const crypto = require('node:crypto');

const DEFAULT_USER_AGENT = 'clash-verge/v2.4.3';

// ——— 分叉点 1：访问令牌（fail-closed）———
// 本代理接受任意 url，等同开放 GET 代理。必须在 Vercel 环境变量中配置 PROXY_TOKEN，
// 客户端请求需携带 ?token=<PROXY_TOKEN>。未配置时直接拒绝服务，避免「以为安全实则开放」。
const PROXY_TOKEN = process.env.PROXY_TOKEN || '';

// ——— 分叉点 2：上游请求超时（毫秒）———
// 避免慢上游长时间占用函数实例。可用环境变量 UPSTREAM_TIMEOUT_MS 覆盖。
const UPSTREAM_TIMEOUT_MS = Number(process.env.UPSTREAM_TIMEOUT_MS) || 10000;

// ——— 分叉点 3：上游响应体积上限（字节）———
// 避免超大响应造成内存放大。可用环境变量 MAX_RESPONSE_BYTES 覆盖。
const MAX_RESPONSE_BYTES = Number(process.env.MAX_RESPONSE_BYTES) || 5 * 1024 * 1024;

// MiSub 需要这些响应头来读取流量、到期时间、文件名等信息
const PASS_THROUGH_RESPONSE_HEADERS = [
  'subscription-userinfo',
  'profile-update-interval',
  'profile-title',
  'profile-web-page-url',
  'content-disposition',
  'content-type',
  'cache-control',
];

function createCorsHeaders() {
  return {
    'access-control-allow-origin': '*',
    'access-control-allow-methods': 'GET,HEAD,OPTIONS',
    'access-control-allow-headers': 'content-type,user-agent,x-user-agent',
    // 让浏览器调试时也能看到这些自定义响应头
    'access-control-expose-headers': PASS_THROUGH_RESPONSE_HEADERS.join(', '),
  };
}

function applyHeaders(res, headers) {
  for (const [key, value] of Object.entries(headers)) {
    res.setHeader(key, value);
  }
}

function sanitizeHeaderValue(value) {
  return String(value || '').replace(/[\r\n]/g, '').trim();
}

function getUpstreamUserAgent(req, requestUrl) {
  // 优先使用 MiSub 自动拼接到代理前缀里的 ua 参数：
  //   /api?token=xxx&ua=clash-verge%2Fv2.4.3&url=<encoded-subscription-url>
  // 其次兼容手动传入的 x-user-agent 请求头，最后使用默认 Clash Verge UA。
  return sanitizeHeaderValue(
    requestUrl.searchParams.get('ua') ||
    req.headers['x-user-agent'] ||
    DEFAULT_USER_AGENT
  );
}

function sendText(res, statusCode, message) {
  applyHeaders(res, createCorsHeaders());
  res.statusCode = statusCode;
  res.setHeader('content-type', 'text/plain; charset=utf-8');
  res.end(message);
}

// 恒定时间比较，避免通过响应耗时逐字节试探令牌
function safeEqual(a, b) {
  const bufA = Buffer.from(String(a));
  const bufB = Buffer.from(String(b));
  if (bufA.length !== bufB.length) return false;
  return crypto.timingSafeEqual(bufA, bufB);
}

function isTimeoutError(err) {
  return Boolean(err) && (err.name === 'TimeoutError' || err.name === 'AbortError');
}

// 只取错误摘要用于诊断，去掉换行并截断，避免把内部细节原样回吐
function toErrorDetail(err) {
  const text = err && err.message ? err.message : String(err);
  return text.replace(/[\r\n]+/g, ' ').slice(0, 200);
}

function makeSizeLimitError() {
  const err = new Error('upstream response exceeds size limit');
  err.code = 'RESPONSE_TOO_LARGE';
  return err;
}

// 分叉点 3 的实现：流式读取并累计字节数，超限立即中断，峰值内存受 limit 约束
async function readBodyWithLimit(response, limitBytes) {
  if (!response.body) {
    const buffer = Buffer.from(await response.arrayBuffer());
    if (buffer.byteLength > limitBytes) throw makeSizeLimitError();
    return buffer;
  }

  // 上游显式给出 Content-Length 且已超限时直接放弃，不做无谓传输
  const declared = Number(response.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > limitBytes) throw makeSizeLimitError();

  const reader = response.body.getReader();
  const chunks = [];
  let received = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      received += value.byteLength;
      if (received > limitBytes) throw makeSizeLimitError();
      chunks.push(Buffer.from(value));
    }
  } finally {
    // 正常结束或中途抛错都要释放上游连接
    Promise.resolve(reader.cancel()).catch(() => {});
  }

  return Buffer.concat(chunks);
}

module.exports = async function handler(req, res) {
  if (req.method === 'OPTIONS') {
    applyHeaders(res, createCorsHeaders());
    res.statusCode = 204;
    res.end();
    return;
  }

  if (!['GET', 'HEAD'].includes(req.method)) {
    sendText(res, 405, 'Method Not Allowed');
    return;
  }

  const requestUrl = new URL(req.url, `https://${req.headers.host || 'localhost'}`);

  // 分叉点 1：先鉴权，再处理任何业务参数，且不向未授权方回吐校验细节
  if (!PROXY_TOKEN) {
    sendText(res, 503, 'Proxy token is not configured on the server (set PROXY_TOKEN)');
    return;
  }

  if (!safeEqual(requestUrl.searchParams.get('token') || '', PROXY_TOKEN)) {
    sendText(res, 401, 'Unauthorized');
    return;
  }

  const targetUrl = requestUrl.searchParams.get('url');

  if (!targetUrl) {
    sendText(res, 400, 'Miss URL');
    return;
  }

  let parsedTarget;
  try {
    parsedTarget = new URL(targetUrl);
  } catch {
    sendText(res, 400, 'Invalid URL');
    return;
  }

  if (!['http:', 'https:'].includes(parsedTarget.protocol)) {
    sendText(res, 400, 'Only http/https URLs are allowed');
    return;
  }

  let upstreamResponse;
  try {
    upstreamResponse = await fetch(parsedTarget.toString(), {
      method: req.method === 'HEAD' ? 'HEAD' : 'GET',
      redirect: 'follow',
      // 分叉点 2：超时同时覆盖连接与 body 读取两个阶段
      signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
      headers: {
        // 很多机场会根据 UA 返回不同格式；Clash 类 UA 通常会返回 YAML 和 subscription-userinfo。
        // 注意：MiSub 发给代理的 User-Agent 不一定会自动成为代理访问机场时的 UA，
        // 所以这里必须显式使用 ua 参数 / x-user-agent 覆盖上游请求 UA。
        'user-agent': getUpstreamUserAgent(req, requestUrl),
        'accept': '*/*',
      },
    });
  } catch (err) {
    // 分叉点 4：失败时返回带 CORS 头的网关错误，而非平台级 500
    if (isTimeoutError(err)) {
      sendText(res, 504, 'Gateway Timeout: upstream request timed out');
    } else {
      sendText(res, 502, `Bad Gateway: upstream request failed (${toErrorDetail(err)})`);
    }
    return;
  }

  const responseHeaders = createCorsHeaders();

  for (const headerName of PASS_THROUGH_RESPONSE_HEADERS) {
    const value = upstreamResponse.headers.get(headerName);
    if (value) responseHeaders[headerName] = value;
  }

  // 如果上游没有 Content-Type，给一个安全默认值
  if (!responseHeaders['content-type']) {
    responseHeaders['content-type'] = 'text/plain; charset=utf-8';
  }

  if (req.method === 'HEAD') {
    applyHeaders(res, responseHeaders);
    res.statusCode = upstreamResponse.status;
    res.end();
    return;
  }

  let body;
  try {
    body = await readBodyWithLimit(upstreamResponse, MAX_RESPONSE_BYTES);
  } catch (err) {
    if (err && err.code === 'RESPONSE_TOO_LARGE') {
      sendText(res, 502, 'Bad Gateway: upstream response exceeds size limit');
    } else if (isTimeoutError(err)) {
      sendText(res, 504, 'Gateway Timeout: upstream body read timed out');
    } else {
      sendText(res, 502, `Bad Gateway: failed to read upstream response (${toErrorDetail(err)})`);
    }
    return;
  }

  applyHeaders(res, responseHeaders);
  res.statusCode = upstreamResponse.status;
  res.end(body);
};
