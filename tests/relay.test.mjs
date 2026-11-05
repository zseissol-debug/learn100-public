import test from 'node:test';
import assert from 'node:assert/strict';
import worker, { voiceHandshakeFailure } from '../worker/index.js';

test('评分中转只转发请求中的 Key，向浏览器返回模型内容与用量', async () => {
  const original = globalThis.fetch;
  let upstream;
  globalThis.fetch = async (url, options) => {
    upstream = { url, options };
    return new Response(JSON.stringify({ choices:[{ message:{ content:'{"points":[]}' } }], usage:{ total_tokens:42 } }),
      { status:200, headers:{ 'content-type':'application/json' } });
  };
  try {
    const response = await worker.fetch(new Request('https://example.com/api/score', {
      method:'POST', headers:{ 'content-type':'application/json' },
      body:JSON.stringify({ key:'test-key', prompt:'评分规则', input:{ transcript:[] } })
    }));
    const result = await response.json();
    assert.equal(response.status, 200);
    assert.equal(upstream.options.headers.authorization, 'Bearer test-key');
    assert.equal(result.usage.total_tokens, 42);
    assert.ok(!JSON.stringify(result).includes('test-key'));
  } finally { globalThis.fetch = original; }
});

test('上游拒绝 Key 时给中文错误，不回显 Key', async () => {
  const original = globalThis.fetch;
  globalThis.fetch = async () => new Response('unauthorized', { status:401 });
  try {
    const response = await worker.fetch(new Request('https://example.com/api/score', {
      method:'POST', headers:{ 'content-type':'application/json' }, body:JSON.stringify({ key:'secret-test', prompt:'评分', input:{} })
    }));
    const result = await response.json();
    assert.match(result.error, /Key 无效/); assert.ok(!JSON.stringify(result).includes('secret-test'));
  } finally { globalThis.fetch = original; }
});

test('评分上游失败时保留安全诊断字段，不回显错误正文或 Key', async () => {
  const original = globalThis.fetch;
  globalThis.fetch = async () => new Response(JSON.stringify({ error:{ code:'ModelNotFound', type:'invalid_request_error', message:'secret-test' } }), {
    status:400, headers:{ 'content-type':'application/json', 'X-Tt-Logid':'req-123' }
  });
  try {
    const response = await worker.fetch(new Request('https://example.com/api/score', {
      method:'POST', headers:{ 'content-type':'application/json' }, body:JSON.stringify({ key:'secret-test', prompt:'评分', input:{} })
    }));
    const result = await response.json();
    assert.equal(response.status, 502);
    assert.equal(result.status, 400);
    assert.equal(result.providerCode, 'ModelNotFound');
    assert.equal(result.providerType, 'invalid_request_error');
    assert.equal(result.requestId, 'req-123');
    assert.ok(!JSON.stringify(result).includes('secret-test'));
  } finally { globalThis.fetch = original; }
});

test('前端 JavaScript 不使用长缓存，避免部署后继续运行旧代码', async () => {
  const hadAssets = Object.hasOwn(globalThis, 'ASSETS');
  const oldAssets = globalThis.ASSETS;
  globalThis.ASSETS = {
    '/app.js': { body:'export {}', type:'text/javascript; charset=utf-8' },
    '/style.css': { body:'body{}', type:'text/css; charset=utf-8' }
  };
  try {
    const app = await worker.fetch(new Request('https://example.com/app.js'));
    const style = await worker.fetch(new Request('https://example.com/style.css'));
    assert.equal(app.headers.get('cache-control'), 'no-store');
    assert.equal(style.headers.get('cache-control'), 'public, max-age=3600');
  } finally {
    if (hadAssets) globalThis.ASSETS = oldAssets;
    else delete globalThis.ASSETS;
  }
});

test('豆包语音握手诊断区分认证与项目权限，且只暴露安全诊断字段', async () => {
  const unauthorized = await voiceHandshakeFailure(new Response(JSON.stringify({ error:{ code:'InvalidApiKey', message:'secret-test' } }), {
    status:401, headers:{ 'content-type':'application/json', 'X-Tt-Logid':'logid-123' }
  }));
  const forbidden = await voiceHandshakeFailure(new Response(JSON.stringify({ code:40301, message:'secret-test' }), {
    status:403, headers:{ 'content-type':'application/json' }
  }));

  assert.equal(unauthorized.status, 401);
  assert.equal(unauthorized.providerCode, 'InvalidApiKey');
  assert.equal(unauthorized.requestId, 'logid-123');
  assert.match(unauthorized.message, /认证失败/);
  assert.equal(forbidden.status, 403);
  assert.equal(forbidden.providerCode, '40301');
  assert.match(forbidden.message, /项目已开通/);
  assert.ok(!JSON.stringify([unauthorized, forbidden]).includes('secret-test'));
});

test('评分中转限制没有 Content-Length 的超大请求体', async () => {
  const original = globalThis.fetch;
  let upstreamCalled = false;
  globalThis.fetch = async () => {
    upstreamCalled = true;
    return new Response(JSON.stringify({ choices:[{ message:{ content:'{}' } }] }), { status:200 });
  };
  try {
    const body = JSON.stringify({ key:'test-key', prompt:'评分规则', input:{ transcript:[{ text:'字'.repeat(150000) }] } });
    const request = new Request('https://example.com/api/score', {
      method:'POST', headers:{ 'content-type':'application/json' }, body
    });
    assert.equal(request.headers.get('content-length'), null, '复现无 Content-Length 的流式请求');
    const response = await worker.fetch(request);
    assert.equal(response.status, 413);
    assert.equal(upstreamCalled, false);
  } finally { globalThis.fetch = original; }
});
