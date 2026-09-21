// Helper function to extract parameters from any request type
async function getParams(request) {
  const { searchParams } = new URL(request.url);
  const urlParams = Object.fromEntries(searchParams.entries());

  let bodyParams = {};
  if (request.method === 'POST' || request.method === 'PUT' || request.method === 'PATCH') {
    const contentType = (request.headers.get('content-type') || '').toLowerCase();
    try {
      if (contentType.includes('application/json')) {
        const jsonBody = await request.json();
        if (typeof jsonBody === 'string') {
          bodyParams = { content: jsonBody };
        } else if (jsonBody && typeof jsonBody === 'object') {
          if (jsonBody.params && typeof jsonBody.params === 'object') {
            bodyParams = jsonBody.params;
          } else if (jsonBody.data && typeof jsonBody.data === 'object') {
            bodyParams = jsonBody.data;
          } else {
            bodyParams = jsonBody;
          }
        }
      } else if (contentType.includes('application/x-www-form-urlencoded') || contentType.includes('multipart/form-data')) {
        const formData = await request.formData();
        bodyParams = Object.fromEntries(formData.entries());
      } else {
        const text = await request.text();
        if (text) {
          try {
            const parsed = JSON.parse(text);
            if (parsed && typeof parsed === 'object') {
              if (parsed.params && typeof parsed.params === 'object') {
                bodyParams = parsed.params;
              } else if (parsed.data && typeof parsed.data === 'object') {
                bodyParams = parsed.data;
              } else {
                bodyParams = parsed;
              }
            } else {
              bodyParams = { content: text };
            }
          } catch (e) {
            bodyParams = { content: text };
          }
        }
      }
    } catch (error) {
      console.error('Failed to parse request body:', error);
    }
  }

  return { ...urlParams, ...bodyParams };
}

const SKINS = {
  'warm-magazine': {
    name: '暖调杂志',
    slug: 'warm-magazine',
    route: '/skins/warm-magazine/index.html',
  },
  cyberpunk: {
    name: '赛博朋克',
    slug: 'cyberpunk',
    route: '/skins/cyberpunk/index.html',
  },
  sakura: {
    name: '樱花',
    slug: 'sakura',
    route: '/skins/sakura/index.html',
  },
  'terminal-neon': {
    name: '终端霓虹',
    slug: 'terminal-neon',
    route: '/skins/terminal-neon/index.html',
  },
  'ocean-breeze': {
    name: '海洋微风',
    slug: 'ocean-breeze',
    route: '/skins/ocean-breeze/index.html',
  },
  'hacker-dark': {
    name: '黑客暗黑',
    slug: 'hacker-dark',
    route: '/skins/hacker-dark/index.html',
  },
  'aurora-glass': {
    name: '极光玻璃',
    slug: 'aurora-glass',
    route: '/skins/aurora-glass/index.html',
  },
  'minimalist-light': {
    name: '极简浅色',
    slug: 'minimalist-light',
    route: '/skins/minimalist-light/index.html',
  },
  'quiet-night': {
    name: '静谧的夜空',
    slug: 'quiet-night',
    route: '/skins/quiet-night/index.html',
  },
  'sunset-glow': {
    name: '落日余晖',
    slug: 'sunset-glow',
    route: '/skins/sunset-glow/index.html',
  },
  'macos-hacker': {
    name: 'macOS 极客',
    slug: 'macos-hacker',
    route: '/skins/MacOS_Hacker_Theme-LGT/index.html',
  },
};

const DEFAULT_SKIN_KEY = 'warm-magazine';
const TOKEN_REFRESH_SKEW_MS = 5 * 60 * 1000;
const DEFAULT_TOKEN_LIFETIME_SECONDS = 7200;
const UPSTREAM_TIMEOUT_MS = 4000;
const INVALID_TOKEN_CODES = new Set([40014, 42001]);
const RETRYABLE_WECHAT_CODES = new Set([-1, 45009]);
const tokenCache = new Map();
const tokenRequests = new Map();

class WxSendError extends Error {
  constructor(message, { stage = 'unknown', code = 'UNKNOWN', status = 500, retryable = false } = {}) {
    super(message);
    this.name = 'WxSendError';
    this.stage = stage;
    this.code = code;
    this.status = status;
    this.retryable = retryable;
  }
}

function json(payload, status = 200) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8' },
  });
}

function logWxSend(event, details = {}) {
  console.info(JSON.stringify({ event, ...details }));
}

export async function fetchJsonWithTimeout(url, options = {}, { stage, timeoutMs = UPSTREAM_TIMEOUT_MS } = {}) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  const startedAt = Date.now();

  try {
    const response = await fetch(url, { ...options, signal: controller.signal });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) {
      throw new WxSendError(`Upstream ${stage} request failed.`, {
        stage,
        code: Number(data?.errcode || response.status),
        status: response.status >= 500 ? 502 : response.status,
        retryable: response.status === 408 || response.status === 429 || response.status >= 500,
      });
    }
    return { data, durationMs: Date.now() - startedAt };
  } catch (error) {
    if (error instanceof WxSendError) throw error;
    if (controller.signal.aborted) {
      throw new WxSendError(`Upstream ${stage} request timed out.`, {
        stage,
        code: 'UPSTREAM_TIMEOUT',
        status: 504,
        retryable: true,
      });
    }
    throw new WxSendError(`Upstream ${stage} request failed.`, {
      stage,
      code: 'UPSTREAM_NETWORK_ERROR',
      status: 502,
      retryable: true,
    });
  } finally {
    clearTimeout(timeout);
  }
}

function getSkinByKey(skinKey) {
  const key = (skinKey || '').toString().trim().toLowerCase();
  return SKINS[key] || SKINS[DEFAULT_SKIN_KEY];
}

function getOrigin(url) {
  return `${url.protocol}//${url.host}`;
}

function appendAccessQuery(url, sourceUrl) {
  try {
    const source = new URL(sourceUrl.toString());
    const target = new URL(url);
    const eoToken = source.searchParams.get('eo_token');
    const eoTime = source.searchParams.get('eo_time');

    if (eoToken && !target.searchParams.has('eo_token')) {
      target.searchParams.set('eo_token', eoToken);
    }
    if (eoTime && !target.searchParams.has('eo_time')) {
      target.searchParams.set('eo_time', eoTime);
    }

    return target.toString();
  } catch (error) {
    return url;
  }
}

function buildSkinLink(baseUrl, skin, url) {
  const raw = baseUrl && typeof baseUrl === 'string' && baseUrl.trim()
    ? baseUrl.trim()
    : `${getOrigin(url)}${skin.route}`;

  return appendAccessQuery(raw, url);
}

export async function onRequest(context) {
  const { request, env } = context;
  const url = new URL(request.url);

  // Allow handling wxsend or if it gets mapped directly to the function
  if (url.pathname !== '/wxsend' && !url.pathname.endsWith('wxsend.js')) {
    // Should not reach here if proper static routing is in place, but just in case
    return new Response('Not Found', { status: 404 });
  }

  const params = await getParams(request);

  const content = params.content;
  const title = params.title;

  let requestToken = params.token;
  if (!requestToken) {
    const authHeader = request.headers.get('Authorization') || request.headers.get('authorization');
    if (authHeader) {
      const parts = authHeader.split(' ');
      requestToken = parts.length === 2 && /^Bearer$/i.test(parts[0]) ? parts[1] : authHeader;
    }
  }

  const missingParams = [];
  if (!content) missingParams.push('content');
  if (!title) missingParams.push('title');

  // Handle Token validation logic
  let appid, secret, useridStr, template_id;
  
  if (requestToken) {
    if (requestToken !== env.API_TOKEN) {
      return json({ success: false, stage: 'auth', code: 'FORBIDDEN', retryable: false, msg: 'Token错误，无权使用内置配置 (Forbidden)' }, 403);
    }
    // Token is valid: Allow fallback to env variables
    appid = params.appid || env.WX_APPID;
    secret = params.secret || env.WX_SECRET;
    useridStr = params.userid || env.WX_USERID;
    template_id = params.template_id || env.WX_TEMPLATE_ID;
  } else {
    // No Token provided: Strictly require parameters from user, DO NOT fallback to env
    appid = params.appid;
    secret = params.secret;
    useridStr = params.userid;
    template_id = params.template_id;
    
    if (!appid) missingParams.push('appid');
    if (!secret) missingParams.push('secret');
    if (!useridStr) missingParams.push('userid');
    if (!template_id) missingParams.push('template_id');
  }

  if (missingParams.length > 0) {
    return json({
      success: false,
      stage: 'validation',
      code: 'MISSING_PARAMETERS',
      retryable: false,
      msg: 'Missing required parameters: ' + missingParams.join(', '),
    }, 400);
  }

  const skin = getSkinByKey(params.skin || env.WX_SKIN);
  const finalBaseUrl = buildSkinLink(params.base_url || env.WX_BASE_URL, skin, url);

  const user_list = useridStr.split('|').map(uid => uid.trim()).filter(Boolean);

  const startedAt = Date.now();
  try {
    let tokenResult = await getStableToken(appid, secret);

    const beijingTime = new Date(new Date().getTime() + 8 * 60 * 60 * 1000);
    const date = beijingTime.toISOString().slice(0, 19).replace('T', ' ');

    const jumpUrl = new URL(finalBaseUrl);
    jumpUrl.searchParams.set('message', content.replace(/\n/g, '~n~'));
    jumpUrl.searchParams.set('date', date);
    jumpUrl.searchParams.set('title', title);
    const jumpUrlStr = jumpUrl.toString();

    let results = await Promise.all(user_list.map(userid =>
      sendMessage(tokenResult.accessToken, userid, template_id, jumpUrlStr, title, content)
    ));

    const invalidTokenIndexes = results
      .map((result, index) => INVALID_TOKEN_CODES.has(Number(result?.errcode)) ? index : -1)
      .filter(index => index >= 0);

    if (invalidTokenIndexes.length > 0) {
      tokenResult = await getStableToken(appid, secret, { forceRefresh: true });
      const refreshed = await Promise.all(invalidTokenIndexes.map(index =>
        sendMessage(tokenResult.accessToken, user_list[index], template_id, jumpUrlStr, title, content)
      ));
      invalidTokenIndexes.forEach((resultIndex, refreshedIndex) => {
        results[resultIndex] = refreshed[refreshedIndex];
      });
    }

    const successfulMessages = results.filter(r => Number(r?.errcode || 0) === 0 && r?.errmsg === 'ok');
    const failedMessages = results.length - successfulMessages.length;

    if (successfulMessages.length > 0) {
      logWxSend('wxsend_completed', {
        status: 'success',
        sent: successfulMessages.length,
        failed: failedMessages,
        tokenCacheHit: tokenResult.cacheHit,
        durationMs: Date.now() - startedAt,
      });
      return json({
        success: true,
        sent: successfulMessages.length,
        failed: failedMessages,
        tokenCacheHit: tokenResult.cacheHit,
        msg: `Successfully sent messages to ${successfulMessages.length} user(s). First response: ok`,
        skin: skin.slug,
        jump_url: jumpUrlStr,
      });
    }

    const firstResult = results[0] || {};
    const firstCode = Number(firstResult.errcode || 0) || 'WECHAT_SEND_FAILED';
    const retryable = RETRYABLE_WECHAT_CODES.has(Number(firstResult.errcode));
    logWxSend('wxsend_failed', {
      stage: 'send',
      code: firstCode,
      retryable,
      durationMs: Date.now() - startedAt,
    });
    return json({
      success: false,
      stage: 'send',
      code: firstCode,
      retryable,
      msg: `Failed to send messages. First error: ${firstResult.errmsg || 'Unknown error'}`,
      message: 'WeChat template message delivery failed.',
    }, 500);
  } catch (error) {
    const safeError = error instanceof WxSendError
      ? error
      : new WxSendError('Unexpected wxsend failure.');
    logWxSend('wxsend_failed', {
      stage: safeError.stage,
      code: safeError.code,
      retryable: safeError.retryable,
      durationMs: Date.now() - startedAt,
    });
    return json({
      success: false,
      stage: safeError.stage,
      code: safeError.code,
      retryable: safeError.retryable,
      msg: `An error occurred: ${safeError.message}`,
      message: safeError.message,
    }, safeError.status);
  }
}

async function getStableToken(appid, secret, { forceRefresh = false } = {}) {
  const cached = tokenCache.get(appid);
  if (!forceRefresh && cached && cached.expiresAt - TOKEN_REFRESH_SKEW_MS > Date.now()) {
    return { accessToken: cached.accessToken, cacheHit: true };
  }

  if (tokenRequests.has(appid)) {
    return tokenRequests.get(appid);
  }

  if (forceRefresh) tokenCache.delete(appid);
  const tokenUrl = 'https://api.weixin.qq.com/cgi-bin/stable_token';
  const request = (async () => {
    const { data } = await fetchJsonWithTimeout(tokenUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json;charset=utf-8' },
      body: JSON.stringify({
        grant_type: 'client_credential',
        appid,
        secret,
        force_refresh: forceRefresh,
      }),
    }, { stage: 'token' });

    if (!data.access_token) {
      throw new WxSendError('Failed to get access token.', {
        stage: 'token',
        code: Number(data.errcode || 0) || 'TOKEN_MISSING',
        status: 502,
        retryable: Number(data.errcode) === -1,
      });
    }

    tokenCache.set(appid, {
      accessToken: data.access_token,
      expiresAt: Date.now() + Math.max(Number(data.expires_in || DEFAULT_TOKEN_LIFETIME_SECONDS), 60) * 1000,
    });
    return { accessToken: data.access_token, cacheHit: false };
  })();

  tokenRequests.set(appid, request);
  try {
    return await request;
  } finally {
    if (tokenRequests.get(appid) === request) tokenRequests.delete(appid);
  }
}

async function sendMessage(accessToken, userid, template_id, target_url, title, content) {
  const sendUrl = `https://api.weixin.qq.com/cgi-bin/message/template/send?access_token=${accessToken}`;

  const payload = {
    touser: userid,
    template_id: template_id,
    url: target_url,
    data: {
      title: { value: title },
      content: { value: content },
    },
  };

  const { data } = await fetchJsonWithTimeout(sendUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json;charset=utf-8' },
    body: JSON.stringify(payload),
  }, { stage: 'send' });

  return data;
}
