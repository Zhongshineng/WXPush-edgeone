import assert from 'node:assert/strict';
import test from 'node:test';

const originalFetch = globalThis.fetch;

function jsonResponse(payload, status = 200) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function request() {
  return new Request('https://wxpush.example/wxsend', {
    method: 'POST',
    headers: {
      Authorization: 'api-token',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ title: 'CN提醒', content: '您有新的未读消息', userid: 'openid-test' }),
  });
}

const env = {
  API_TOKEN: 'api-token',
  WX_APPID: 'app-id',
  WX_SECRET: 'app-secret',
  WX_TEMPLATE_ID: 'template-id',
};

async function loadModule(label) {
  return import(new URL(`../functions/wxsend.js?${label}-${Date.now()}-${Math.random()}`, import.meta.url));
}

test.afterEach(() => {
  globalThis.fetch = originalFetch;
});

test('warm requests reuse the cached access token', async () => {
  let tokenCalls = 0;
  let sendCalls = 0;
  globalThis.fetch = async (url) => {
    if (String(url).includes('stable_token')) {
      tokenCalls += 1;
      return jsonResponse({ access_token: 'cached-token', expires_in: 7200 });
    }
    sendCalls += 1;
    return jsonResponse({ errcode: 0, errmsg: 'ok' });
  };

  const { onRequest } = await loadModule('cache');
  const first = await onRequest({ request: request(), env });
  const second = await onRequest({ request: request(), env });
  const firstBody = await first.json();
  const secondBody = await second.json();

  assert.equal(first.status, 200);
  assert.equal(second.status, 200);
  assert.equal(firstBody.tokenCacheHit, false);
  assert.equal(secondBody.tokenCacheHit, true);
  assert.equal(tokenCalls, 1);
  assert.equal(sendCalls, 2);
});

test('concurrent cold requests share one token request', async () => {
  let tokenCalls = 0;
  globalThis.fetch = async (url) => {
    if (String(url).includes('stable_token')) {
      tokenCalls += 1;
      await new Promise(resolve => setTimeout(resolve, 10));
      return jsonResponse({ access_token: 'shared-token', expires_in: 7200 });
    }
    return jsonResponse({ errcode: 0, errmsg: 'ok' });
  };

  const { onRequest } = await loadModule('single-flight');
  const responses = await Promise.all([
    onRequest({ request: request(), env }),
    onRequest({ request: request(), env }),
  ]);

  assert.deepEqual(responses.map(response => response.status), [200, 200]);
  assert.equal(tokenCalls, 1);
});

test('invalid access tokens are refreshed and the failed message is resent once', async () => {
  let tokenCalls = 0;
  let sendCalls = 0;
  const forceRefreshValues = [];
  globalThis.fetch = async (url, options) => {
    if (String(url).includes('stable_token')) {
      tokenCalls += 1;
      forceRefreshValues.push(JSON.parse(options.body).force_refresh);
      return jsonResponse({
        access_token: tokenCalls === 1 ? 'expired-token' : 'fresh-token',
        expires_in: 7200,
      });
    }
    sendCalls += 1;
    return String(url).includes('expired-token')
      ? jsonResponse({ errcode: 40014, errmsg: 'invalid access_token' })
      : jsonResponse({ errcode: 0, errmsg: 'ok' });
  };

  const { onRequest } = await loadModule('refresh');
  const response = await onRequest({ request: request(), env });
  const body = await response.json();

  assert.equal(response.status, 200);
  assert.equal(body.success, true);
  assert.equal(tokenCalls, 2);
  assert.equal(sendCalls, 2);
  assert.deepEqual(forceRefreshValues, [false, true]);
});

test('permanent WeChat errors return structured non-retryable failures', async () => {
  globalThis.fetch = async (url) => String(url).includes('stable_token')
    ? jsonResponse({ access_token: 'valid-token', expires_in: 7200 })
    : jsonResponse({ errcode: 40003, errmsg: 'invalid openid' });

  const { onRequest } = await loadModule('permanent');
  const response = await onRequest({ request: request(), env });
  const body = await response.json();

  assert.equal(response.status, 500);
  assert.equal(body.success, false);
  assert.equal(body.stage, 'send');
  assert.equal(body.code, 40003);
  assert.equal(body.retryable, false);
});

test('upstream timeouts are classified as retryable without leaking request data', async () => {
  globalThis.fetch = async (_url, { signal }) => new Promise((_, reject) => {
    signal.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')), { once: true });
  });

  const { fetchJsonWithTimeout } = await loadModule('timeout');
  await assert.rejects(
    fetchJsonWithTimeout('https://api.weixin.qq.com/test', {}, { stage: 'token', timeoutMs: 5 }),
    error => error.code === 'UPSTREAM_TIMEOUT' && error.retryable === true && error.stage === 'token'
  );
});
