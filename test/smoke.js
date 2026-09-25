/* 临时冒烟测试：本地起 mock 上游 + 加载 handler，覆盖鉴权/透传/超时/体积上限/错误映射 */
const http = require('node:http');
const assert = require('node:assert');

const PROXY_PORT = 3998;
const UPSTREAM_PORT = 3999;
const TOKEN = 'smoke-token';
const SUB_INFO = 'upload=0; download=123456; total=999999; expire=1799999999';

function listen(server, port) {
  return new Promise((resolve) => server.listen(port, '127.0.0.1', resolve));
}

function close(server) {
  return new Promise((resolve) => server.close(resolve));
}

function request(port, path, method = 'GET') {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path, method }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () =>
        resolve({
          status: res.statusCode,
          headers: res.headers,
          body: Buffer.concat(chunks).toString('utf8'),
        })
      );
    });
    req.on('error', reject);
    req.end();
  });
}

function loadHandler() {
  delete require.cache[require.resolve('../api/index.js')];
  return require('../api/index.js');
}

function mockServer() {
  return http.createServer((req, res) => {
    const mode = new URL(req.url, 'http://localhost').searchParams.get('mode') || 'ok';
    if (mode === 'slow') {
      setTimeout(() => {
        res.writeHead(200);
        res.end('late');
      }, 1500);
      return;
    }
    if (mode === 'big') {
      res.writeHead(200, { 'content-type': 'text/plain' });
      res.end('x'.repeat(5000));
      return;
    }
    if (mode === 'reset') {
      req.socket.destroy();
      return;
    }
    res.writeHead(200, {
      'content-type': 'application/yaml',
      'subscription-userinfo': SUB_INFO,
      'profile-title': 'smoke-title',
    });
    res.end('proxies: []\n');
  });
}

const results = [];
async function check(name, fn) {
  try {
    await fn();
    results.push(['PASS', name]);
  } catch (err) {
    results.push(['FAIL', `${name} -> ${err.message}`]);
  }
}

(async () => {
  const upstream = mockServer();
  await listen(upstream, UPSTREAM_PORT);
  const target = (mode) =>
    encodeURIComponent(`http://127.0.0.1:${UPSTREAM_PORT}/sub?mode=${mode}`);

  // ---- Stage A：未配置 PROXY_TOKEN，应 fail-closed ----
  delete process.env.PROXY_TOKEN;
  const serverA = http.createServer((req, res) => loadHandler()(req, res));
  await listen(serverA, PROXY_PORT - 1);
  await check('未配置 PROXY_TOKEN -> 503 fail-closed', async () => {
    const r = await request(PROXY_PORT - 1, `/api?url=${target('ok')}`);
    assert.strictEqual(r.status, 503);
    assert.strictEqual(r.headers['access-control-allow-origin'], '*');
  });
  await close(serverA);

  // ---- Stage B：配置令牌与加固参数 ----
  process.env.PROXY_TOKEN = TOKEN;
  process.env.UPSTREAM_TIMEOUT_MS = '300';
  process.env.MAX_RESPONSE_BYTES = '1000';
  const serverB = http.createServer((req, res) => loadHandler()(req, res));
  await listen(serverB, PROXY_PORT);
  const P = PROXY_PORT;

  await check('OPTIONS -> 204', async () => {
    assert.strictEqual((await request(P, '/api', 'OPTIONS')).status, 204);
  });
  await check('POST -> 405', async () => {
    assert.strictEqual((await request(P, '/api', 'POST')).status, 405);
  });
  await check('缺 token -> 401', async () => {
    assert.strictEqual((await request(P, `/api?url=${target('ok')}`)).status, 401);
  });
  await check('错 token -> 401', async () => {
    const r = await request(P, `/api?token=wrong&url=${target('ok')}`);
    assert.strictEqual(r.status, 401);
  });
  await check('已授权但缺 url -> 400', async () => {
    assert.strictEqual((await request(P, `/api?token=${TOKEN}`)).status, 400);
  });
  await check('已授权但 url 非法 -> 400', async () => {
    assert.strictEqual((await request(P, `/api?token=${TOKEN}&url=not-a-url`)).status, 400);
  });
  await check('已授权但协议非 http(s) -> 400', async () => {
    const r = await request(P, `/api?token=${TOKEN}&url=${encodeURIComponent('ftp://x/y')}`);
    assert.strictEqual(r.status, 400);
  });
  await check('正常透传 -> 200 + subscription-userinfo + content-type', async () => {
    const r = await request(P, `/api?token=${TOKEN}&url=${target('ok')}`);
    assert.strictEqual(r.status, 200);
    assert.strictEqual(r.headers['subscription-userinfo'], SUB_INFO);
    assert.strictEqual(r.headers['content-type'], 'application/yaml');
    assert.strictEqual(r.headers['profile-title'], 'smoke-title');
    assert.strictEqual(r.headers['access-control-allow-origin'], '*');
    assert.ok(r.headers['access-control-expose-headers'].includes('subscription-userinfo'));
    assert.strictEqual(r.body, 'proxies: []\n');
  });
  await check('HEAD -> 200 且带 subscription-userinfo、无 body', async () => {
    const r = await request(P, `/api?token=${TOKEN}&url=${target('ok')}`, 'HEAD');
    assert.strictEqual(r.status, 200);
    assert.strictEqual(r.headers['subscription-userinfo'], SUB_INFO);
    assert.strictEqual(r.body, '');
  });
  await check('上游超时 -> 504', async () => {
    assert.strictEqual((await request(P, `/api?token=${TOKEN}&url=${target('slow')}`)).status, 504);
  });
  await check('响应超体积上限 -> 502', async () => {
    assert.strictEqual((await request(P, `/api?token=${TOKEN}&url=${target('big')}`)).status, 502);
  });
  await check('上游连接中断 -> 502', async () => {
    assert.strictEqual((await request(P, `/api?token=${TOKEN}&url=${target('reset')}`)).status, 502);
  });
  await check('上游不可达 -> 502', async () => {
    const dead = encodeURIComponent('http://127.0.0.1:1/none');
    assert.strictEqual((await request(P, `/api?token=${TOKEN}&url=${dead}`)).status, 502);
  });

  await close(serverB);
  await close(upstream);

  const failed = results.filter(([s]) => s === 'FAIL');
  for (const [status, name] of results) console.log(`${status}  ${name}`);
  console.log(`\n合计 ${results.length} 项，通过 ${results.length - failed.length}，失败 ${failed.length}`);
  process.exit(failed.length ? 1 : 0);
})();
