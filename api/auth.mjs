import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

const site = 'https://ultrasquad.vercel.app';
const path = '/api/auth';
const flowCookie = '__Host-us_oauth';
const sessionCookie = '__Host-us_session';
const providers = {
  google: {
    prefix: 'GOOGLE',
    authorize: 'https://accounts.google.com/o/oauth2/v2/auth',
    token: 'https://oauth2.googleapis.com/token',
    profile: 'https://openidconnect.googleapis.com/v1/userinfo',
    scope: 'openid profile',
    identity: data => typeof data.sub === 'string' && data.sub
      ? { id: data.sub, name: data.name || 'Google', provider: 'google' } : null
  },
  github: {
    prefix: 'GITHUB',
    authorize: 'https://github.com/login/oauth/authorize',
    token: 'https://github.com/login/oauth/access_token',
    profile: 'https://api.github.com/user',
    scope: '',
    identity: data => Number.isSafeInteger(data.id) && data.id > 0 && data.login
      ? { id: String(data.id), name: data.login, provider: 'github' } : null
  }
};

function configuration() {
  const key = process.env.AUTH_SESSION_SECRET || '';
  if (Buffer.byteLength(key) < 32) return { key: null, active: {} };
  const active = {};
  for (const [name, provider] of Object.entries(providers)) {
    const id = process.env[provider.prefix + '_CLIENT_ID'];
    const secret = process.env[provider.prefix + '_CLIENT_SECRET'];
    if (id && secret) active[name] = { ...provider, id, secret };
  }
  return { key, active };
}

const encode = value => Buffer.from(JSON.stringify(value)).toString('base64url');
const signature = (key, purpose, payload) => createHmac('sha256', key).update(purpose + '.' + payload).digest('base64url');
const seal = (key, purpose, value) => {
  const payload = encode(value);
  return payload + '.' + signature(key, purpose, payload);
};

function equal(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  const first = Buffer.from(a), second = Buffer.from(b);
  return first.length === second.length && timingSafeEqual(first, second);
}

function unseal(key, purpose, value) {
  if (!key || !value || !/^[\w-]+\.[\w-]+$/.test(value) || value.length > 3500) return null;
  const [payload, mac] = value.split('.');
  if (!equal(mac, signature(key, purpose, payload))) return null;
  try {
    const decoded = JSON.parse(Buffer.from(payload, 'base64url').toString());
    return decoded.exp > Date.now() ? decoded : null;
  } catch { return null; }
}

const cookie = (name, value, age) => name + '=' + value + '; Path=/; Max-Age=' + age + '; Secure; HttpOnly; SameSite=Lax';
const clear = name => cookie(name, '', 0);
const readCookies = req => Object.fromEntries((req.headers.cookie || '').split(';').map(x => x.trim().split('=', 2)).filter(pair => pair.length === 2));
const callback = name => site + path + '?action=callback&provider=' + name;
const landing = result => '/?auth=' + result;
function redirect(res, location, cookies = []) {
  res.setHeader('Location', location);
  if (cookies.length) res.setHeader('Set-Cookie', cookies);
  return res.status(303).end();
}

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Referrer-Policy', 'no-referrer');
  const params = new URL(req.url, site).searchParams;
  const action = params.get('action') || 'session';
  const cookies = readCookies(req);
  const { key, active } = configuration();
  const available = Object.keys(active);
  if (action === 'logout') {
    if (req.method !== 'POST') return res.status(405).end();
    if (req.headers.origin !== site) return res.status(403).end();
    return redirect(res, '/', [clear(flowCookie), clear(sessionCookie)]);
  }
  if (req.method !== 'GET') return res.status(405).end();
  if (action === 'session') {
    const session = unseal(key, 'session', cookies[sessionCookie]);
    const user = session && Object.hasOwn(active, session.user.provider) ? session.user : null;
    return res.status(200).json({ configured: !!available.length, providers: available, user });
  }

  const provider = params.get('provider');
  if (!['login', 'callback'].includes(action) || !['google', 'github'].includes(provider)) return res.status(400).end();
  const settings = active[provider];
  if (!settings) return redirect(res, landing('unavailable'));

  if (action === 'login') {
    if (!['same-origin', 'none', undefined].includes(req.headers['sec-fetch-site'])) return res.status(403).end();
    const verifier = randomBytes(32).toString('base64url');
    const state = randomBytes(32).toString('base64url');
    const challenge = createHash('sha256').update(verifier).digest('base64url');
    const authorize = new URL(settings.authorize);
    authorize.search = new URLSearchParams({
      client_id: settings.id, redirect_uri: callback(provider), response_type: 'code',
      scope: settings.scope, state, code_challenge: challenge, code_challenge_method: 'S256'
    });
    const flow = seal(key, 'oauth', { provider, verifier, state, exp: Date.now() + 600_000 });
    return redirect(res, authorize.href, [cookie(flowCookie, flow, 600)]);
  }

  const flow = unseal(key, 'oauth', cookies[flowCookie]);
  const code = params.get('code');
  if (!flow || flow.provider !== provider || !equal(flow.state, params.get('state')) || !code || code.length > 2048) {
    return redirect(res, landing('failed'), [clear(flowCookie)]);
  }
  try {
    const token = await fetch(settings.token, {
      method: 'POST', redirect: 'error', signal: AbortSignal.timeout(8000),
      headers: { Accept: 'application/json', 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: settings.id, client_secret: settings.secret, code, code_verifier: flow.verifier,
        redirect_uri: callback(provider), grant_type: 'authorization_code'
      })
    });
    if (!token.ok) throw new Error('OAuth token');
    const { access_token: access } = await token.json();
    if (typeof access !== 'string' || !access) throw new Error('OAuth access token');
    const profile = await fetch(settings.profile, {
      redirect: 'error', signal: AbortSignal.timeout(5000),
      headers: { Accept: 'application/json', Authorization: 'Bearer ' + access, 'User-Agent': 'UltraSquad' }
    });
    if (!profile.ok) throw new Error('OAuth profile');
    const user = settings.identity(await profile.json());
    if (!user) throw new Error('OAuth identity');
    user.name = String(user.name).slice(0, 120);
    const session = seal(key, 'session', { user, exp: Date.now() + 3_600_000 });
    return redirect(res, landing('ok'), [clear(flowCookie), cookie(sessionCookie, session, 3600)]);
  } catch {
    return redirect(res, landing('failed'), [clear(flowCookie)]);
  }
}

