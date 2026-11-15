'use strict';
// Камера прямого эфира: скрытый браузер (Edge/Chrome) открывает страницу, которую читает агент,
// плавно прокручивает её и отдаёт кадры в интерфейс как MJPEG-видео.
// Браузер запускается с отдельным пустым профилем (без твоих cookies и паролей), загрузки и
// обращения к локальной сети/этому серверу заблокированы.
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

const PORT = 9377;
const sleep = ms => new Promise(r => setTimeout(r, ms));
const BLOCK = ['file://*', '*://localhost*', '*://127.*', '*://0.0.0.0*', '*://10.*', '*://192.168.*', '*://169.254.*', '*://[::1]*', '*://*.local/*', '*://*.internal/*',
  ...Array.from({ length: 16 }, (_, i) => `*://172.${16 + i}.*`)];
const SCROLL = '(()=>{clearInterval(window.__us);let n=0;window.__us=setInterval(()=>{window.scrollBy(0,3);if(++n>3000)clearInterval(window.__us)},40)})()';

function findBrowser() {
  if (process.env.BROWSER_BIN && fs.existsSync(process.env.BROWSER_BIN)) return process.env.BROWSER_BIN;
  const bases = [process.env['ProgramFiles(x86)'], process.env.ProgramFiles, process.env.LOCALAPPDATA].filter(Boolean);
  for (const rel of ['Microsoft\\Edge\\Application\\msedge.exe', 'Google\\Chrome\\Application\\chrome.exe'])
    for (const b of bases) { const f = path.join(b, rel); if (fs.existsSync(f)) return f; }
  return null;
}

function create({ dir, log }) {
  const bin = findBrowser();
  const viewers = new Set();
  let ws = null, proc = null, id = 0, ready = false, starting = false, last = null, want = null, cur = null, idleTimer = null, scrollTimer = null;

  const send = (method, params = {}) => { if (ws && ws.readyState === 1) ws.send(JSON.stringify({ id: ++id, method, params })); };
  const probe = async () => { try { return (await (await fetch(`http://127.0.0.1:${PORT}/json`, { signal: AbortSignal.timeout(800) })).json()).find(t => t.type === 'page') || null; } catch { return null; } };
  function broadcast(buf) {
    const head = `--frame\r\nContent-Type: image/jpeg\r\nContent-Length: ${buf.length}\r\n\r\n`;
    for (const res of viewers) { if (res.writableLength > 3e6) continue; res.write(head); res.write(buf); res.write('\r\n'); }
  }
  function nav(url) { cur = url; clearTimeout(scrollTimer); send('Page.navigate', { url }); }

  async function start() {
    if (!bin || ready || starting) return;
    starting = true;
    try {
      let tab = await probe(); // браузер мог остаться от прошлого запуска сервера — переиспользуем
      if (!tab) {
        fs.mkdirSync(dir, { recursive: true });
        proc = spawn(bin, ['--headless=new', '--disable-gpu', '--mute-audio', '--hide-scrollbars', '--no-first-run', '--no-default-browser-check', '--disable-extensions',
          '--disable-sync', '--disable-background-networking', '--disable-notifications', '--deny-permission-prompts', '--block-new-web-contents', '--disable-features=Translate',
          '--window-size=1280,720', `--remote-debugging-port=${PORT}`, `--user-data-dir=${dir}`, 'about:blank'], { stdio: 'ignore', windowsHide: true });
        proc.on('exit', () => { proc = null; });
        proc.on('error', e => log('cam', e.message));
        for (let i = 0; i < 30 && !tab; i++) { await sleep(500); tab = await probe(); }
      }
      if (!tab) throw new Error('браузер камеры не ответил');
      const sock = new WebSocket(tab.webSocketDebuggerUrl); ws = sock;
      sock.onopen = () => {
        ready = true; starting = false;
        send('Page.enable'); send('Network.enable'); send('Network.setBlockedURLs', { urls: BLOCK });
        send('Page.setDownloadBehavior', { behavior: 'deny' });
        send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 720, deviceScaleFactor: 1, mobile: false });
        send('Emulation.setDefaultBackgroundColorOverride', { color: { r: 255, g: 255, b: 255, a: 1 } }); // прозрачный фон страниц — белый, а не чёрный
        send('Page.startScreencast', { format: 'jpeg', quality: 62, maxWidth: 1280, maxHeight: 720, everyNthFrame: 2 });
        if (want && viewers.size) nav(want);
      };
      sock.onmessage = m => {
        let d; try { d = JSON.parse(m.data); } catch { return; }
        if (d.method === 'Page.screencastFrame') { send('Page.screencastFrameAck', { sessionId: d.params.sessionId }); last = Buffer.from(d.params.data, 'base64'); broadcast(last); }
        else if (d.method === 'Page.javascriptDialogOpening') send('Page.handleJavaScriptDialog', { accept: false });
        else if (d.method === 'Page.loadEventFired') { clearTimeout(scrollTimer); scrollTimer = setTimeout(() => send('Runtime.evaluate', { expression: SCROLL }), 1500); }
      };
      sock.onerror = () => {};
      sock.onclose = () => { if (ws === sock) { ws = null; ready = false; starting = false; if (viewers.size) setTimeout(start, 3000); } };
    } catch (e) { starting = false; log('cam', e.message); }
  }

  return {
    available: !!bin,
    viewers: () => viewers.size,
    // Показать страницу в эфире (только когда кто-то смотрит — иначе браузер простаивает)
    show(url) { want = url; if (!viewers.size) return; if (!ready) return void start(); if (url !== cur) nav(url); },
    addViewer(req, res) {
      res.writeHead(200, { 'Content-Type': 'multipart/x-mixed-replace; boundary=frame', 'Cache-Control': 'no-store', Connection: 'close' });
      viewers.add(res); clearTimeout(idleTimer);
      if (last) broadcast(last);
      if (!ready) start(); else if (want && want !== cur) nav(want);
      req.on('close', () => {
        viewers.delete(res);
        if (!viewers.size) idleTimer = setTimeout(() => { if (ready && !viewers.size) nav('about:blank'); }, 30000);
      });
    },
    stop() { try { if (ws) ws.close(); } catch {} try { if (proc) proc.kill(); } catch {} }
  };
}

module.exports = { create };
