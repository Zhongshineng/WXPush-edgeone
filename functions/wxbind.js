const QR_LIFETIME_SECONDS = 600;

function json(payload, status = 200) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8' },
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

async function sha1(value) {
  const bytes = new TextEncoder().encode(value);
  const digest = await crypto.subtle.digest('SHA-1', bytes);
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

async function isWechatRequest(request, env) {
  const url = new URL(request.url);
  const signature = url.searchParams.get('signature') || '';
  const timestamp = url.searchParams.get('timestamp') || '';
  const nonce = url.searchParams.get('nonce') || '';
  const token = String(env.WX_CALLBACK_TOKEN || '');
  if (!signature || !timestamp || !nonce || !token) return false;
  const expected = await sha1([token, timestamp, nonce].sort().join(''));
  return sameText(expected, signature);
}

function readXmlField(xml, field) {
  const match = xml.match(new RegExp(`<${field}>(?:<!\\[CDATA\\[([\\s\\S]*?)\\]\\]>|([^<]*))<\\/${field}>`));
  return String(match?.[1] ?? match?.[2] ?? '').trim();
}

function getSceneFromWechatEvent(xml) {
  const event = readXmlField(xml, 'Event').toLowerCase();
  const eventKey = readXmlField(xml, 'EventKey');
  const openid = readXmlField(xml, 'FromUserName');
  const scene = event === 'subscribe' && eventKey.startsWith('qrscene_')
    ? eventKey.slice('qrscene_'.length)
    : event === 'scan' ? eventKey : '';
  if (!/^[a-f0-9]{32}$/.test(scene) || !openid || openid.length > 128) return null;
  return { scene, openid };
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
  const data = await response.json();
  return data.access_token || '';
}

async function createQr(scene, env) {
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
  const data = await response.json();
  if (!response.ok || !data.ticket) throw new Error('WeChat QR request failed.');

  const imageUrl = new URL('https://mp.weixin.qq.com/cgi-bin/showqrcode');
  imageUrl.searchParams.set('ticket', data.ticket);
  return {
    imageUrl: imageUrl.toString(),
    openUrl: /^https?:\/\/weixin\.qq\.com\/q\//.test(String(data.url || '')) ? data.url : '',
  };
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

export async function onRequest(context) {
  const { request, env } = context;
  const url = new URL(request.url);
  if (url.pathname !== '/wxbind') return new Response('Not Found', { status: 404 });

  if (request.method === 'GET') {
    if (!await isWechatRequest(request, env)) return new Response('Forbidden', { status: 403 });
    return new Response(url.searchParams.get('echostr') || '');
  }

  if (request.method !== 'POST') return new Response('Method Not Allowed', { status: 405 });

  if (url.searchParams.has('signature')) {
    if (!await isWechatRequest(request, env)) return new Response('Forbidden', { status: 403 });
    try {
      const binding = getSceneFromWechatEvent(await request.text());
      if (binding) await forwardBinding(binding, env);
      return new Response('success');
    } catch {
      return new Response('', { status: 502 });
    }
  }

  if (!sameText(getRequestToken(request), String(env.API_TOKEN || ''))) {
    return json({ msg: 'Invalid token' }, 403);
  }

  try {
    const body = await request.json().catch(() => ({}));
    const scene = String(body.scene || '');
    if (!/^[a-f0-9]{32}$/.test(scene)) return json({ msg: 'Invalid scene' }, 400);
    return json(await createQr(scene, env));
  } catch {
    return json({ msg: 'Unable to create binding QR' }, 502);
  }
}
