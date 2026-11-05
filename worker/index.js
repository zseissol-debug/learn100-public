// ASSETS and CONCEPTS are prepended by scripts/build.mjs. Keys exist only in request scope.
const json = (value, status = 200) => new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' } });
const errors = { 401: 'Key 无效或未开通服务', 403: 'Key 无效或未开通服务', 429: '请求过多，请稍后重试' };
const MAX_SCORE_REQUEST_BYTES = 100_000;

const safeDiagnosticValue = value => {
  if (value == null) return null;
  const safe = String(value).replace(/[^A-Za-z0-9_.:-]/g, '').slice(0, 120);
  return safe || null;
};

export async function voiceHandshakeFailure(response) {
  let providerCode = null;
  try {
    const payload = await response.clone().json();
    providerCode = safeDiagnosticValue(payload?.error?.code ?? payload?.code);
  } catch {}

  const status = response.status;
  const message = status === 401
    ? '豆包语音认证失败。请确认使用该项目下有效的豆包语音 API Key。'
    : status === 403
      ? '豆包语音拒绝访问。请确认当前项目已开通实时语音模型，并使用该项目的 API Key。'
      : status === 429
        ? '豆包语音请求过多，请稍后重试。'
        : `豆包语音握手失败（HTTP ${status}）。`;

  return {
    kind: 'error',
    code: 'UPSTREAM_HTTP_ERROR',
    status,
    providerCode,
    requestId: safeDiagnosticValue(response.headers.get('x-tt-logid') || response.headers.get('x-tt-request-id')),
    message
  };
}

async function readLimitedJson(request, maxBytes) {
  const declaredLength = request.headers.get('content-length');
  if (declaredLength !== null && !/^\d+$/.test(declaredLength)) return { invalid: true };
  if (declaredLength !== null && Number(declaredLength) > maxBytes) return { tooLarge: true };
  if (!request.body) return { invalid: true };
  const reader = request.body.getReader(), chunks = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) {
        try { await reader.cancel(); } catch {}
        return { tooLarge: true };
      }
      chunks.push(value);
    }
  } catch { return { invalid: true }; }
  const body = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) { body.set(chunk, offset); offset += chunk.byteLength; }
  try { return { payload: JSON.parse(new TextDecoder().decode(body)) }; }
  catch { return { invalid: true }; }
}

async function score(request) {
  const parsed = await readLimitedJson(request, MAX_SCORE_REQUEST_BYTES);
  if (parsed.tooLarge) return json({ error: '评分请求过大' }, 413);
  if (parsed.invalid) return json({ error: '评分请求格式不正确' }, 400);
  const payload = parsed.payload;
  if (typeof payload?.key !== 'string' || typeof payload.prompt !== 'string' || !payload.key || payload.prompt.length > 50000) {
    return json({ error: '评分请求格式不正确' }, 400);
  }
  const { key, prompt, model } = payload;
  try {
    const upstream = await fetch('https://ark.cn-beijing.volces.com/api/v3/chat/completions', {
      method: 'POST', headers: { 'authorization': `Bearer ${key}`, 'content-type': 'application/json' },
      body: JSON.stringify({ model: model || 'deepseek-v4-1-flash-economy-261017', temperature: 0.1, thinking: { type:'disabled' }, response_format: { type: 'json_object' }, messages: [{ role: 'system', content: prompt }, { role: 'user', content: JSON.stringify(payload.input) }] })
    });
    if (!upstream.ok) {
      let providerCode = null;
      let providerType = null;
      try {
        const failure = await upstream.clone().json();
        providerCode = safeDiagnosticValue(failure?.error?.code ?? failure?.code);
        providerType = safeDiagnosticValue(failure?.error?.type ?? failure?.type);
      } catch {}
      const requestId = safeDiagnosticValue(upstream.headers.get('x-tt-logid') || upstream.headers.get('x-tt-request-id'));
      return json({ error: errors[upstream.status] || '评分服务暂时不可用', status: upstream.status, providerCode, providerType, requestId }, 502);
    }
    const answer = await upstream.json();
    return json({ content: answer.choices?.[0]?.message?.content || '', usage: answer.usage || null });
  } catch { return json({ error: '评分服务连接失败' }, 502); }
}

async function voice(request) {
  if (request.headers.get('Upgrade')?.toLowerCase() !== 'websocket') return json({ error: '需要 WebSocket 连接' }, 426);
  const pair = new WebSocketPair(), client = pair[0], server = pair[1];
  server.accept(); let upstream = null, connecting = false;
  const safeSend = object => { try { server.send(JSON.stringify(object)); } catch {} };
  server.addEventListener('message', async event => {
    if (!upstream) {
      if (connecting) return;
      let auth;
      try { auth = JSON.parse(event.data); } catch { safeSend({ kind: 'error', message: '连接信息格式不正确' }); return; }
      if (auth.kind !== 'auth' || typeof auth.key !== 'string' || !auth.key) { safeSend({ kind:'error', code:'MISSING_VOICE_KEY', message:'请填写豆包语音 API Key。' }); return; }
      connecting = true;
      try {
        const response = await fetch('https://openspeech.bytedance.com/api/v3/duplex/realtime/dialogue', { headers: { Upgrade: 'websocket', 'X-Api-Key': auth.key } });
        if (response.status !== 101 || !response.webSocket) { safeSend(await voiceHandshakeFailure(response)); server.close(1011); return; }
        upstream = response.webSocket; upstream.accept();
        upstream.addEventListener('message', e => { try { server.send(e.data); } catch {} });
        upstream.addEventListener('close', () => { safeSend({ kind:'closed' }); try { server.close(1000); } catch {} });
        upstream.addEventListener('error', () => { safeSend({ kind:'error', message:'语音连接中断' }); try { server.close(1011); } catch {} });
        safeSend({ kind: 'ready' });
      } catch { safeSend({ kind:'error', code:'UPSTREAM_NETWORK_ERROR', message:'连接豆包语音服务时发生网络错误。' }); try { server.close(1011); } catch {} }
      return;
    }
    try { upstream.send(event.data); } catch { safeSend({ kind:'error', message:'语音连接中断' }); }
  });
  server.addEventListener('close', () => { try { upstream?.close(1000); } catch {} });
  return new Response(null, { status: 101, webSocket: client });
}

export default {
  async fetch(request) {
    const url = new URL(request.url);
    if (url.pathname === '/ws') return voice(request);
    if (url.pathname === '/api/score' && request.method === 'POST') return score(request);
    if (url.pathname === '/api/concepts') return json(CONCEPTS);
    const path = url.pathname === '/' ? '/index.html' : url.pathname;
    const asset = ASSETS[path];
    if (!asset) return new Response('Not found', { status: 404 });
    const cacheControl = path === '/index.html' || path.endsWith('.js') ? 'no-store' : 'public, max-age=3600';
    return new Response(asset.body, { headers: { 'content-type': asset.type, 'cache-control': cacheControl, 'x-content-type-options': 'nosniff' } });
  }
};
