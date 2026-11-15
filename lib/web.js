'use strict';
// Веб-инструменты агентов: поиск и чтение страниц. Защита от SSRF, учёт robots.txt, вежливые паузы.
const dns = require('dns').promises;
const net = require('net');

const UA = 'Mozilla/5.0 (compatible; UltraSquadBot/1.0; local research agent)';
const sleep = ms => new Promise(r => setTimeout(r, ms));

// ---------- SSRF ----------
function privateV4(ip) {
  const [a, b] = ip.split('.').map(Number);
  return a === 0 || a === 10 || a === 127 || a >= 224 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127) || (a === 192 && b === 0);
}
function isPrivate(ip) {
  if (net.isIPv4(ip)) return privateV4(ip);
  const l = ip.toLowerCase();
  if (l === '::1' || l === '::' || l.startsWith('fc') || l.startsWith('fd') || l.startsWith('fe8') || l.startsWith('fe9') || l.startsWith('fea') || l.startsWith('feb')) return true;
  const m = l.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/); return m ? privateV4(m[1]) : false;
}
async function safeUrl(u) {
  const url = new URL(u);
  if (!/^https?:$/.test(url.protocol)) throw new Error('Только http/https');
  if (url.username || url.password) throw new Error('URL с логином запрещён');
  const host = url.hostname.replace(/^\[|\]$/g, '');
  if (host === 'localhost' || host.endsWith('.local') || host.endsWith('.internal')) throw new Error('Локальный адрес запрещён');
  const addrs = net.isIP(host) ? [{ address: host }] : await dns.lookup(host, { all: true });
  if (!addrs.length || addrs.some(a => isPrivate(a.address))) throw new Error('Приватный адрес запрещён');
  return url;
}

// ---------- вежливость ----------
const lastHit = new Map();
async function politeGap(host, gap = 2000) {
  const wait = Math.max(0, (lastHit.get(host) || 0) + gap - Date.now());
  lastHit.set(host, Date.now() + wait);
  if (wait) await sleep(wait);
}
const robotsCache = new Map();
async function robotsAllowed(url) {
  const origin = url.origin; let rules = robotsCache.get(origin);
  if (!rules || Date.now() - rules.ts > 3600000) {
    rules = { ts: Date.now(), dis: [], allow: [] };
    try {
      const r = await fetch(origin + '/robots.txt', { headers: { 'User-Agent': UA }, signal: AbortSignal.timeout(5000), redirect: 'follow' });
      if (r.ok && /text/.test(r.headers.get('content-type') || 'text')) {
        let on = false;
        for (const raw of (await r.text()).slice(0, 100000).split(/\r?\n/)) {
          const line = raw.replace(/#.*/, '').trim(); const i = line.indexOf(':'); if (i < 0) continue;
          const k = line.slice(0, i).trim().toLowerCase(), v = line.slice(i + 1).trim();
          if (k === 'user-agent') on = v === '*' || /ultrasquad/i.test(v);
          else if (on && k === 'disallow' && v) rules.dis.push(v);
          else if (on && k === 'allow' && v) rules.allow.push(v);
        }
      }
    } catch {}
    robotsCache.set(origin, rules);
  }
  // Шаблоны robots.txt: * — любая последовательность, $ — конец пути. Побеждает самое длинное правило.
  const p = url.pathname + url.search;
  const hit = pat => { try { return new RegExp('^' + pat.replace(/[.+?^{}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\\?\$$/, '$')).test(p); } catch { return false; } };
  const d = rules.dis.filter(hit).sort((a, b) => b.length - a.length)[0];
  if (!d) return true;
  const a = rules.allow.filter(hit).sort((x, y) => y.length - x.length)[0];
  return !!a && a.length >= d.length;
}

// ---------- HTML -> текст ----------
const ENT = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', mdash: '—', ndash: '–', hellip: '…', laquo: '«', raquo: '»', copy: '©' };
const decode = s => s.replace(/&(#x?[0-9a-f]+|[a-z]+);/gi, (m, e) => {
  if (e[0] === '#') { const n = e[1].toLowerCase() === 'x' ? parseInt(e.slice(2), 16) : +e.slice(1); try { return String.fromCodePoint(n); } catch { return ''; } }
  return ENT[e.toLowerCase()] ?? m;
});
const clean = s => decode(s.replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim();

function extract(html, base) {
  const title = clean((html.match(/<title[^>]*>([\s\S]*?)<\/title>/i) || [, ''])[1]).slice(0, 200);
  const h = html.replace(/<!--[\s\S]*?-->/g, '').replace(/<(script|style|noscript|svg|template|iframe)\b[\s\S]*?<\/\1>/gi, '');
  const main = h.match(/<(main|article)\b[\s\S]*?<\/\1>/i);
  const body = main ? main[0] : h.replace(/<(nav|footer|aside|header|form)\b[\s\S]*?<\/\1>/gi, '');
  // Основной текст — абзацы; меню и служебные блоки так отсекаются сами
  const pHtml = [...body.matchAll(/<p\b[^>]*>([\s\S]*?)<\/p>/gi)].map(m => m[1]);
  const paras = pHtml.map(p => clean(p).replace(/\[\s*\d+\s*\]/g, '')).filter(p => p.length >= 60);
  let text = paras.join('\n\n');
  const rich = text.length >= 300;
  if (!rich) text = decode(body.replace(/<\/?(p|div|li|h[1-6]|tr|section|br|ul|ol|table|blockquote)\b[^>]*>/gi, '\n').replace(/<[^>]+>/g, ' '))
    .split('\n').map(l => l.replace(/\s+/g, ' ').trim()).filter(l => l.length > 2).join('\n');
  const grab = src => {
    const out = [], seen = new Set();
    for (const m of src.matchAll(/<a\s[^>]*?href\s*=\s*["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi)) {
      let u; try { u = new URL(decode(m[1]), base); } catch { continue; }
      if (!/^https?:$/.test(u.protocol)) continue; u.hash = '';
      const t = clean(m[2]).slice(0, 90); if (t.length < 4 || seen.has(u.href)) continue;
      seen.add(u.href); out.push({ text: t, url: u.href });
      if (out.length >= 40) break;
    }
    return out;
  };
  let links = rich ? grab(pHtml.join(' ')) : [];
  if (links.length < 5) links = grab(body); if (links.length < 5) links = grab(h);
  return { title, text, links };
}

async function fetchPage(start, { maxBytes = 1200000, timeout = 12000 } = {}) {
  let u = start;
  for (let hop = 0; hop < 5; hop++) {
    const url = await safeUrl(u);
    if (!(await robotsAllowed(url))) throw new Error('robots.txt запрещает: ' + url.hostname);
    await politeGap(url.hostname);
    const r = await fetch(url, { redirect: 'manual', signal: AbortSignal.timeout(timeout),
      headers: { 'User-Agent': UA, Accept: 'text/html,application/xhtml+xml,text/plain;q=0.8', 'Accept-Language': 'en,ru;q=0.8' } });
    if (r.status >= 300 && r.status < 400 && r.headers.get('location')) { u = new URL(r.headers.get('location'), url).href; continue; }
    if (!r.ok) throw new Error('HTTP ' + r.status);
    const ct = (r.headers.get('content-type') || '').toLowerCase();
    if (!/text\/html|xhtml|text\/plain/.test(ct)) return { url: url.href, host: url.hostname, title: url.pathname.split('/').pop() || url.hostname, text: `[файл ${ct || 'неизвестного типа'} — пропущен]`, links: [] };
    const reader = r.body.getReader(); const chunks = []; let n = 0;
    while (true) { const { done, value } = await reader.read(); if (done) break; chunks.push(value); n += value.length; if (n > maxBytes) { reader.cancel().catch(() => {}); break; } }
    const buf = Buffer.concat(chunks);
    let cs = (ct.match(/charset=([\w-]+)/) || [])[1] || (buf.subarray(0, 3000).toString('latin1').match(/<meta[^>]+charset=["']?([\w-]+)/i) || [])[1] || 'utf-8';
    let html; try { html = new TextDecoder(cs).decode(buf); } catch { html = buf.toString('utf8'); }
    const ex = /text\/plain/.test(ct) ? { title: url.hostname, text: html.slice(0, 20000), links: [] } : extract(html, url.href);
    return { url: url.href, host: url.hostname, title: ex.title || url.hostname, text: ex.text.slice(0, 20000), links: ex.links };
  }
  throw new Error('Слишком много редиректов');
}

// ---------- поиск ----------
// Открытые API, разрешающие программный доступ (поисковики с защитой от ботов не обходим).
async function hn(q) {
  const get = async extra => {
    const r = await fetch('https://hn.algolia.com/api/v1/search?tags=story&hitsPerPage=10&query=' + encodeURIComponent(q) + extra, { headers: { 'User-Agent': UA }, signal: AbortSignal.timeout(10000) });
    if (!r.ok) throw new Error('HN ' + r.status);
    return r.json();
  };
  // сначала свежее (за последние полтора года), если мало — за всё время
  let j = await get('&numericFilters=created_at_i>' + Math.floor(Date.now() / 1000 - 47304000));
  if ((j.hits || []).filter(h => h.url).length < 3) j = await get('');
  return (j.hits || []).filter(h => /^https?:\/\//.test(h.url || '')).map(h => ({ title: String(h.title || '').slice(0, 140), url: h.url, snippet: `Hacker News · ${h.points || 0} очков · ${(h.created_at || '').slice(0, 10)}` }));
}
async function wiki(q) {
  const lang = /[а-яё]/i.test(q) ? 'ru' : 'en';
  const r = await fetch(`https://${lang}.wikipedia.org/w/api.php?action=query&list=search&srsearch=${encodeURIComponent(q)}&srlimit=8&format=json`, { headers: { 'User-Agent': UA }, signal: AbortSignal.timeout(10000) });
  const j = await r.json();
  return (j.query?.search || []).map(s => ({ title: s.title, url: `https://${lang}.wikipedia.org/wiki/${encodeURIComponent(s.title.replace(/ /g, '_'))}`, snippet: clean(s.snippet).slice(0, 220) }));
}
async function search(q, retry = true) {
  const words = q.trim().split(/\s+/);
  const [a, b] = await Promise.allSettled([hn(q), wiki(q)]);
  const none = r => r.status !== 'fulfilled' || !r.value.length;
  if (none(a) && none(b) && retry && words.length > 3) return search(words.slice(0, 3).join(' '), false); // длинный запрос — сокращаем
  const A = a.status === 'fulfilled' ? a.value : [], B = b.status === 'fulfilled' ? b.value : [];
  const items = [];
  for (let i = 0; i < 6 && items.length < 9; i++) { if (A[i]) items.push(A[i]); if (B[i]) items.push(B[i]); }
  if (!items.length) throw new Error('Поиск ничего не нашёл: ' + q);
  return { engine: [A.length && 'hacker news', B.length && 'wikipedia'].filter(Boolean).join(' + '), items };
}

module.exports = { search, fetchPage, safeUrl, isPrivate };
