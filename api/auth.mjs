import { createHash, randomBytes } from 'node:crypto';

const site = 'https://ultrasquad.vercel.app';
const route = '/api/auth';
const config = () => {
  const key = process.env.SUPABASE_PUBLISHABLE_KEY;
  const url = process.env.SUPABASE_URL?.replace(/\/+$/, '');
  return key?.startsWith('sb_publishable_') && /^https:\/\/[a-z0-9]+\.supabase\.co$/.test(url || '') ? { key, url } : null;
};
const cookie = (name, value, age) => name + '=' + value + '; Path=' + route + '; Max-Age=' + age + '; Secure; HttpOnly; SameSite=Lax';
const clear = name => cookie(name, '', 0);
const readCookies = req => Object.fromEntries((req.headers.cookie || '').split(';').map(x => x.trim().split('=', 2)).filter(pair => pair.length === 2));
const redirect = (res, to, cookies = []) => {
  res.setHeader('Location', to);
  if (cookies.length) res.setHeader('Set-Cookie', cookies);
  res.status(303).end();
};
const landing = result => '/?auth=' + result;

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Referrer-Policy', 'no-referrer');
  const request = new URL(req.url, site);
  const action = request.searchParams.get('action') || 'session';
  if (action === 'logout') {
    if (req.method !== 'POST') return res.status(405).end();
    if (req.headers.origin !== site) return res.status(403).end();
    return redirect(res, '/', [clear('us_access'), clear('us_verifier')]);
  }

  if (req.method !== 'GET') return res.status(405).end();
  const settings = config();
  if (action === 'session' && !settings) return res.status(200).json({ configured: false });
  if (!settings) return redirect(res, landing('unavailable'));

  if (action === 'login') {
    if (!['same-origin', 'none', undefined].includes(req.headers['sec-fetch-site'])) return res.status(403).end();
    const provider = request.searchParams.get('provider');
    if (!['google', 'github'].includes(provider)) return res.status(400).end();
    const verifier = randomBytes(32).toString('base64url');
    const challenge = createHash('sha256').update(verifier).digest('base64url');
    const authorize = new URL(settings.url + '/auth/v1/authorize');
    authorize.search = new URLSearchParams({
      provider, code_challenge: challenge, code_challenge_method: 's256',
      redirect_to: site + route + '?action=callback'
    });
    return redirect(res, authorize.href, [cookie('us_verifier', verifier, 600)]);
  }

  const cookies = readCookies(req);
  try {
    if (action === 'callback') {
      const code = request.searchParams.get('code');
      const verifier = cookies.us_verifier;
      if (!code || !/^[a-zA-Z0-9_-]{43}$/.test(verifier || '')) return redirect(res, landing('failed'), [clear('us_verifier')]);
      const response = await fetch(settings.url + '/auth/v1/token?grant_type=pkce', {
        method: 'POST', redirect: 'error', signal: AbortSignal.timeout(8000),
        headers: { apikey: settings.key, 'Content-Type': 'application/json' },
        body: JSON.stringify({ auth_code: code, code_verifier: verifier })
      });
      const session = response.ok ? await response.json() : null;
      if (!session || !/^[\w.-]{1,3600}$/.test(session.access_token || '')) return redirect(res, landing('failed'), [clear('us_verifier')]);
      const age = Math.min(3600, Math.max(1, Number(session.expires_in) || 1));
      return redirect(res, landing('ok'), [clear('us_verifier'), cookie('us_access', session.access_token, age)]);
    }
    if (action !== 'session') return res.status(404).end();
    if (!cookies.us_access) return res.status(200).json({ configured: true, user: null });
    const response = await fetch(settings.url + '/auth/v1/user', {
      redirect: 'error', signal: AbortSignal.timeout(5000),
      headers: { apikey: settings.key, Authorization: 'Bearer ' + cookies.us_access }
    });
    if (!response.ok) {
      if (response.status === 401 || response.status === 403) res.setHeader('Set-Cookie', clear('us_access'));
      return res.status(200).json({ configured: true, user: null });
    }
    const user = await response.json();
    return res.status(200).json({ configured: true, user: user.id && !user.is_anonymous ? { email: user.email || 'Аккаунт подключён' } : null });
  } catch {
    if (action === 'callback') return redirect(res, landing('failed'), [clear('us_verifier')]);
    return res.status(503).json({ configured: true, error: 'Сервис входа временно недоступен' });
  }
}

