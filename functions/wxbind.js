const QR_LIFETIME_SECONDS = 600;

function json(payload, status = 200) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8' },
  });
}

function html(body, status = 200) {
  return new Response(`<!doctype html><html lang="zh-CN"><meta name="viewport" content="width=device-width,initial-scale=1"><title>微信提醒绑定</title><body style="margin:0;padding:32px 20px;font:16px system-ui,sans-serif;color:#17211d;text-align:center;background:#f8faf8">${body}</body></html>`, {
    status,
    headers: { 'Content-Type': 'text/html; charset=utf-8' },
  });
}

function getRequestToken(request) {
  const authorization = request.headers.get('Authorization') || '';
  return authorization.replace(/^Bearer\s+/i, '');
}

function sameText(left, right) {
  if (!left || !right || left.length !== right.length) return false;
  let difference = 0;
  for (let index = 0; index < left.length; index += 1) {
    difference |= left.charCodeAt(index) ^ right.charCodeAt(index);
  }
  return difference === 0;
}

function isScene(value) {
  return /^[a-f0-9]{32}$/.test(String(value || ''));
}

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (character) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  })[character]);
}

function createAuthorizationUrl(origin, scene, env) {
  const redirectUri = `${origin}/wxbind`;
  return `https://open.weixin.qq.com/connect/oauth2/authorize?appid=${encodeURIComponent(env.WX_APPID)}&redirect_uri=${encodeURIComponent(redirectUri)}&response_type=code&scope=snsapi_base&state=${encodeURIComponent(scene)}#wechat_redirect`;
}

async function getStableToken(env) {
  const response = await fetch('https://api.weixin.qq.com/cgi-bin/stable_token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json;charset=utf-8' },
    body: JSON.stringify({
      grant_type: 'client_credential',
      appid: env.WX_APPID,
      secret: env.WX_SECRET,
      force_refresh: false,
    }),
  });
  const data = await response.json().catch(() => ({}));
  return response.ok ? String(data.access_token || '') : '';
}

async function createFollowQr(scene, env) {
  const accessToken = await getStableToken(env);
  if (!accessToken) throw new Error('WeChat token request failed.');

  const url = new URL('https://api.weixin.qq.com/cgi-bin/qrcode/create');
  url.searchParams.set('access_token', accessToken);
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json;charset=utf-8' },
    body: JSON.stringify({
      expire_seconds: QR_LIFETIME_SECONDS,
      action_name: 'QR_STR_SCENE',
      action_info: { scene: { scene_str: scene } },
    }),
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok || !data.ticket) throw new Error('WeChat follow QR request failed.');

  const imageUrl = new URL('https://mp.weixin.qq.com/cgi-bin/showqrcode');
  imageUrl.searchParams.set('ticket', data.ticket);
  return {
    imageUrl: imageUrl.toString(),
    openUrl: /^https?:\/\/weixin\.qq\.com\/q\//.test(String(data.url || '')) ? data.url : '',
  };
}

async function getOpenidFromAuthorizationCode(code, env) {
  const url = new URL('https://api.weixin.qq.com/sns/oauth2/access_token');
  url.searchParams.set('appid', env.WX_APPID);
  url.searchParams.set('secret', env.WX_SECRET);
  url.searchParams.set('code', code);
  url.searchParams.set('grant_type', 'authorization_code');
  const response = await fetch(url);
  const data = await response.json().catch(() => ({}));
  return response.ok ? String(data.openid || '') : '';
}

async function isFollower(openid, env) {
  const accessToken = await getStableToken(env);
  if (!accessToken) return false;
  const url = new URL('https://api.weixin.qq.com/cgi-bin/user/info');
  url.searchParams.set('access_token', accessToken);
  url.searchParams.set('openid', openid);
  url.searchParams.set('lang', 'zh_CN');
  const response = await fetch(url);
  const data = await response.json().catch(() => ({}));
  return response.ok && Number(data.subscribe) === 1;
}

async function forwardBinding(binding, env) {
  if (!env.CROSSNEST_BINDING_CALLBACK_URL || !env.CROSSNEST_BINDING_INTERNAL_TOKEN) {
    throw new Error('CrossNest binding callback is not configured.');
  }
  const response = await fetch(env.CROSSNEST_BINDING_CALLBACK_URL, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${env.CROSSNEST_BINDING_INTERNAL_TOKEN}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(binding),
  });
  if (!response.ok) throw new Error('CrossNest binding callback failed.');
}

async function showFollowPage(origin, scene, env) {
  const authorizationUrl = createAuthorizationUrl(origin, scene, env);
  const followQr = await createFollowQr(scene, env);
  const followAction = followQr.openUrl
    ? `<p><a href="${escapeHtml(followQr.openUrl)}" style="color:#176b45;font-weight:700">打开关注页面</a></p>`
    : '';
  return html(`<h1 style="font-size:21px">请先关注测试号</h1><p style="line-height:1.7;color:#607168">关注后再点击“完成绑定”。无需输入任何信息。</p>${followAction}<img src="${escapeHtml(followQr.imageUrl)}" width="184" height="184" alt="关注测试号二维码" style="display:block;margin:20px auto;border-radius:8px"><p style="font-size:13px;color:#607168">无法打开关注页面时，请长按二维码并选择“识别图中二维码”。</p><a href="${escapeHtml(authorizationUrl)}" style="display:inline-block;margin-top:14px;padding:11px 18px;border-radius:7px;background:#176b45;color:white;text-decoration:none;font-weight:700">完成绑定</a>`);
}

export async function onRequest(context) {
  const { request, env } = context;
  const url = new URL(request.url);
  if (url.pathname !== '/wxbind') return new Response('Not Found', { status: 404 });
  if (request.method === 'GET') {
    const scene = url.searchParams.get('state') || '';
    const code = url.searchParams.get('code') || '';
    if (!isScene(scene) || !code) return html('<p>绑定链接无效或已过期，请回到 CrossNest 重新生成二维码。</p>', 400);
    try {
      const openid = await getOpenidFromAuthorizationCode(code, env);
      if (!openid) throw new Error('WeChat authorization failed.');
      if (!await isFollower(openid, env)) return await showFollowPage(url.origin, scene, env);
      await forwardBinding({ scene, openid }, env);
      return html('<h1 style="font-size:21px">微信提醒已绑定</h1><p style="line-height:1.7;color:#607168">你可以返回 CrossNest 继续使用。</p>');
    } catch {
      return html('<p>暂时无法完成绑定，请回到 CrossNest 重新生成二维码后重试。</p>', 502);
    }
  }
  if (request.method !== 'POST') return new Response('Method Not Allowed', { status: 405 });
  if (!sameText(getRequestToken(request), String(env.API_TOKEN || ''))) return json({ msg: 'Invalid token' }, 403);
  try {
    const body = await request.json().catch(() => ({}));
    const scene = String(body.scene || '');
    if (!isScene(scene)) return json({ msg: 'Invalid scene' }, 400);
    return json({ openUrl: createAuthorizationUrl(url.origin, scene, env) });
  } catch {
    return json({ msg: 'Unable to create binding link' }, 502);
  }
}
