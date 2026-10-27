'use strict';
const $ = s => document.querySelector(s), $$ = s => [...document.querySelectorAll(s)];
const badge = $('#badge'), stage = $('#stage'), root = document.documentElement;
const target = new URLSearchParams(location.search).get('v');
const isHost = !target;
document.body.classList.add(isHost ? 'host' : 'viewer');
/* Endereço do Worker que gera credenciais TURN temporárias (pasta worker/).
   Vazio: usa o servidor público gratuito como antes. */
const TURN_URL = '';
const FALLBACK_ICE = [
  {urls: 'stun:stun.l.google.com:19302'}, {urls: 'stun:stun1.l.google.com:19302'},
  {urls: ['turn:openrelay.metered.ca:80', 'turn:openrelay.metered.ca:443', 'turn:openrelay.metered.ca:443?transport=tcp'], username: 'openrelayproject', credential: 'openrelayproject'}
];
const ICE = {iceServers: FALLBACK_ICE};
let relayName = 'servidor público', iceT = 0;
/* Busca credenciais novas. Em falha mantém as atuais (ou as públicas) e tenta de novo depois. */
async function loadIce() {
  clearTimeout(iceT);
  if (!TURN_URL) return;
  let ttl = 0;
  try {
    const ac = new AbortController(), t = setTimeout(() => ac.abort(), 5000);
    const r = await fetch(TURN_URL, {signal: ac.signal, cache: 'no-store'}); clearTimeout(t);
    const d = await r.json();
    if (!r.ok || !Array.isArray(d.iceServers) || !d.iceServers.length) throw new Error(d.error || r.status);
    ICE.iceServers = d.iceServers; relayName = 'Cloudflare'; ttl = d.ttl || 43200;
    if (peer && peer.options) peer.options.config = {iceServers: ICE.iceServers};
  } catch (e) {
    console.warn('TURN: usando o servidor público.', e);
  }
  /* renova 1 hora antes de expirar; sem sucesso, tenta de novo em 5 minutos */
  iceT = setTimeout(loadIce, ttl ? Math.max(600, ttl - 3600) * 1000 : 300000);
}
/* ---------- Mudança de endereço ----------
   O site saiu de geraldogg77.github.io/cineminha para cineminha.online. No endereço antigo, assim que o
   novo responde, a página leva a pessoa para lá com o apelido, as configurações e o código da sala,
   para os convites antigos continuarem valendo. Aqui, no endereço novo, recebe esses dados uma vez. */
const NEW_HOME = 'https://cineminha.online/', ON_OLD = /\.github\.io$/.test(location.hostname);
(function migrateIn() {
  const m = location.hash.match(/^#mig=([A-Za-z0-9_-]+)$/); if (!m) return;
  try {
    const d = JSON.parse(decodeURIComponent(escape(atob(m[1].replace(/-/g, '+').replace(/_/g, '/')))));
    if (typeof d.id === 'string' && /^tl[a-z0-9]{4,20}$/.test(d.id) && !localStorage.getItem('tl-id')) localStorage.setItem('tl-id', d.id);
    if (typeof d.name === 'string' && d.name && !localStorage.getItem('tl-name')) localStorage.setItem('tl-name', d.name.slice(0, 20));
    if (d.set && typeof d.set === 'object' && !localStorage.getItem('tl-set')) localStorage.setItem('tl-set', JSON.stringify(d.set));
  } catch (e) {}
  history.replaceState(null, '', location.pathname + location.search);
})();
const RES = {720: [1280, 720], 1080: [1920, 1080], 1440: [2560, 1440], 2160: [3840, 2160]};
const PRE = {
  bal: {res: 1080, fps: 30, br: 6, prio: 'motion'}, alta: {res: 1080, fps: 60, br: 12, prio: 'motion'},
  max: {res: 1080, fps: 60, br: 25, prio: 'motion'}, txt: {res: 1080, fps: 30, br: 10, prio: 'detail'}
};
const S = {theme: 'dark', accent: '#5B7CFA', calm: false, res: 1080, fps: 60, br: 12, prio: 'motion', codec: 'auto', abr: 320, max: 2,
  mxScreen: true, vScreen: 100, mxMic: false, vMic: 100, micDev: '', mxExtra: false, vExtra: 100, extDev: '',
  mxApps: false, vApps: 100, appPrefs: {}, helperSeen: false, outDev: '', vVoice: 100, src: 'screen', camDev: ''};
try { Object.assign(S, JSON.parse(localStorage.getItem('tl-set') || '{}')); } catch (e) {}
if (!['dark', 'classic', 'oled', 'light'].includes(S.theme)) S.theme = 'dark';
if (!['screen', 'cam'].includes(S.src)) S.src = 'screen';
S.max = Math.min(10, Math.max(1, +S.max || 2));
if (!/^#[0-9a-f]{6}$/i.test(S.accent)) S.accent = '#5B7CFA';
/* versão 8 tinha âmbar como padrão: quem ficou com ele sem escolher volta ao azul uma única vez */
try { if (!localStorage.getItem('tl-acc2')) { if (S.accent.toUpperCase() === '#F2B544') S.accent = '#5B7CFA'; localStorage.setItem('tl-acc2', '1'); } } catch (e) {}
let peer, myId = '', hostConn = null, me = '', full = false, paused = false, last = {}, retryT = 0, unread = 0, roomReady = false;
/* minha transmissão: stream = vídeo + áudio mixado (vai para quem assiste); preview = só o vídeo (para eu ver) */
let stream = null, disp = null, preview = null, camMode = false, goState = false, tabAudio = false;
const outCalls = new Map();      // quem está assistindo minha tela: id → chamada
const guests = new Map();        // só no anfitrião: id → {conn, name, av, live}
let focus = null, wantMuted = true, soundOk = false, deaf = false, scrVol = 1, myCam = null;
const scr = new Map();     // telas que recebo: id → {call, stream, q}
const cams = new Map();    // câmeras que recebo: id → {call, stream}
const camOut = new Map();  // minha câmera indo para cada pessoa: id → chamada
const clean = s => String(s || '').trim().slice(0, 20);
const hue = n => { let h = 0; for (const c of n) h = (h * 31 + c.charCodeAt(0)) % 360; return h; };
const playV = v => { const p = v.play(); if (p) p.catch(() => { if (!v.muted) { wantMuted = true; soundOk = false; v.muted = true; needSound(); v.play().catch(() => {}); } }); };
/* mostra "Ativar som" quando o navegador (principalmente no celular) bloqueou o som até um toque */
function needSound() { soundOk = false; const b = document.querySelector('#sound'); if (b) b.hidden = false; if (typeof syncVol === 'function') syncVol(); }
/* iPhone: sem isso, a página obedece à chave de silencioso e o som pode sair pelo alto-falante de ligação */
function audioSession() { try { if (navigator.audioSession) navigator.audioSession.type = VO.on ? 'play-and-record' : 'playback'; } catch (e) {} }
const narrow = () => matchMedia('(max-width:900px)').matches;

/* ---------- Fotos de perfil: imagens e GIFs de até 15 MB ----------
   A foto fica no IndexedDB deste navegador. Pela sala só viaja um código (hash) de cada foto;
   quem ainda não tem uma foto pede ao anfitrião, que repassa em pedaços uma única vez, e cada
   navegador guarda as fotos recebidas para as próximas visitas. */
const APP_VER = 28;   // igual ao ?v= do app.js no index.html
const AV_MAX = 15 * 1024 * 1024, AV_CHUNK = 64 * 1024, AV_LEGACY = 600 * 1024;
const avatars = {};             // nome → hash da foto
const avStill = {};             // hash → primeiro quadro do GIF (parado)
const talkNames = new Set();    // quem está falando agora: o GIF dessas pessoas se mexe
const avUrl = {}, avType = {}, avThumb = {}, avData = {};  // hash → endereço, tipo, miniatura estática, texto (versão antiga)
let myAv = '', myAvH = '';
const okH = h => typeof h === 'string' && /^[0-9a-f]{32}$/.test(h) ? h : '';
const IDB = (() => {
  let dbp = null;
  const open = () => dbp || (dbp = new Promise((res, rej) => {
    const r = indexedDB.open('cineminha', 1);
    r.onupgradeneeded = () => r.result.createObjectStore('av');
    r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error);
  }));
  const tx = async (mode, fn) => { const db = await open(); return new Promise((res, rej) => { const t = db.transaction('av', mode), q = fn(t.objectStore('av')); t.oncomplete = () => res(q && q.result); t.onerror = t.onabort = () => rej(t.error); }); };
  return {get: k => tx('readonly', s => s.get(k)).catch(() => null), set: (k, v) => tx('readwrite', s => s.put(v, k)).catch(() => {}), del: k => tx('readwrite', s => s.delete(k)).catch(() => {})};
})();
async function sha(buf) { const d = new Uint8Array(await crypto.subtle.digest('SHA-256', buf)); return [...d.slice(0, 16)].map(b => b.toString(16).padStart(2, '0')).join(''); }
/* confere pelo conteúdo que o arquivo é mesmo uma imagem */
function sniff(buf) {
  const u = new Uint8Array(buf, 0, Math.min(12, buf.byteLength)), s = String.fromCharCode(...u);
  return s.startsWith('GIF8') ? 'image/gif' : u[0] === 0x89 && s.slice(1, 4) === 'PNG' ? 'image/png' : u[0] === 0xFF && u[1] === 0xD8 ? 'image/jpeg' : s.startsWith('RIFF') && s.slice(8, 12) === 'WEBP' ? 'image/webp' : '';
}
function avRegister(h, buf, type) {
  if (avUrl[h]) return avUrl[h];
  avType[h] = type; avUrl[h] = URL.createObjectURL(new Blob([buf], {type}));
  /* quem ainda está na versão antiga do site só entende a foto como texto, até 600 KB */
  if (buf.byteLength <= AV_LEGACY) { const fr = new FileReader(); fr.onload = () => { avData[h] = fr.result; }; fr.readAsDataURL(new Blob([buf], {type})); }
  /* miniatura estática para o fundo desfocado dos quadrados: borrar um GIF animado grande pesa no computador */
  const img = new Image();
  img.onload = () => {
    const s = Math.min(img.width, img.height), sx = (img.width - s) / 2, sy = (img.height - s) / 2;
    const c = document.createElement('canvas'); c.width = c.height = 64;
    c.getContext('2d').drawImage(img, sx, sy, s, s, 0, 0, 64, 64);
    try { avThumb[h] = c.toDataURL('image/jpeg', .7); } catch (e) {}
    if (type === 'image/gif') {
      /* primeiro quadro do GIF: é o que aparece enquanto a pessoa não fala */
      const z = Math.min(256, s), f = document.createElement('canvas'); f.width = f.height = z;
      f.getContext('2d').drawImage(img, sx, sy, s, s, 0, 0, z, z);
      f.toBlob(b => { if (b) { avStill[h] = URL.createObjectURL(b); avRefresh(); } }, 'image/webp', .9);
    } else if (roomReady) render();
  };
  img.src = avUrl[h];
  return avUrl[h];
}
const pic = (el, src) => { if (el.dataset.src === src) return; el.dataset.src = src; el.textContent = ''; el.style.background = 'center/cover no-repeat url("' + src + '")'; };
const initial = (el, n) => { el.dataset.src = ''; el.textContent = (n[0] || '?').toUpperCase(); el.style.background = 'hsl(' + hue(n) + ',42%,40%)'; };
/* endereço da foto: GIF animado só enquanto a pessoa fala; parado, mostra o primeiro quadro */
function avSrc(h, anim) {
  if (!h || !avUrl[h]) return '';
  if (anim || avType[h] !== 'image/gif') return avUrl[h];
  return avStill[h] || '';
}
const avatar = (el, n) => {
  el.dataset.avn = n;
  const src = avSrc(n === me && myAvH ? myAvH : avatars[n], talkNames.has(n));
  src ? pic(el, src) : initial(el, n);
};
function paintMe() {
  const n = me || clean($('#ni') && $('#ni').value) || '?';
  $$('.mepic').forEach(el => {
    /* na escolha da foto o GIF sempre se mexe, para você ver como ele fica */
    if (el.classList.contains('pick')) { myAv ? pic(el, myAv) : initial(el, n); return; }
    if (me) avatar(el, me); else { const src = avSrc(myAvH, false); src ? pic(el, src) : initial(el, n); }
  });
}
function avRefresh() {
  paintMe();
  $$('.msg .av[data-n]').forEach(a => avatar(a, a.dataset.n));
  if (roomReady) { renderMembers(); render(); }
}
async function loadAvatar(file) {
  if (!file || !file.type.startsWith('image/')) throw 'Escolha um arquivo de imagem.';
  const gif = file.type === 'image/gif';
  if (gif && file.size <= AV_MAX) {
    const buf = await file.arrayBuffer();
    if (sniff(buf) !== 'image/gif') throw 'Esse arquivo não é um GIF válido.';
    return {buf, type: 'image/gif'};
  }
  /* imagem comum, ou GIF acima de 15 MB: recorta um quadrado de 256 px */
  const url = URL.createObjectURL(file);
  try {
    const img = await new Promise((res, rej) => { const i = new Image(); i.onload = () => res(i); i.onerror = () => rej('Não foi possível abrir essa imagem.'); i.src = url; });
    const c = document.createElement('canvas'); c.width = c.height = 256; const s = Math.min(img.width, img.height);
    c.getContext('2d').drawImage(img, (img.width - s) / 2, (img.height - s) / 2, s, s, 0, 0, 256, 256);
    if (gif) toast('GIF acima de 15 MB: foi usado só o primeiro quadro.', 'info');
    const blob = await new Promise(r => c.toBlob(r, 'image/webp', .88));
    return {buf: await blob.arrayBuffer(), type: blob.type || 'image/webp'};
  } finally { URL.revokeObjectURL(url); }
}
/* foto que chegou de alguém na versão antiga (texto data:image) */
const legacyH = {};
async function avFromData(str) {
  if (typeof str !== 'string' || str.length > 900000 || !/^data:image\/(png|jpe?g|gif|webp);base64,[A-Za-z0-9+/=]+$/.test(str)) return '';
  const key = str.length + ':' + str.slice(-64);
  if (legacyH[key]) return legacyH[key];
  try {
    const buf = await (await fetch(str)).arrayBuffer(), type = sniff(buf); if (!type) return '';
    const h = await sha(buf); avRegister(h, buf, type); legacyH[key] = h; return h;
  } catch (e) { return ''; }
}
async function useMine(buf, type, announce) {
  const h = await sha(buf);
  myAvH = h; myAv = avRegister(h, buf, type);
  avRefresh();
  if (announce && me) setTimeout(() => toRoom({t: 'profile', avh: h, av: avData[h] || '', ver: APP_VER}), 50);
}
async function setAv(rec) {
  if (!rec) {
    myAv = ''; myAvH = ''; await IDB.del('me'); avRefresh();
    if (me) toRoom({t: 'profile', avh: ''});
    return;
  }
  await IDB.set('me', rec);
  await useMine(rec.buf, rec.type, true);
  toast(rec.type === 'image/gif' ? 'GIF de perfil atualizado' : 'Foto atualizada', 'ok');
}
/* foto salva: no IndexedDB; versões antigas do site guardavam no localStorage como texto */
(async () => {
  let rec = await IDB.get('me');
  if (!rec) {
    try {
      const old = localStorage.getItem('tl-av');
      if (old && old.startsWith('data:image/')) {
        const buf = await (await fetch(old)).arrayBuffer(), type = sniff(buf);
        if (type) { rec = {buf, type}; await IDB.set('me', rec); localStorage.removeItem('tl-av'); }
      }
    } catch (e) {}
  }
  if (rec && rec.buf) await useMine(rec.buf, rec.type, true);
})();

/* ---------- Troca das fotos pela sala ---------- */
const avWant = new Map(), avIn = {}, avWait = {}, avAsked = new Set();  // avWant: hash → quando pedi
async function avSave(h, buf, type) {
  await IDB.set('h:' + h, {buf, type});
  const list = ((await IDB.get('idx')) || []).filter(x => x.h !== h);
  list.push({h, s: buf.byteLength, t: Date.now()});
  list.sort((a, b) => a.t - b.t);
  let total = list.reduce((a, x) => a + x.s, 0);
  while (total > 200 * 1024 * 1024 && list.length > 1) { const x = list.shift(); total -= x.s; IDB.del('h:' + x.h); }
  IDB.set('idx', list);
}
async function avCached(h) {
  const r = await IDB.get('h:' + h);
  if (!r || !r.buf) return false;
  avRegister(h, r.buf, r.type || sniff(r.buf));
  return true;
}
/* pede as fotos de quem está na sala e ainda não está neste navegador */
async function avNeedAll() {
  for (const u of lastList) {
    const h = okH(u.avh);
    if (!h || avUrl[h] || avWant.has(h)) continue;
    avWant.set(h, Date.now());
    if (await avCached(h)) { avWant.delete(h); avRefresh(); continue; }
    toRoom({t: 'avget', h});
  }
}
const busy = conn => (conn.dataChannel ? conn.dataChannel.bufferedAmount : 0) + (conn.bufferSize || 0) * AV_CHUNK;
async function avSend(conn, h) {
  if (!conn || !conn.open || !avUrl[h]) return;
  const buf = await (await fetch(avUrl[h])).arrayBuffer(), n = Math.ceil(buf.byteLength / AV_CHUNK);
  for (let i = 0; i < n; i++) {
    /* manda aos poucos: o chat e os avisos da sala continuam passando no meio */
    while (busy(conn) > 1024 * 1024) { await new Promise(r => setTimeout(r, 40)); if (!conn.open) return; }
    conn.send({t: 'avc', h, i, n, size: buf.byteLength, d: buf.slice(i * AV_CHUNK, (i + 1) * AV_CHUNK)});
  }
}
async function avRecv(d) {
  const h = okH(d.h); if (!h || avUrl[h]) return;
  const size = +d.size, n = +d.n, i = +d.i;
  const part = d.d instanceof ArrayBuffer ? d.d : d.d && ArrayBuffer.isView(d.d) ? d.d : null;
  if (!part || !(size > 0 && size <= AV_MAX + AV_CHUNK && n === Math.ceil(size / AV_CHUNK) && i >= 0 && i < n)) return;
  let p = avIn[h]; if (!p) p = avIn[h] = {parts: new Array(n), got: 0, n, size};
  if (p.n !== n || p.parts[i]) return;
  p.parts[i] = part; p.got++; p.at = Date.now();
  if (p.got < n) return;
  delete avIn[h];
  const buf = await new Blob(p.parts).arrayBuffer(), type = sniff(buf);
  /* só aceita se o conteúdo for o mesmo da foto pedida e for uma imagem */
  if (buf.byteLength !== size || !type || await sha(buf) !== h) { avWant.delete(h); return; }
  avRegister(h, buf, type); avSave(h, buf, type); avWant.delete(h);
  if (isHost) { const w = avWait[h]; delete avWait[h]; if (w) w.forEach(id => { const g = guests.get(id); if (g) avSend(g.conn, h); }); }
  avRefresh();
}
setInterval(() => {
  const now = Date.now();
  Object.keys(avIn).forEach(h => { if (now - (avIn[h].at || now) > 30000) { delete avIn[h]; avWant.delete(h); } });
  /* pedido que ninguém respondeu: pede de novo */
  avWant.forEach((t, h) => { if (!avIn[h] && now - t > 12000) avWant.delete(h); });
  if (roomReady) avNeedAll();
}, 5000);

/* ---------- Toasts ---------- */
const TI = {ok: 'check', err: 'alert', info: 'info'};
function toast(m, kind = 'info') {
  const box = $('#toasts'), t = document.createElement('div');
  t.className = 'toast ' + kind;
  t.innerHTML = '<svg class="i"><use href="#i-' + TI[kind] + '"/></svg><span></span>';
  t.querySelector('span').textContent = m;
  box.append(t);
  while (box.children.length > 3) box.firstChild.remove();
  setTimeout(() => { t.classList.add('out'); setTimeout(() => t.remove(), 220); }, 2800);
}

/* ---------- Tooltips (um único balão, posicionado fora de áreas com overflow) ---------- */
const tip = $('#tip'); let tipT = 0, tipFor = null, tipWarm = 0;
function placeTip(el) {
  tip.textContent = ''; tip.append(el.dataset.tip);
  if (el.dataset.kbd && !narrow()) { const k = document.createElement('kbd'); k.textContent = el.dataset.kbd; tip.append(k); }
  const r = el.getBoundingClientRect(), w = tip.offsetWidth, h = tip.offsetHeight;
  let x, y;
  if (el.closest('.rail')) { x = r.right + 12; y = r.top + r.height / 2 - h / 2; }
  else { x = r.left + r.width / 2 - w / 2; y = r.top - h - 8; if (y < 6) y = r.bottom + 8; }
  x = Math.max(8, Math.min(innerWidth - w - 8, x));
  tip.style.transform = 'translate(' + Math.round(x) + 'px,' + Math.round(y) + 'px)';
}
function showTip(el, now) {
  clearTimeout(tipT); tipFor = el;
  const go = () => { if (tipFor !== el || !el.isConnected) return; tip.classList.toggle('instant', now || Date.now() - tipWarm < 400); placeTip(el); tip.classList.add('on'); };
  now || Date.now() - tipWarm < 400 ? go() : (tipT = setTimeout(go, 450));
}
function hideTip() { clearTimeout(tipT); if (tip.classList.contains('on')) tipWarm = Date.now(); tipFor = null; tip.classList.remove('on'); }
document.addEventListener('pointerover', e => { if (e.pointerType === 'touch') return; const el = e.target.closest('[data-tip]'); if (el && el !== tipFor) showTip(el); else if (!el && tipFor) hideTip(); });
document.addEventListener('focusin', e => { const el = e.target.closest('[data-tip]'); if (el && el.matches(':focus-visible')) showTip(el, true); });
document.addEventListener('focusout', hideTip);
document.addEventListener('pointerdown', hideTip, true);
addEventListener('scroll', hideTip, true);

/* ---------- Dropdown próprio (o <select> nativo continua como fonte do valor) ---------- */
let openDD = null;
function makeSelect(sel) {
  const w = document.createElement('div'), b = document.createElement('button'), l = document.createElement('div');
  w.className = 'dd'; b.type = 'button'; b.className = 'dd-btn';
  b.setAttribute('aria-haspopup', 'listbox'); b.setAttribute('aria-expanded', 'false');
  const lab = sel.getAttribute('aria-labelledby'); if (lab) b.setAttribute('aria-labelledby', lab + ' ' + (b.id = 'b-' + lab));
  b.innerHTML = '<span class="dd-val"></span><svg class="i dd-car"><use href="#i-chev"/></svg>';
  l.className = 'dd-list'; l.setAttribute('role', 'listbox'); l.id = 'ls-' + (lab || Math.random().toString(36).slice(2));
  b.setAttribute('aria-controls', l.id);
  const lbl = sel.getAttribute('aria-label'); if (!lab && lbl) b.setAttribute('aria-label', lbl);
  let opts = [];
  const build = () => { l.textContent = ''; opts = [...sel.options].map((o, i) => {
    const it = document.createElement('div'); it.className = 'dd-opt'; it.setAttribute('role', 'option'); it.id = l.id + '-' + i; it.dataset.v = o.value;
    it.innerHTML = '<span></span>' + (o.dataset.d ? '<small></small>' : '') + '<svg class="i"><use href="#i-check"/></svg>';
    it.querySelector('span').textContent = o.textContent; if (o.dataset.d) it.querySelector('small').textContent = o.dataset.d;
    it.onpointermove = () => hl(i);
    it.onclick = () => choose(i);
    l.append(it); return it;
  }); };
  build();
  sel.classList.add('nat'); sel.after(w); w.append(sel, b); document.body.append(l);
  let cur = 0;
  const hl = i => { cur = (i + opts.length) % opts.length; opts.forEach((o, j) => o.classList.toggle('hl', j === cur)); b.setAttribute('aria-activedescendant', opts[cur].id); opts[cur].scrollIntoView({block: 'nearest'}); };
  const refresh = () => {
    const i = Math.max(0, sel.selectedIndex), o = sel.options[i], v = b.querySelector('.dd-val');
    v.textContent = o ? o.textContent : '';
    opts.forEach((x, j) => x.setAttribute('aria-selected', j === i));
  };
  const place = () => {
    const r = b.getBoundingClientRect(), h = Math.min(l.scrollHeight, 300), up = innerHeight - r.bottom < h + 16 && r.top > h + 16;
    l.classList.toggle('up', up);
    l.style.left = r.left + 'px'; l.style.width = r.width + 'px';
    l.style.top = (up ? r.top - h - 6 : r.bottom + 6) + 'px';
  };
  const open = () => {
    if (openDD) openDD.close();
    place(); w.classList.add('open'); l.classList.add('open'); b.setAttribute('aria-expanded', 'true');
    hl(Math.max(0, sel.selectedIndex)); openDD = api;
  };
  const close = () => { w.classList.remove('open'); l.classList.remove('open'); b.setAttribute('aria-expanded', 'false'); b.removeAttribute('aria-activedescendant'); if (openDD === api) openDD = null; };
  const choose = i => {
    const changed = sel.selectedIndex !== i; sel.selectedIndex = i; refresh(); close(); b.focus({preventScroll: true});
    if (changed) sel.dispatchEvent(new Event('input', {bubbles: true}));
  };
  b.onclick = () => openDD === api ? close() : open();
  b.onkeydown = e => {
    const isOpen = openDD === api;
    if (['ArrowDown', 'ArrowUp'].includes(e.key)) { e.preventDefault(); isOpen ? hl(cur + (e.key === 'ArrowDown' ? 1 : -1)) : open(); }
    else if (e.key === 'Home' && isOpen) { e.preventDefault(); hl(0); }
    else if (e.key === 'End' && isOpen) { e.preventDefault(); hl(opts.length - 1); }
    else if ((e.key === 'Enter' || e.key === ' ') && isOpen) { e.preventDefault(); choose(cur); }
    else if (e.key === 'Escape' && isOpen) { e.preventDefault(); e.stopPropagation(); close(); }
    else if (e.key === 'Tab' && isOpen) close();
  };
  const api = {close, place, el: w, list: l};
  sel._refresh = refresh; sel._rebuild = () => { build(); refresh(); }; refresh();
}
document.addEventListener('pointerdown', e => { if (openDD && !openDD.el.contains(e.target) && !openDD.list.contains(e.target)) openDD.close(); });
addEventListener('scroll', e => { if (openDD && !openDD.list.contains(e.target)) openDD.close(); }, true);
addEventListener('resize', () => openDD && openDD.close());

/* ---------- Configurações ---------- */
const lum = hex => { const c = [1, 3, 5].map(i => parseInt(hex.slice(i, i + 2), 16) / 255).map(v => v <= .03928 ? v / 12.92 : ((v + .055) / 1.055) ** 2.4); return .2126 * c[0] + .7152 * c[1] + .0722 * c[2]; };
const fill = r => r.style.setProperty('--p', ((r.value - r.min) / (r.max - r.min) * 100) + '%');
function sync() {
  root.dataset.theme = S.theme; root.classList.toggle('calm', S.calm);
  root.style.setProperty('--accent', S.accent);
  root.style.setProperty('--on-accent', lum(S.accent) > .35 ? '#1A1206' : '#FFFFFF');
  $$('[data-k]').forEach(el => { const v = S[el.dataset.k]; if (el.type === 'checkbox') el.checked = v; else el.value = v; if (el._refresh) el._refresh(); if (el.type === 'range') fill(el); });
  $('#acc').value = S.accent;
  let hit = false;
  $$('.sw button').forEach(b => { const on = b.dataset.c.toLowerCase() === S.accent.toLowerCase(); hit = hit || on; b.classList.toggle('on', on); });
  $('.sw .custom').classList.toggle('on', !hit);
  $$('[data-pre]').forEach(b => { const p = PRE[b.dataset.pre]; b.classList.toggle('on', Object.keys(p).every(k => S[k] === p[k])); });
  $('#brv').textContent = S.br + ' Mbps';
  const per = S.br + S.abr / 1000;
  $('#need').textContent = 'Cada pessoa que assiste sua tela usa cerca de ' + Math.ceil(per) + ' Mbps do seu upload: ' + Math.ceil(per * 3) + ' Mbps para 3 pessoas e ' + Math.ceil(per * 9) + ' Mbps para 9. Se a imagem travar, diminua a taxa de bits.';
  $$('[data-pct]').forEach(b => b.textContent = S[b.dataset.pct] + '%');
  [['screen', 'mxScreen'], ['mic', 'mxMic'], ['extra', 'mxExtra'], ['apps', 'mxApps']].forEach(([k, on]) => $('.mrow[data-src=' + k + ']').classList.toggle('off', !S[on]));
  setGo(goState);
  $$('.micB').forEach(b => { b.classList.toggle('on', S.mxMic); b.querySelector('use').setAttribute('href', S.mxMic ? '#i-mic' : '#i-micoff'); b.dataset.tip = S.mxMic ? 'Desligar microfone' : 'Ligar microfone'; b.setAttribute('aria-pressed', S.mxMic); });
}
const save = () => { try { localStorage.setItem('tl-set', JSON.stringify(S)); } catch (e) {} };
function live(k) {
  if (!stream) return;
  const vt = stream.getVideoTracks()[0];
  vt.contentHint = !camMode && S.prio === 'detail' ? 'detail' : 'motion';
  if (!k || k === 'res' || k === 'fps') {
    const [w, h] = RES[S.res];
    vt.applyConstraints({width: {ideal: w}, height: {ideal: h}, frameRate: {ideal: S.fps}})
      .then(() => { const s = vt.getSettings(); toast((camMode ? 'Webcam: ' : 'Captura: ') + s.width + '×' + s.height + ', ' + Math.round(s.frameRate) + ' fps', 'ok'); })
      .catch(() => toast('Não foi possível mudar a captura agora.', 'err'));
  }
  outCalls.forEach((c, id) => tune(c, outQ.get(id)));
}
$$('[data-k]').forEach(el => el.addEventListener(el.type === 'checkbox' ? 'change' : 'input', () => {
  const k = el.dataset.k;
  S[k] = el.type === 'checkbox' ? el.checked : el.dataset.n !== undefined ? +el.value : el.value;
  save(); sync(); if (['res', 'fps', 'br', 'prio', 'abr'].includes(k)) live(k);
  mixChanged(k);
  if (k === 'max' && isHost && me) users();
  if (k === 'theme' && roomReady) render();
}));
$$('[data-pre]').forEach(b => b.onclick = () => { Object.assign(S, PRE[b.dataset.pre]); save(); sync(); live(); toast('Predefinição “' + b.textContent + '” aplicada', 'ok'); });
$$('.sw button').forEach(b => b.onclick = () => { S.accent = b.dataset.c; save(); sync(); });
$('#acc').oninput = e => { S.accent = e.target.value; save(); sync(); };

function moveInd() {
  const t = $('.tab.on'), ind = $('.tabind'); if (!t || !t.offsetWidth) return;
  ind.style.width = t.offsetWidth + 'px'; ind.style.transform = 'translateX(' + t.offsetLeft + 'px)';
}
function showPane(id) {
  $$('.tab').forEach(t => { const on = t.dataset.p === id; t.classList.toggle('on', on); t.setAttribute('aria-selected', on); });
  $$('.pane').forEach(p => p.hidden = p.id !== id); moveInd();
}
$$('.tab').forEach(t => t.onclick = () => showPane(t.dataset.p));
let drawerFrom = null;
function drawer(o) {
  if (openDD) openDD.close();
  $('#drawer').classList.toggle('open', o); $('#scrim').classList.toggle('open', o);
  if (o) { drawerFrom = document.activeElement; requestAnimationFrame(moveInd); setTimeout(() => $('#dclose').focus({preventScroll: true}), 60); }
  else if (drawerFrom && drawerFrom.focus) drawerFrom.focus({preventScroll: true});
}
$('#scrim').onclick = $('#dclose').onclick = () => drawer(false);
function nav(o) { document.body.classList.toggle('navopen', o); $('#sideScrim').classList.toggle('open', o); }
$('#menuB').onclick = () => nav(true);
$('#sideScrim').onclick = () => nav(false);

/* ---------- Diálogo de confirmação ---------- */
function ask(title, desc, yes) {
  return new Promise(res => {
    const m = $('#confirm'); $('#cfT').textContent = title; $('#cfD').textContent = desc; $('#cfYes').textContent = yes;
    m.hidden = false; m.classList.remove('out'); $('#cfNo').focus();
    const done = v => { m.classList.add('out'); setTimeout(() => { m.hidden = true; }, 200); document.removeEventListener('keydown', esc, true); res(v); };
    const esc = e => { if (e.key === 'Escape') { e.stopPropagation(); done(false); } };
    document.addEventListener('keydown', esc, true);
    $('#cfNo').onclick = () => done(false); $('#cfYes').onclick = () => done(true);
    m.onclick = e => { if (e.target === m) done(false); };
  });
}

/* ---------- Ações do player ---------- */
function syncVol() {
  const m = wantMuted || scrVol === 0;
  $$('#muteB use').forEach(u => u.setAttribute('href', m ? '#i-mute' : '#i-vol'));
  const r = $('#vol'); r.value = wantMuted ? 0 : scrVol; fill(r);
}
function setChat(show) {
  document.body.classList.toggle('nochat', !show);
  if (show) { unread = 0; paintUnread(); }
}
function paintUnread() { const u = $('#unread'); u.hidden = !unread; u.textContent = unread > 99 ? '99+' : unread; }
const act = {
  fs: () => document.fullscreenElement ? document.exitFullscreen() : stage.requestFullscreen().catch(() => toast('Tela cheia indisponível neste navegador.', 'err')),
  theater: () => document.body.classList.toggle('theater'),
  chat: () => {
    nav(false);
    if (narrow()) { setChat(true); $('.chat').scrollIntoView({behavior: 'smooth'}); setTimeout(() => $('#mi').focus({preventScroll: true}), 350); return; }
    setChat(document.body.classList.contains('nochat'));
  },
  focusStage: () => { nav(false); stage.scrollIntoView({behavior: 'smooth', block: 'center'}); },
  invite: () => { nav(false); copyLink(); },
  stats: () => { const st = $('#stats'); if (!st.textContent) st.textContent = 'Sem transmissão no momento.\nOs números aparecem quando o vídeo começar.'; st.hidden = !st.hidden; },
  settings: () => { nav(false); showPane($('.tab.on') ? $('.tab.on').dataset.p : 'p-tx'); drawer(true); },
  mixer: () => { nav(false); showPane('p-tx'); drawer(true); setTimeout(() => $('#mixSec').scrollIntoView({behavior: 'smooth', block: 'start'}), 120); },
  mic: () => {
    S.mxMic = !S.mxMic; save(); sync(); mixChanged('mxMic');
    $$('.micB').forEach(b => { b.classList.add('flip'); setTimeout(() => b.classList.remove('flip'), 160); });
    toast(S.mxMic ? 'Microfone ligado: todos na sala ouvem você' : 'Microfone desligado', S.mxMic ? 'ok' : 'info');
  },
  pip: () => {
    if (document.pictureInPictureElement) return document.exitPictureInPicture();
    const id = focus && screenOf(focus) ? focus : [...tiles.keys()].find(x => x !== myId && screenOf(x)) || (preview ? myId : null);
    const v = id && tiles.get(id) && tiles.get(id).sv;
    if (!v) return toast('Ninguém está transmitindo a tela agora.', 'info');
    v.requestPictureInPicture ? v.requestPictureInPicture().catch(() => toast('Imagem sobre imagem indisponível agora.', 'err')) : toast('Seu navegador não suporta imagem sobre imagem.', 'err');
  },
  deaf: () => { deaf = !deaf; paintDeaf(); toast(deaf ? 'Som da sala desligado: você não ouve vozes nem telas' : 'Som da sala ligado', deaf ? 'info' : 'ok'); },
  mute: () => { wantMuted = !wantMuted; soundOk = true; if (!wantMuted && scrVol === 0) scrVol = 1; $('#sound').hidden = true; applyMute(); syncVol(); },
  cam: () => {
    $$('.camB').forEach(b => { b.classList.add('flip'); setTimeout(() => b.classList.remove('flip'), 160); });
    myCam ? camStop() : camStart();
  },
  pause: () => {
    if (!stream) return toast('Inicie a transmissão antes de pausar.', 'info');
    paused = !paused; stream.getTracks().forEach(t => t.enabled = !paused);
    toRoom({t: 'pause', v: paused});
    $$('[data-act=pause] use').forEach(u => u.setAttribute('href', paused ? '#i-play' : '#i-pause'));
    $$('[data-act=pause]').forEach(b => { b.dataset.tip = paused ? 'Retomar imagem' : 'Pausar imagem'; b.classList.toggle('on', paused); });
    toast(paused ? 'Imagem pausada para quem assiste' : 'Transmissão retomada', paused ? 'info' : 'ok');
  }
};
$$('[data-act]').forEach(b => b.addEventListener('click', () => act[b.dataset.act]()));
let it; const wake = () => { stage.classList.add('act'); clearTimeout(it); it = setTimeout(() => stage.classList.remove('act'), 2800); };
['pointermove', 'pointerdown'].forEach(e => stage.addEventListener(e, wake));
stage.addEventListener('pointerleave', () => { clearTimeout(it); it = setTimeout(() => stage.classList.remove('act'), 600); });
document.addEventListener('keydown', e => {
  if (e.key === 'Escape') {
    if (openDD) return openDD.close();
    if ($('#drawer').classList.contains('open')) return drawer(false);
    if (document.body.classList.contains('navopen')) return nav(false);
    if (focus) setFocus(null);
    return;
  }
  if ($('#modal') || !$('#confirm').hidden || e.target.closest('input,select,textarea,[contenteditable]') || e.ctrlKey || e.metaKey || e.altKey) return;
  const k = e.key.toLowerCase(), m = {f: 'fs', t: 'theater', c: 'chat', s: 'stats', m: 'mute', p: 'pause', v: 'mic', d: 'deaf'}[k];
  if (m) { e.preventDefault(); act[m](); wake(); }
});
$('#sound').onclick = () => { audioSession(); wantMuted = false; soundOk = true; if (scrVol === 0) scrVol = 1; applyMute(); tiles.forEach(R => { if (R.sv.srcObject) playV(R.sv); }); VO.inc.forEach(v => v.el.play().catch(() => {})); if (MX.ctx && MX.ctx.state === 'suspended') MX.ctx.resume().catch(() => {}); $('#sound').hidden = true; syncVol(); };
$('#vol').oninput = e => { scrVol = +e.target.value; wantMuted = scrVol === 0; soundOk = true; $('#sound').hidden = true; applyMute(); syncVol(); };
const applyMute = () => { tiles.forEach((R, id) => { R.sv.muted = id === myId || wantMuted || deaf; R.sv.volume = scrVol; }); };

/* ---------- Mixer de áudio da minha transmissão ----------
   Som da tela, microfone e entrada extra passam por ganhos separados e viram uma só faixa.
   A faixa existe desde o início da transmissão, então ligar ou desligar fontes não reconecta ninguém. */
const MX = {ctx: null, dest: null, nodes: {}};
const GK = {screen: ['mxScreen', 'vScreen'], mic: ['mxMic', 'vMic'], extra: ['mxExtra', 'vExtra'], apps: ['mxApps', 'vApps']};
function mixCtx() {
  if (!MX.ctx) {
    MX.ctx = new (window.AudioContext || window.webkitAudioContext)({sampleRate: 48000, latencyHint: 'interactive'});
    MX.dest = MX.ctx.createMediaStreamDestination(); MX.dest.channelCount = 2;
  }
  if (MX.ctx.state === 'suspended') MX.ctx.resume().catch(() => {});
  if (!MX.ctx.onstatechange) MX.ctx.onstatechange = () => { if (MX.ctx.state !== 'running') MX.ctx.resume().catch(() => {}); };
  return MX.ctx;
}
/* se o navegador deixar o contexto suspenso (política de áudio), qualquer toque ou tecla na página o acorda */
['pointerdown', 'keydown'].forEach(ev => addEventListener(ev, () => { if (MX.ctx && MX.ctx.state !== 'running') MX.ctx.resume().catch(() => {}); }, {passive: true}));
function attach(key, ms) {
  detach(key);
  if (!ms || !ms.getAudioTracks().length) return;
  const ctx = mixCtx(), src = ctx.createMediaStreamSource(ms), g = ctx.createGain(), an = ctx.createAnalyser();
  an.fftSize = 512; src.connect(g); g.connect(an); g.connect(MX.dest);
  MX.nodes[key] = {ms, src, g, an, buf: new Uint8Array(an.fftSize)}; gain(key);
}
function detach(key, stopTracks) {
  const n = MX.nodes[key]; if (!n) return;
  try { n.src.disconnect(); n.g.disconnect(); } catch (e) {}
  if (stopTracks) n.ms.getTracks().forEach(t => t.stop());
  delete MX.nodes[key];
}
function gain(key) {
  const n = MX.nodes[key]; if (!n) return;
  const [on, v] = GK[key];
  n.g.gain.setTargetAtTime(S[on] || (key === 'screen' && tabAudio) ? S[v] / 100 : 0, MX.ctx.currentTime, .03);
}
let devOk = false;
async function refreshDevices() {
  if (!navigator.mediaDevices || !navigator.mediaDevices.enumerateDevices) return;
  let list = [];
  try { list = (await navigator.mediaDevices.enumerateDevices()).filter(d => d.kind === 'audioinput' && d.deviceId); } catch (e) { return; }
  devOk = list.some(d => d.label);
  $('#devPerm').hidden = devOk;
  let cams = [];
  try { cams = (await navigator.mediaDevices.enumerateDevices()).filter(d => d.kind === 'videoinput' && d.deviceId); } catch (e) {}
  const fillSel = (sel, first, items = list) => {
    sel.textContent = '';
    const o0 = document.createElement('option'); o0.value = ''; o0.textContent = first; sel.append(o0);
    items.filter(d => d.deviceId !== 'default' && d.deviceId !== 'communications').forEach((d, i) => {
      const o = document.createElement('option'); o.value = d.deviceId; o.textContent = d.label || (items === list ? 'Entrada de áudio ' : 'Câmera ') + (i + 1);
      if (items === list && /cable|vb-audio|voicemeeter|virtual/i.test(d.label)) o.dataset.d = 'Cabo virtual';
      sel.append(o);
    });
    if (sel._rebuild) sel._rebuild();
  };
  fillSel($('select[data-k=micDev]'), 'Microfone padrão do sistema');
  setTimeout(micWarn, 0);
  fillSel($('select[data-k=extDev]'), 'Escolha um dispositivo');
  fillSel($('select[data-k=camDev]'), 'Câmera padrão do sistema', cams);
  try {
    const outs = (await navigator.mediaDevices.enumerateDevices()).filter(d => d.kind === 'audiooutput' && d.deviceId && d.deviceId !== 'default' && d.deviceId !== 'communications');
    const sel = $('select[data-k=outDev]'); sel.textContent = '';
    const o0 = document.createElement('option'); o0.value = ''; o0.textContent = 'Padrão do sistema'; sel.append(o0);
    outs.forEach((d, i) => { const o = document.createElement('option'); o.value = d.deviceId; o.textContent = d.label || 'Saída de áudio ' + (i + 1); if (/head|fone|auricular|earphone|buds/i.test(d.label)) o.dataset.d = 'Fone'; sel.append(o); });
    if (sel._rebuild) sel._rebuild();
    $('.mrow[data-src=out]').hidden = !('setSinkId' in HTMLMediaElement.prototype);
  } catch (e) {}
  if (!S.extDev) { const v = list.find(d => /cable output|vb-audio|voicemeeter/i.test(d.label)); if (v) { S.extDev = v.deviceId; save(); } }
  sync();
}
$('#devPerm').onclick = async () => {
  try { const s = await navigator.mediaDevices.getUserMedia({audio: true}); s.getTracks().forEach(t => t.stop()); await refreshDevices(); toast('Dispositivos liberados', 'ok'); }
  catch (e) { toast('O navegador bloqueou o acesso ao áudio. Libere no cadeado ao lado do endereço.', 'err'); }
};
if (navigator.mediaDevices) navigator.mediaDevices.addEventListener('devicechange', refreshDevices);
async function openInput(key) {
  if (key === 'mic') return voiceMic();
  const [on] = GK[key], dev = S.extDev;
  if (!stream || !S[on]) { detach(key, true); return; }
  if (key === 'extra' && !dev) { toast('Escolha qual dispositivo usar na entrada extra.', 'info'); return; }
  try {
    const voice = key === 'mic';
    const ms = await navigator.mediaDevices.getUserMedia({audio: {deviceId: dev ? {exact: dev} : undefined, echoCancellation: voice, noiseSuppression: voice, autoGainControl: voice, channelCount: voice ? 1 : 2}});
    if (!stream || !S[on]) { ms.getTracks().forEach(t => t.stop()); return; }
    detach(key, true); attach(key, ms);
    if (!devOk) refreshDevices();
  } catch (e) {
    S[on] = false; save(); sync();
    toast(key === 'mic' ? 'Não foi possível usar o microfone. Verifique a permissão no cadeado ao lado do endereço.' : 'Não foi possível abrir a entrada extra. Confira o dispositivo escolhido.', 'err');
  }
}
/* Som da tela (sistema inteiro) e Som dos apps não podem ficar ligados juntos:
   o primeiro pegaria o som dos apps desmarcados. Ligar um desliga o outro. */
function exclusive(k) {
  if (k === 'mxApps' && S.mxApps && S.mxScreen) { S.mxScreen = false; gain('screen'); toast('Som da tela desligado: agora só entram os apps marcados.', 'info'); }
  else if (k === 'mxScreen' && S.mxScreen && S.mxApps && HP.ok) { S.mxApps = false; gain('apps'); helperStream(); toast('Som dos apps desligado: o som da tela já leva o computador inteiro.', 'info'); }
  else return;
  save(); sync(); paintApps();
}
function mixChanged(k) {
  if (k === 'mxScreen' && S.mxScreen && stream && !MX.nodes.screen) {
    S.mxScreen = false; save(); sync(); paintApps();
    toast('Esta transmissão não tem som da tela. Pare e comece de novo marcando “Compartilhar áudio do sistema” (tela inteira) ou compartilhe uma guia com áudio.', 'info');
    return;
  }
  exclusive(k);
  if (k === 'mxScreen' || k === 'vScreen') { gain('screen'); paintApps(); }
  else if (k === 'vMic') gain('mic');
  else if (k === 'vExtra') gain('extra');
  else if (k === 'vApps') gain('apps');
  else if (k === 'mxApps') { gain('apps'); helperStream(); }
  else if (k === 'mxMic' || k === 'micDev') { voiceMic(); micWarn(); }
  else if (k === 'outDev') applySinks();
  else if (k === 'camDev') { if (myCam) camStart(); }
  else if (k === 'vVoice') VO.inc.forEach(v => { v.el.volume = S.vVoice / 100; });
  else if (k === 'mxExtra' || k === 'extDev') openInput('extra');
}
(function meters() {
  if ($('#drawer').classList.contains('open')) {
    $$('.meter').forEach(m => {
      const n = MX.nodes[m.dataset.m]; let l = 0;
      if (n && S[GK[m.dataset.m][0]]) { n.an.getByteTimeDomainData(n.buf); let sum = 0; for (const v of n.buf) { const x = (v - 128) / 128; sum += x * x; } l = Math.min(1, Math.sqrt(sum / n.buf.length) * 3.2); }
      m.style.setProperty('--l', l.toFixed(3));
    });
  }
  requestAnimationFrame(meters);
})();


/* ---------- Voz na sala ----------
   Quem liga o microfone liga uma chamada só de áudio para cada pessoa da sala.
   A voz não depende de transmitir a tela: todo mundo ouve todo mundo, como num canal de voz. */
const VO = {dest: null, out: new Map(), inc: new Map(), on: false};
/* quem eu silenciei só na voz: a transmissão da tela dessa pessoa continua com som */
const vMuted = new Set();
async function voiceMic() {
  if (!S.mxMic) { stopVoice(); return; }
  if (!me || !navigator.mediaDevices) return;
  try {
    const ms = await navigator.mediaDevices.getUserMedia({audio: {deviceId: S.micDev ? {exact: S.micDev} : undefined, echoCancellation: true, noiseSuppression: true, autoGainControl: true, channelCount: 1}});
    if (!S.mxMic) { ms.getTracks().forEach(t => t.stop()); return; }
    const ctx = mixCtx();
    if (!VO.dest) VO.dest = ctx.createMediaStreamDestination();
    detach('mic', true);
    const src = ctx.createMediaStreamSource(ms), g = ctx.createGain(), an = ctx.createAnalyser(); an.fftSize = 512;
    src.connect(g); g.connect(an); g.connect(VO.dest);
    MX.nodes.mic = {ms, src, g, an, buf: new Uint8Array(an.fftSize)}; gain('mic');
    if (!devOk) refreshDevices();
    if (!VO.on) { VO.on = true; audioSession(); toRoom({t: 'voice', on: true}); }
    syncVoice();
  } catch (e) {
    S.mxMic = false; save(); sync();
    toast('Não foi possível usar o microfone. Libere o acesso no cadeado ao lado do endereço.', 'err');
  }
}
function stopVoice() {
  detach('mic', true);
  [...VO.out.values()].forEach(c => c.close()); VO.out.clear();
  if (VO.on) { VO.on = false; audioSession(); toRoom({t: 'voice', on: false}); }
}
/* liga a voz para quem entrou e desliga de quem saiu */
function syncVoice() {
  if (!VO.on || !VO.dest || !peer || !myId) return;
  const ids = new Set(lastList.map(u => u.id).filter(id => id !== myId));
  VO.out.forEach((c, id) => { if (!ids.has(id)) { c.close(); VO.out.delete(id); } });
  ids.forEach(id => {
    if (VO.out.has(id)) return;
    const c = peer.call(id, VO.dest.stream, {metadata: {kind: 'voice'}, sdpTransform: sd => sd.replace(/useinbandfec=1/g, 'useinbandfec=1;maxaveragebitrate=64000')});
    if (!c) return;
    VO.out.set(id, c);
    c.on('close', () => { if (VO.out.get(id) === c) VO.out.delete(id); setTimeout(syncVoice, 2000); });
  });
}
function onVoiceCall(c) {
  const old = VO.inc.get(c.peer); if (old) { old.call.close(); old.el.remove(); }
  const el = document.createElement('audio'); el.autoplay = true; el.hidden = true; document.body.append(el);
  const v = {call: c, el, an: null, buf: null}; VO.inc.set(c.peer, v);
  c.answer(undefined);
  c.on('stream', s => {
    el.srcObject = s; el.volume = S.vVoice / 100; el.muted = deaf || vMuted.has(c.peer); sinkOf(el); el.play().catch(needSound);
  });
  c.on('close', () => { if (VO.inc.get(c.peer) === v) VO.inc.delete(c.peer); el.remove(); });
}
const sinkOf = el => { if (el.setSinkId) el.setSinkId(S.outDev || '').catch(() => { if (S.outDev) { S.outDev = ''; save(); sync(); toast('A saída de áudio escolhida não está disponível. Voltei para a padrão.', 'info'); } }); };
function applySinks() { tiles.forEach((R, id) => { if (id !== myId) sinkOf(R.sv); }); VO.inc.forEach(v => sinkOf(v.el)); }
function paintVoiceMute(b, id, name) {
  const m = vMuted.has(id);
  b.classList.toggle('on', m); b.setAttribute('aria-pressed', m);
  b.dataset.tip = m ? 'Voltar a ouvir a voz de ' + name : 'Silenciar a voz de ' + name + ' (a tela continua com som)';
  b.setAttribute('aria-label', b.dataset.tip);
  b.querySelector('use').setAttribute('href', m ? '#i-micoff' : '#i-mic');
  if (tipFor === b) placeTip(b);
}
function toggleVoiceMute(id, name, b) {
  const m = !vMuted.has(id); m ? vMuted.add(id) : vMuted.delete(id);
  const v = VO.inc.get(id); if (v) v.el.muted = deaf || m;
  paintVoiceMute(b, id, name);
  toast(m ? 'Voz de ' + name + ' silenciada. Você continua ouvindo a transmissão.' : 'Voltou a ouvir a voz de ' + name, m ? 'info' : 'ok');
}
function paintDeaf() {
  VO.inc.forEach((v, id) => { v.el.muted = deaf || vMuted.has(id); }); applyMute();
  $$('.deafB').forEach(b => { b.classList.toggle('deaf', deaf); b.querySelector('use').setAttribute('href', deaf ? '#i-deaf' : '#i-headset');
    b.dataset.tip = deaf ? 'Ligar o som da sala' : 'Desligar o som da sala'; b.setAttribute('aria-pressed', deaf); });
  if (roomReady) render();
}
/* anel verde em quem está falando */
const lvl = (an, buf) => { an.getByteTimeDomainData(buf); let s = 0; for (const x of buf) { const y = (x - 128) / 128; s += y * y; } return Math.sqrt(s / buf.length); };
/* o nível de quem fala vem das estatísticas da conexão, sem passar o som pelo Web Audio (no iPhone isso mudava o som de lugar) */
const lastTalk = {};  // id → última vez que a pessoa fez som; segura um instante para não piscar entre as sílabas
setInterval(async () => {
  const now = Date.now();
  if (VO.on && MX.nodes.mic && lvl(MX.nodes.mic.an, MX.nodes.mic.buf) > .02) lastTalk[myId] = now;
  for (const [id, v] of VO.inc) {
    const pc = v.call.peerConnection; if (!pc || deaf || vMuted.has(id)) continue;
    try { (await pc.getStats()).forEach(x => { if (x.type === 'inbound-rtp' && x.kind === 'audio' && (x.audioLevel || 0) > .03) lastTalk[id] = now; }); } catch (e) {}
  }
  const talking = new Set(Object.keys(lastTalk).filter(id => now - lastTalk[id] < 700 && (id === myId ? VO.on : VO.inc.has(id))));
  const names = new Set([...talking].map(id => id === myId ? me : (byId(id) || {}).name).filter(Boolean));
  const diff = new Set([...names, ...talkNames].filter(n => names.has(n) !== talkNames.has(n)));
  if (diff.size) {
    talkNames.clear(); names.forEach(n => talkNames.add(n));
    $$('[data-avn]').forEach(el => { if (diff.has(el.dataset.avn)) avatar(el, el.dataset.avn); });
  }
  $$('.mem').forEach(r => r.querySelector('.av').classList.toggle('speak', talking.has(r.dataset.id)));
  $$('.tile').forEach(t => t.classList.toggle('speak', talking.has(t.dataset.id)));
}, 250);
/* Ouvir o que estou transmitindo: toca a mesma faixa que vai para a sala, para conferir de onde vem cada som */
let monEl = null;
function monitor(on) {
  if (monEl) { monEl.pause(); monEl.remove(); monEl = null; }
  if (on && MX.dest) { monEl = new Audio(); monEl.srcObject = MX.dest.stream; sinkOf(monEl); monEl.play().catch(() => {}); }
  $('#monB').classList.toggle('on', !!monEl);
  $('#monB').textContent = monEl ? 'Parar de ouvir' : 'Ouvir o que estou transmitindo';
}
$('#monB').onclick = () => {
  if (monEl) return monitor(false);
  if (!stream) return toast('Comece a transmitir para ouvir o que está saindo.', 'info');
  monitor(true); toast('Tocando exatamente o que sai para a sala. Use fone para não dar eco.', 'info');
};
/* microfones que na verdade gravam o som do computador */
function micWarn() {
  const sel = $('select[data-k=micDev]'), o = sel && sel.options[sel.selectedIndex], label = o ? o.textContent : '';
  const loop = /mixagem|stereo mix|mix est|what u hear|cable output|voicemeeter|wave out|loopback/i.test(label);
  const w = $('#micWarn');
  w.hidden = !(S.mxMic && loop);
  w.textContent = 'Este dispositivo grava o som do computador inteiro, não a sua voz. Todos na sala vão ouvir tudo que toca no PC. Escolha o seu microfone de verdade.';
}
$('#outTest').onclick = () => {
  const ctx = new (window.AudioContext || window.webkitAudioContext)(), n = Math.round(ctx.sampleRate * .45), b = ctx.createBuffer(1, n, ctx.sampleRate), d = b.getChannelData(0);
  for (let i = 0; i < n; i++) { const t = i / ctx.sampleRate, f = t < .15 ? 660 : t < .3 ? 880 : 990; d[i] = Math.sin(2 * Math.PI * f * t) * .25 * Math.min(1, (n - i) / 2000); }
  const dst = ctx.createMediaStreamDestination(), src = ctx.createBufferSource(); src.buffer = b; src.connect(dst);
  const el = new Audio(); el.srcObject = dst.stream; sinkOf(el); el.play().catch(() => {}); src.start();
  setTimeout(() => { el.remove(); ctx.close(); }, 800);
};

/* ---------- Cineminha Áudio: programa do Windows que captura apps escolhidos ----------
   Ele fica em 127.0.0.1:47833, manda a lista de apps e o som já mixado (float32, 48 kHz, estéreo).
   O site só tenta conectar depois que a pessoa baixou ou pediu para conectar, para não incomodar quem não usa. */
const HP = {ws: null, ok: false, apps: [], node: null, poll: 0, error: null, ver: '', sig: '', fr: 0, pk: 0};
const HELPER_LATEST = '1.3.2';
const WORKLET = `class P extends AudioWorkletProcessor{constructor(){super();this.q=[];this.o=0;this.n=0;this.on=false;
this.port.onmessage=e=>{if(e.data==='reset'){this.q=[];this.o=0;this.n=0;this.on=false;return}this.q.push(e.data);this.n+=e.data.length;
while(this.n>28800&&this.q.length>1){const d=this.q.shift();this.n-=d.length-this.o;this.o=0}}}
process(i,out){const L=out[0][0],R=out[0][1]||out[0][0];if(!this.on){if(this.n>=3840)this.on=true;else{L.fill(0);R.fill(0);return true}}
for(let k=0;k<L.length;k++){if(!this.q.length){L[k]=R[k]=0;this.on=false;continue}const d=this.q[0];L[k]=d[this.o];R[k]=d[this.o+1];this.o+=2;this.n-=2;
if(this.o>=d.length){this.q.shift();this.o=0}}return true}}registerProcessor('cm-apps',P);`;
async function helperNode() {
  if (HP.node) return HP.node;
  const ctx = mixCtx();
  await ctx.audioWorklet.addModule(URL.createObjectURL(new Blob([WORKLET], {type: 'text/javascript'})));
  HP.node = new AudioWorkletNode(ctx, 'cm-apps', {numberOfInputs: 0, numberOfOutputs: 1, outputChannelCount: [2]});
  const g = ctx.createGain(), an = ctx.createAnalyser(); an.fftSize = 512;
  HP.node.connect(g); g.connect(an); g.connect(MX.dest);
  MX.nodes.apps = {ms: null, src: HP.node, g, an, buf: new Uint8Array(an.fftSize)}; gain('apps');
  return HP.node;
}
function helperSend(m) { if (HP.ws && HP.ws.readyState === 1) HP.ws.send(JSON.stringify(m)); }
function helperStream() { helperSend({t: stream && S.mxApps ? 'start' : 'stop'}); if (!(stream && S.mxApps) && HP.node) HP.node.port.postMessage('reset'); }
function helperConnect(loud) {
  if (HP.ws && HP.ws.readyState <= 1) return;
  let ws;
  try { ws = new WebSocket('ws://127.0.0.1:47833'); } catch (e) { return; }
  HP.ws = ws; ws.binaryType = 'arraybuffer';
  ws.onopen = async () => {
    HP.ok = true; HP.error = null; clearInterval(HP.poll); HP.poll = 0;
    const first = !S.helperSeen;
    S.helperSeen = true;
    if (first) S.mxApps = true;
    if (S.mxApps && S.mxScreen) { S.mxScreen = false; gain('screen'); toast('Cineminha Áudio conectado. Desliguei o som da tela para valer só os apps marcados.', 'ok'); }
    else if (first || loud) toast('Cineminha Áudio conectado', 'ok');
    save(); sync();
    try { await helperNode(); } catch (e) { toast('Este navegador não aceita o som dos apps. Use Chrome, Edge ou Brave atualizado.', 'err'); }
    helperSend({t: 'prefs', apps: S.appPrefs}); helperStream(); paintApps();
  };
  ws.onmessage = e => {
    if (typeof e.data !== 'string') {
      const f = new Float32Array(e.data); HP.fr++;
      for (let i = 0; i < f.length; i += 6) { const a = Math.abs(f[i]); if (a > HP.pk) HP.pk = a; }
      if (HP.node) HP.node.port.postMessage(f, [e.data]);
      return;
    }
    let d; try { d = JSON.parse(e.data); } catch (_) { return; }
    if (d.t === 'hello') { HP.ver = d.ver || '1.0.0'; paintApps(); }
    else if (d.t === 'levels') { $$('.app').forEach(r => { const v = d.l && d.l[r.dataset.key]; r.style.setProperty('--al', Math.min(1, (v || 0) * 3.2).toFixed(3)); r.classList.toggle('lv', v != null); r.classList.toggle('stale', !!(d.s && d.s[r.dataset.key] === 'sem dados')); }); }
    else if (d.t === 'apps') {
      HP.apps = Array.isArray(d.list) ? d.list : []; HP.error = d.error || null;
      /* o programa do Windows liga todo app novo por padrão, o que levava o som do computador inteiro.
         Aqui o padrão é o contrário: app que a pessoa nunca marcou fica de fora e é desligado no programa na hora. */
      const fresh = {};
      HP.apps.forEach(a => { if (!S.appPrefs[a.key]) fresh[a.key] = S.appPrefs[a.key] = {on: false, vol: 100}; });
      if (Object.keys(fresh).length) { save(); helperSend({t: 'prefs', apps: fresh}); }
      /* a marcação que você vê é a que vale: se o programa estiver com outro valor (outra aba, programa reaberto), o site reenvia a sua */
      const fix = {};
      HP.apps.forEach(a => { const p = S.appPrefs[a.key]; if (p && (a.on !== p.on || Math.round(a.vol) !== Math.round(p.vol))) fix[a.key] = p; });
      if (Object.keys(fix).length) helperSend({t: 'prefs', apps: fix});
      paintApps();
    }
  };
  ws.onclose = () => {
    const was = HP.ok; HP.ok = false; HP.ws = null; HP.apps = []; HP.sig = ''; paintApps();
    if (was) toast('Cineminha Áudio foi fechado. O som dos apps saiu da transmissão.', 'info');
    else if (loud) toast('Não encontrei o Cineminha Áudio. Confira se ele está aberto, com o ícone azul na bandeja do Windows.', 'err');
  };
}
addEventListener('storage', e => {
  if (e.key !== 'tl-set' || !e.newValue) return;
  try { const n = JSON.parse(e.newValue); if (n && n.appPrefs) { S.appPrefs = n.appPrefs; helperSend({t: 'prefs', apps: S.appPrefs}); paintApps(); } } catch (_) {}
});
function helperPoll(ms) { clearInterval(HP.poll); const end = Date.now() + ms; HP.poll = setInterval(() => { if (HP.ok || Date.now() > end) { clearInterval(HP.poll); HP.poll = 0; return; } helperConnect(false); }, 3000); }
const isWin = /Windows/i.test(navigator.userAgent);
/* o navegador em que a sala está aberta: capturar ele manda a voz e as telas da sala de volta para a transmissão */
const ownBrowser = navigator.brave ? /[\\/]brave\.exe$/ : /Edg\//.test(navigator.userAgent) ? /[\\/]msedge\.exe$/ : /OPR\//.test(navigator.userAgent) ? /[\\/]opera\.exe$/ : /Firefox\//.test(navigator.userAgent) ? /[\\/]firefox\.exe$/ : /[\\/]chrome\.exe$/;
const appsOn = () => HP.apps.filter(a => S.appPrefs[a.key] && S.appPrefs[a.key].on).length;
function paintApps() {
  const list = $('#appList'), get = $('#appGet'), row = $('.mrow.apps');
  row.classList.toggle('conn', HP.ok);
  list.hidden = !HP.ok; get.hidden = HP.ok;
  const foot = $('#appFoot'), old = HP.ok && HP.ver !== HELPER_LATEST;
  foot.hidden = !HP.ok || !isWin; foot.classList.toggle('old', old);
  $('#appVer').textContent = old ? 'Versão ' + (HP.ver || '1.0.0') + ' aberta. Há uma versão mais nova.' : 'Versão ' + HP.ver + ', a mais recente';
  $('#appVer').classList.toggle('old', old);
  if (!HP.ok) {
    $('#appsSub').textContent = isWin ? 'Escolha programa por programa' : 'Disponível no Windows 10 e 11';
    $('#appGetT').innerHTML = !isWin ? 'O Cineminha Áudio funciona no <b>Windows 10 e 11</b>. Neste computador, use o som da tela ou a entrada extra.'
      : S.helperSeen ? 'O <b>Cineminha Áudio</b> está desligado. Abra o programa no seu computador para escolher os apps.'
      : 'Para escolher os apps, como Spotify, Discord e jogos, instale o <b>Cineminha Áudio</b>: um programa de 650 KB para Windows 10 e 11 que fica na bandeja, perto do relógio.';
    $('#appDl').hidden = !isWin; $('#appConn').hidden = !isWin;
    $('#appDl span').textContent = S.helperSeen ? 'Baixar de novo' : 'Baixar Cineminha Áudio';
    return;
  }
  const sig = JSON.stringify([HP.apps.map(a => [a.key, a.name, a.includes, !!(S.appPrefs[a.key] && S.appPrefs[a.key].on)]), HP.error, S.mxScreen && S.mxApps]);
  if (sig === HP.sig && list.children.length) {
    $$('.app').forEach(r => { const a = HP.apps.find(x => x.key === r.dataset.key); if (a) { r.classList.toggle('on', !!a.active); r.title = a.name + (a.active ? ' (tocando agora)' : ''); } });
    $('#appsSub').textContent = 'Cineminha Áudio conectado · ' + appsOn() + ' de ' + HP.apps.length + ' apps';
    return;
  }
  HP.sig = sig;
  const known = new Set([...list.querySelectorAll('.app')].map(a => a.dataset.key));
  list.textContent = '';
  const head = document.createElement('p'); head.className = 'appnote';
  head.textContent = HP.apps.length ? 'Marque só os apps que devem entrar na transmissão. Os desmarcados ficam de fora e você continua ouvindo tudo normalmente.' : 'Nenhum app tocando som agora. Abra um programa com áudio e ele aparece aqui.';
  list.append(head);
  if (S.mxScreen && S.mxApps) { const w = document.createElement('p'); w.className = 'warn2'; w.textContent = 'O Som da tela está ligado e leva o som do computador inteiro.'; list.append(w); }
  if (HP.error) { const er = document.createElement('p'); er.className = 'apperr'; er.textContent = HP.error; list.append(er); }
  HP.apps.forEach(a => {
    const l = document.createElement('label'); l.className = 'app' + (a.active ? ' on' : ''); l.dataset.key = a.key;
    if (known.has(a.key)) l.style.animation = 'none';
    l.innerHTML = '<input type="checkbox"><span class="box"><svg class="i"><use href="#i-check"/></svg></span>' + (a.icon ? '<img alt="">' : '<span class="ph2"></span>') + '<span class="nmw"><span class="nm"></span><small class="inc" hidden></small></span><span class="play" aria-hidden="true"><i></i><i></i><i></i></span><span class="alvl" title="Som capturado deste app agora"><i></i></span>';
    const cb = l.querySelector('input'), p = S.appPrefs[a.key];
    cb.checked = !!(p && p.on);
    if (a.icon) l.querySelector('img').src = a.icon; else l.querySelector('.ph2').textContent = (a.name[0] || '?').toUpperCase();
    l.querySelector('.nm').textContent = a.name;
    const own = ownBrowser.test(a.key), inc = l.querySelector('.inc');
    if (own) { inc.hidden = false; inc.classList.add('echo'); inc.textContent = 'Este navegador: marcar devolve a voz e as telas da sala para a transmissão (eco)'; }
    else if (a.includes && a.includes.length) { inc.hidden = false; inc.textContent = 'Leva junto: ' + a.includes.join(', '); }
    l.title = a.name + (a.active ? ' (tocando agora)' : '');
    cb.onchange = () => {
      S.appPrefs[a.key] = {on: cb.checked, vol: (p && p.vol) || 100}; save(); helperSend({t: 'set', key: a.key, on: cb.checked});
      if (cb.checked && own) toast('Este é o navegador da sala: marcar ele devolve as vozes e as telas da sala para a transmissão e causa eco. Marque só o app que você quer mostrar.', 'info');
      paintApps();
    };
    list.append(l);
  });
  if (HP.apps.some(a => /chrome|msedge|brave|opera|firefox|vivaldi/i.test(a.key))) {
    const n = document.createElement('p'); n.className = 'appnote';
    n.textContent = 'Marcar o navegador inclui o som de todas as abas dele, inclusive desta sala.'; list.append(n);
  }
  const dg = document.createElement('p'); dg.className = 'appnote'; dg.id = 'appDiag'; list.append(dg); diag();
  $('#appsSub').textContent = 'Cineminha Áudio conectado · ' + appsOn() + ' de ' + HP.apps.length + ' apps';
}
/* mostra, ao vivo, se o som está chegando do programa: ajuda a achar em que ponto ele some */
function diag(reset) {
  const el = $('#appDiag'); if (!el) return;
  el.textContent = !(stream && S.mxApps) ? 'Diagnóstico: comece a transmitir para ver o som chegando do programa.'
    : HP.fr === 0 ? 'Diagnóstico: nada chegando do programa agora.'
    : 'Diagnóstico: ' + HP.fr + ' pacotes/s do programa · pico de som ' + Math.round(HP.pk * 100) + '%' + (HP.pk < .002 ? ' (silêncio)' : '');
  if (reset) { HP.fr = 0; HP.pk = 0; }
}
setInterval(() => diag(true), 1000);
$('#appDl').addEventListener('click', () => { $('#appGetH').hidden = false; helperPoll(180000); });
$('#appDl2').addEventListener('click', () => { toast('Antes de abrir o arquivo novo, feche o atual: ícone azul perto do relógio › Sair.', 'info'); helperPoll(180000); });
$('#appConn').onclick = () => { $('#appGetH').hidden = false; helperConnect(true); helperPoll(60000); };

/* ---------- Versão do site ---------- */
const oldWarned = new Set();
function showUpdate() { $('#upd').hidden = false; }
$('#updB').onclick = () => location.reload();
function checkVersions() {
  lastList.forEach(u => {
    if (u.id === myId) return;
    const v = +u.ver || 0;
    if (v > APP_VER) showUpdate();
    else if (v < APP_VER && !oldWarned.has(u.id)) { oldWarned.add(u.id); toast(u.name + ' está com uma versão antiga do Cineminha. Peça para recarregar a página.', 'info'); }
  });
}
/* confere de tempos em tempos se saiu uma versão nova do site */
async function checkDeploy() {
  try {
    const t = await (await fetch(location.pathname + '?_=' + Date.now(), {cache: 'no-store'})).text(), m = t.match(/app\.js\?v=(\d+)/);
    if (m && +m[1] > APP_VER) showUpdate();
  } catch (e) {}
}
setInterval(checkDeploy, 180000);
addEventListener('focus', () => checkDeploy());

function moveOut() {
  let d = {};
  try { d = {id: localStorage.getItem('tl-id') || '', name: localStorage.getItem('tl-name') || '', set: JSON.parse(localStorage.getItem('tl-set') || 'null')}; } catch (e) {}
  const b = btoa(unescape(encodeURIComponent(JSON.stringify(d)))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  location.replace(NEW_HOME + location.search + '#mig=' + b);
}
/* no endereço antigo: quando o novo estiver no ar, leva a pessoa para lá (sem derrubar quem já está numa sala) */
if (ON_OLD) fetch(NEW_HOME + 'alive.txt', {cache: 'no-store'}).then(r => r.ok ? r.text() : '').then(t => {
  if ((t || '').trim() !== 'cineminha') return;
  if (!me) return moveOut();
  $('#upd span').textContent = 'O Cineminha agora fica em cineminha.online.';
  $('#updB').textContent = 'Ir para o endereço novo'; $('#updB').onclick = moveOut; showUpdate();
}).catch(() => {});

/* ---------- Chat ---------- */
let lastAuthor = null;
function addMsg(m) {
  const box = $('#msgs'), d = document.createElement('div');
  if (m.t === 'sys') { d.className = 'sys'; d.textContent = m.text; lastAuthor = null; }
  else {
    const cont = lastAuthor && lastAuthor.name === m.name && m.ts - lastAuthor.ts < 180000;
    d.className = 'msg' + (cont ? ' cont' : '');
    d.innerHTML = '<div class="av"></div><div><div class="mh"><b></b><i class="tag" hidden>Anfitrião</i><time></time></div><p></p></div>';
    d.querySelector('.av').dataset.n = m.name; avatar(d.querySelector('.av'), m.name);
    const b = d.querySelector('b'); b.textContent = m.name; b.style.color = 'hsl(' + hue(m.name) + ',65%,' + (S.theme === 'light' ? '36%' : '72%') + ')';
    d.querySelector('.tag').hidden = !m.host;
    const tm = d.querySelector('time'), dt = new Date(m.ts);
    tm.textContent = dt.toLocaleTimeString('pt-BR', {hour: '2-digit', minute: '2-digit'}); tm.dateTime = dt.toISOString();
    d.querySelector('p').textContent = m.text;
    lastAuthor = {name: m.name, ts: m.ts};
    $('#chatEmpty').hidden = true;
    const hiddenChat = document.body.classList.contains('nochat') || document.body.classList.contains('theater');
    if (m.name !== me && hiddenChat) { unread++; paintUnread(); }
  }
  const stick = box.scrollHeight - box.scrollTop - box.clientHeight < 80;
  box.append(d);
  while (box.querySelectorAll('.msg,.sys').length > 200) box.querySelector('.msg,.sys').remove();
  if (stick || m.name === me) box.scrollTop = box.scrollHeight;
}
$('#mi').addEventListener('input', () => { $('#sendB').disabled = !$('#mi').value.trim(); });
$('#f').onsubmit = e => {
  e.preventDefault();
  const text = $('#mi').value.trim(); if (!text) return;
  $('#mi').value = ''; $('#sendB').disabled = true;
  if (!toRoom({t: 'msg', text})) addMsg({t: 'sys', text: 'Sem conexão com o anfitrião. Sua mensagem não foi enviada.'});
};

/* ---------- Membros ---------- */
let lastList = [];
const byId = id => lastList.find(u => u.id === id);
const liveIds = () => lastList.filter(u => u.live).map(u => u.id);
function renderMembers() {
  const list = lastList;
  list.forEach(u => { u.avh = okH(u.avh); if (u.avh && avUrl[u.avh]) avatars[u.name] = u.avh; else delete avatars[u.name]; });
  const el = $('#members'), known = new Set([...el.children].map(c => c.dataset.id));
  el.textContent = '';
  list.forEach(u => {
    const r = document.createElement('div'), mine = u.id === myId, can = u.live && !mine;
    r.className = 'mem' + (can ? ' can' : '') + (can && focus === u.id ? ' cur' : ''); r.dataset.id = u.id;
    if (known.has(u.id)) r.style.animation = 'none';
    r.innerHTML = '<div class="av on"></div><div class="mi"><b></b><small></small></div><span class="vic">'
      + (can ? '<span class="watch"></span>' : '') + (u.cam ? '<svg class="i"><use href="#i-cam"/></svg>' : '') + (u.mic && mine ? '<svg class="i"><use href="#i-mic"/></svg>' : '') + '</span>';
    avatar(r.querySelector('.av'), u.name); r.querySelector('b').textContent = u.name + (mine ? ' (você)' : '');
    const sm = r.querySelector('small');
    sm.textContent = u.live ? (mine ? 'Transmitindo sua tela' : 'Transmitindo agora') : u.cam ? 'Câmera ligada' : u.host ? 'Anfitrião' : 'Na sala';
    sm.classList.toggle('live', !!u.live);
    if (can) {
      r.querySelector('.watch').textContent = focus === u.id ? 'Na tela' : 'Ampliar';
      r.tabIndex = 0; r.setAttribute('role', 'button'); r.setAttribute('aria-label', 'Ampliar a tela de ' + u.name);
      r.onclick = () => { nav(false); setFocus(focus === u.id ? null : u.id); };
      r.onkeydown = e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); r.click(); } };
    }
    if (!mine && (u.mic || vMuted.has(u.id))) {
      const b = document.createElement('button'); b.type = 'button'; b.className = 'ibtn vmute';
      b.innerHTML = '<svg class="i"><use href="#i-mic"/></svg>';
      b.onclick = e => { e.stopPropagation(); toggleVoiceMute(u.id, u.name, b); };
      b.onkeydown = e => e.stopPropagation();
      paintVoiceMute(b, u.id, u.name); r.querySelector('.vic').append(b);
    }
    el.append(r);
    if (u.host) {
      const ri = $('#roomIcon'), ru = avSrc(u.avh, false); if (ru) pic(ri, ru); else { ri.style.background = ''; ri.textContent = (u.name[0] || '?').toUpperCase(); }
      const t = 'Sala de ' + u.name; $('#roomName').textContent = $('#roomT').textContent = t; document.title = t + ' · Cineminha';
      ri.dataset.tip = t;
    }
  });
  $('#memTitle').textContent = 'Na sala, ' + list.length;
  const ppl = list.length + (list.length > 1 ? ' pessoas' : ' pessoa');
  $('#chatCount').textContent = ppl; $('#count').textContent = ppl + (isHost ? ' (máx. ' + (S.max + 1) + ')' : '');
}
function paintLive() {
  const any = liveIds().length > 0;
  $('#badgeT').textContent = any ? 'ao vivo' : 'offline'; badge.classList.toggle('on', any);
  $('#rw').classList.toggle('live', any); $('#sideDot').classList.toggle('on', any); $('#navLive').hidden = !any;
  $('#vc').hidden = !stream; document.body.classList.toggle('presenting', !!stream);
  document.body.classList.toggle('watching', [...scr.values()].some(e => e.stream));
}
function setStatus(text, sub) { $('#phText').textContent = text || ''; $('#phSub').textContent = sub || ''; }

/* ---------- Palco: um quadrado por pessoa ----------
   A tela compartilhada aparece no quadrado de quem transmite; a câmera ocupa o quadrado
   ou fica no canto quando a pessoa também transmite a tela. */
const grid = $('#grid'), tiles = new Map();
let inviteTile = null;
const screenOf = id => id === myId ? preview : (scr.get(id) || {}).stream || null;
const camOf = id => id === myId ? myCam : (cams.get(id) || {}).stream || null;
function setSrc(v, s, sink) { if (v.srcObject === s) return; v.srcObject = s; if (s) { if (sink) sinkOf(v); playV(v); } }
function enterAnim(el) { requestAnimationFrame(() => requestAnimationFrame(() => el.classList.remove('enter'))); }
function makeTile(u) {
  const t = document.createElement('div');
  t.className = 'tile enter'; t.dataset.id = u.id; t.tabIndex = 0; t.setAttribute('role', 'button');
  t.innerHTML = '<div class="bg"></div><div class="face"><div class="av"></div><small class="tload">Carregando a tela…</small></div>'
    + '<video class="sv" autoplay playsinline muted></video><video class="cv" autoplay playsinline muted></video>'
    + '<span class="tlive" hidden><i></i>ao vivo</span>'
    + '<div class="ttools"><button type="button" class="tfoc"><svg class="i"><use href="#i-expand"/></svg></button><button type="button" class="tfs" aria-label="Tela cheia"><svg class="i"><use href="#i-max"/></svg></button></div>'
    + '<div class="ttag"><svg class="i moff"><use href="#i-micoff"/></svg><b></b></div>';
  const R = {el: t, id: u.id, sv: t.querySelector('.sv'), cv: t.querySelector('.cv'), av: t.querySelector('.face .av'), bg: t.querySelector('.bg'),
    tag: t.querySelector('.ttag b'), moff: t.querySelector('.moff'), live: t.querySelector('.tlive'), foc: t.querySelector('.tfoc')};
  const toggle = () => { if (tiles.size + (inviteTile ? 1 : 0) > 1) setFocus(focus === u.id ? null : u.id); };
  t.addEventListener('click', e => { if (!e.target.closest('.ttools')) toggle(); });
  t.addEventListener('dblclick', e => { if (!e.target.closest('.ttools')) tileFs(R); });
  t.addEventListener('keydown', e => { if (e.target === t && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); toggle(); } });
  R.foc.onclick = toggle;
  t.querySelector('.tfs').onclick = () => tileFs(R);
  grid.append(t); enterAnim(t);
  return R;
}
function tileFs(R) {
  if (document.fullscreenElement) return document.exitFullscreen();
  R.el.requestFullscreen().catch(() => toast('Tela cheia indisponível neste navegador.', 'err'));
}
function paintTile(R, u) {
  const mine = u.id === myId, s = screenOf(u.id), c = camOf(u.id), f = focus === u.id;
  const cl = R.el.classList;
  cl.toggle('me', mine); cl.toggle('scr', !!s); cl.toggle('cam', !!c); cl.toggle('wait', !!u.live && !s); cl.toggle('focus', f);
  setSrc(R.sv, s, !mine); setSrc(R.cv, c, false);
  avatar(R.av, u.name);
  const ah = mine ? myAvH : u.avh, src = ah && avUrl[ah], th = avThumb[ah];
  R.bg.style.backgroundImage = src ? 'url("' + (th || src) + '")' : ''; cl.toggle('hasbg', !!src);
  R.el.style.setProperty('--tbg', 'hsl(' + hue(u.name) + ',28%,' + (S.theme === 'light' ? '58%' : '24%') + ')');
  R.tag.textContent = mine ? u.name + ' (você)' : u.name;
  R.moff.style.display = u.mic ? 'none' : '';
  R.live.hidden = !u.live;
  R.foc.querySelector('use').setAttribute('href', f ? '#i-apps' : '#i-expand');
  R.foc.setAttribute('aria-label', f ? 'Voltar à grade' : 'Ampliar'); R.foc.dataset.tip = R.foc.getAttribute('aria-label');
  R.el.setAttribute('aria-label', (mine ? 'Você' : u.name) + (u.live ? ', transmitindo a tela' : '') + (u.cam ? ', câmera ligada' : '') + (f ? ', ampliado' : ''));
}
function render() {
  const ready = roomReady && lastList.length > 0;
  $('#ph').hidden = ready;
  const ids = ready ? lastList.map(u => u.id) : [];
  tiles.forEach((R, id) => {
    if (ids.includes(id)) return;
    tiles.delete(id); if (focus === id) focus = null;
    R.sv.srcObject = null; R.cv.srcObject = null;
    R.el.classList.add('leave'); setTimeout(() => R.el.remove(), 340);
  });
  ids.forEach(id => { let R = tiles.get(id); if (!R) { R = makeTile(byId(id)); tiles.set(id, R); } paintTile(R, byId(id)); });
  // ordem dos quadrados igual à da lista da sala
  ids.forEach(id => grid.append(tiles.get(id).el));
  const alone = ready && ids.length === 1;
  if (alone && !inviteTile) {
    const t = document.createElement('div'); t.className = 'tile invite enter';
    t.innerHTML = '<svg class="i"><use href="#i-userplus"/></svg><b>Só você por aqui</b><span>Envie o link da sala para seus amigos entrarem e assistirem com você.</span><button type="button" class="btn go"><svg class="i"><use href="#i-link"/></svg><span>Copiar convite</span></button>';
    t.querySelector('button').onclick = copyLink;
    grid.append(t); enterAnim(t); inviteTile = t;
  } else if (!alone && inviteTile) { const t = inviteTile; inviteTile = null; t.classList.add('leave'); setTimeout(() => t.remove(), 340); }
  if (inviteTile) grid.append(inviteTile);
  layout();
  applyMute(); syncVol(); paintLive();
  const anyAudio = [...scr.values()].some(e => e.stream && e.stream.getAudioTracks().length);
  $('#sound').hidden = !(anyAudio && !soundOk && !deaf);
}
const GAP = 10;
function layout() {
  const W = grid.clientWidth, H = grid.clientHeight; if (!W || !H) return;
  const items = [...tiles.values()].map(R => R.el); if (inviteTile) items.push(inviteTile);
  const n = items.length; if (!n) return;
  const AR = 16 / 9;
  const place = (el, x, y, w, h, small) => {
    el.style.transform = 'translate(' + Math.round(x) + 'px,' + Math.round(y) + 'px)';
    el.style.width = Math.round(w) + 'px'; el.style.height = Math.round(h) + 'px';
    el.classList.toggle('small', small);
  };
  const f = focus && tiles.get(focus);
  if (f && n > 1) {
    const others = items.filter(el => el !== f.el), sh = Math.max(64, Math.min(128, H * .2));
    let bw = W, bh = H - sh - GAP; if (bw / bh > AR) bw = bh * AR; else bh = bw / AR;
    place(f.el, (W - bw) / 2, (H - sh - GAP - bh) / 2, bw, bh, false);
    const m = others.length; let tw = sh * AR, th = sh;
    if (m * tw + (m - 1) * GAP > W) { tw = (W - (m - 1) * GAP) / m; th = tw / AR; }
    const x0 = (W - (m * tw + (m - 1) * GAP)) / 2, y0 = H - sh + (sh - th) / 2;
    others.forEach((el, i) => place(el, x0 + i * (tw + GAP), y0, tw, th, true));
    return;
  }
  // escolhe colunas que deixam os quadrados com a maior área; o formato varia entre 5:4 e 19:10
  let best = {a: 0};
  for (let cols = 1; cols <= n; cols++) {
    const rows = Math.ceil(n / cols), cw = (W - (cols - 1) * GAP) / cols, ch = (H - (rows - 1) * GAP) / rows;
    let w = cw, h = ch;
    if (w / h > 1.9) w = h * 1.9; else if (w / h < 1.25) h = w / 1.25;
    if (w * h > best.a) best = {a: w * h, w, h, cols, rows};
  }
  const {w, h, cols, rows} = best, y0 = (H - (rows * h + (rows - 1) * GAP)) / 2;
  items.forEach((el, i) => {
    const r = Math.floor(i / cols), inRow = r === rows - 1 ? n - r * cols : cols, c = i - r * cols;
    const x0 = (W - (inRow * w + (inRow - 1) * GAP)) / 2;
    place(el, x0 + c * (w + GAP), y0 + r * (h + GAP), w, h, w < 240 || h < 150);
  });
}
new ResizeObserver(() => layout()).observe(grid);
function setFocus(id) {
  focus = id && tiles.has(id) ? id : null;
  render(); renderMembers(); updateQuality();
}

/* ---------- Receber as telas de quem transmite ----------
   Cada pessoa recebe todas as telas ao vivo. A ampliada vem em qualidade total;
   as miniaturas vêm mais leves, para não pesar no upload de quem transmite. */
function qualityFor(id) {
  if (focus) return focus === id ? 'hi' : 'lo';
  return liveIds().filter(x => x !== myId).length <= 2 ? 'hi' : 'lo';
}
function askScreen(id, re) { const e = scr.get(id) || {call: null, stream: null}; e.q = qualityFor(id); e.at = Date.now(); scr.set(id, e); toRoom({t: 'watch', to: id, q: e.q, re: !!re}); }
function dropScreen(id) { const e = scr.get(id); if (!e) return; scr.delete(id); if (e.call) e.call.close(); toRoom({t: 'unwatch', to: id}); }
function updateQuality() { scr.forEach((e, id) => { const q = qualityFor(id); if (e.q !== q) { e.q = q; toRoom({t: 'watch', to: id, q}); } }); }
function reconcile() {
  const live = new Set(liveIds().filter(id => id !== myId));
  [...scr.keys()].forEach(id => { if (!live.has(id)) dropScreen(id); });
  live.forEach(id => { if (!scr.has(id)) askScreen(id); });
  const camOn = new Set(lastList.filter(u => u.cam).map(u => u.id));
  [...cams.keys()].forEach(id => { if (!camOn.has(id)) { const c = cams.get(id); cams.delete(id); if (c.call) c.call.close(); } });
  if (focus && !byId(focus)) focus = null;
  updateQuality(); render();
}
function onCall(c) {
  const k = c.metadata && c.metadata.kind;
  if (k === 'voice') return onVoiceCall(c);
  if (k === 'cam') return onCamCall(c);
  const e = scr.get(c.peer);
  if (!e) { c.close(); return; }
  if (e.call && e.call !== c) { const o = e.call; e.call = null; o.close(); }
  e.call = c; e.stream = null; last = {};
  c.answer(undefined, {sdpTransform: s => boost(s, (c.metadata && c.metadata.br) || 12)});
  c.on('stream', s => { if (e.call !== c || scr.get(c.peer) !== e) return; e.stream = s; render(); });
  c.on('close', () => { if (e.call !== c) return; e.call = null; e.stream = null; e.at = Date.now() - 3500; render(); });
}

/* ---------- Câmera ---------- */
let camBusy = false;
async function camStart() {
  if (camBusy || !navigator.mediaDevices) return;
  camBusy = true;
  try {
    const ms = await navigator.mediaDevices.getUserMedia({video: {deviceId: S.camDev ? {exact: S.camDev} : undefined, width: {ideal: 1280}, height: {ideal: 720}, frameRate: {ideal: 30}}});
    if (myCam) myCam.getTracks().forEach(t => { t.onended = null; t.stop(); });
    myCam = ms;
    const t = ms.getVideoTracks()[0]; t.contentHint = 'motion'; t.onended = () => camStop();
    [...camOut.values()].forEach(c => c.close()); camOut.clear();
    toRoom({t: 'cam', on: true}); paintCam(); syncCam(); render();
    if (!devOk) refreshDevices();
  } catch (e) {
    toast(e && e.name === 'NotAllowedError' ? 'O navegador bloqueou a câmera. Libere o acesso no cadeado ao lado do endereço.' : 'Não foi possível abrir a câmera. Confira se outro programa está usando ela.', 'err');
    paintCam();
  }
  camBusy = false;
}
function camStop() {
  if (!myCam) return;
  myCam.getTracks().forEach(t => { t.onended = null; t.stop(); }); myCam = null;
  [...camOut.values()].forEach(c => c.close()); camOut.clear();
  toRoom({t: 'cam', on: false}); paintCam(); render();
}
function syncCam() {
  if (!myCam || !peer || !myId) return;
  const ids = new Set(lastList.map(u => u.id).filter(id => id !== myId));
  camOut.forEach((c, id) => { if (!ids.has(id)) { c.close(); camOut.delete(id); } });
  ids.forEach(id => {
    if (camOut.has(id)) return;
    const c = peer.call(id, myCam, {metadata: {kind: 'cam'}});
    if (!c) return;
    camOut.set(id, c);
    c.on('close', () => { if (camOut.get(id) === c) camOut.delete(id); if (myCam) setTimeout(syncCam, 2000); });
    [800, 3000].forEach(t => setTimeout(() => tuneCam(c), t));
  });
}
function tuneCam(c) {
  const pc = c.peerConnection; if (!pc) return;
  pc.getSenders().forEach(async s => {
    if (!s.track || s.track.kind !== 'video') return;
    const p = s.getParameters(); if (!p.encodings || !p.encodings.length) p.encodings = [{}];
    p.encodings[0].maxBitrate = 1.2e6; p.encodings[0].maxFramerate = 30;
    try { await s.setParameters(p); } catch (e) {}
  });
}
function onCamCall(c) {
  const old = cams.get(c.peer); if (old && old.call && old.call !== c) old.call.close();
  const e = {call: c, stream: null}; cams.set(c.peer, e);
  c.answer(undefined);
  c.on('stream', s => { if (cams.get(c.peer) !== e) return; e.stream = s; render(); });
  c.on('close', () => { if (cams.get(c.peer) === e) { cams.delete(c.peer); render(); } });
}
function paintCam() {
  const on = !!myCam;
  $$('.camB').forEach(b => {
    b.classList.toggle('on', on); b.querySelector('use').setAttribute('href', on ? '#i-cam' : '#i-camoff');
    b.dataset.tip = on ? 'Desligar câmera' : 'Ligar câmera'; b.setAttribute('aria-label', b.dataset.tip); b.setAttribute('aria-pressed', on);
  });
  const sw = $('#camSw'); if (sw) sw.checked = on;
  const row = $('.mrow[data-src=cam]'); if (row) row.classList.toggle('off', !on);
}

/* ---------- Enviar minha tela para quem pediu ---------- */
function pref(sdp, codec) {
  if (codec === 'auto') return sdp;
  const ls = sdp.split('\r\n'), mi = ls.findIndex(l => l.startsWith('m=video')); if (mi < 0) return sdp;
  const pts = ls.map(l => l.match(new RegExp('^a=rtpmap:(\\d+) ' + codec + '/', 'i'))).filter(Boolean).map(m => m[1]);
  if (!pts.length) return sdp;
  const rtx = ls.map(l => l.match(/^a=fmtp:(\d+) apt=(\d+)/)).filter(m => m && pts.includes(m[2])).map(m => m[1]);
  const first = [...pts, ...rtx], p = ls[mi].split(' '), rest = p.slice(3);
  ls[mi] = [...p.slice(0, 3), ...first.filter(x => rest.includes(x)), ...rest.filter(x => !first.includes(x))].join(' ');
  return ls.join('\r\n');
}
function boost(sdp, mbps) {
  const k = Math.round(mbps * 1000), x = 'x-google-start-bitrate=' + Math.round(k * .8) + ';x-google-min-bitrate=' + Math.round(k * .4) + ';x-google-max-bitrate=' + k;
  const ls = sdp.split('\r\n'), has = new Set(ls.map(l => l.match(/^a=fmtp:(\d+) /)).filter(Boolean).map(m => m[1])), out = []; let v = false;
  for (const l of ls) {
    if (l.startsWith('m=')) v = l.startsWith('m=video');
    const f = l.match(/^a=fmtp:(\d+) (.*)/);
    if (v && f && !/apt=/.test(f[2])) { out.push(l + ';' + x); continue; }
    out.push(l);
    const r = l.match(/^a=rtpmap:(\d+) (VP8|VP9|AV1|H264)\//i);
    if (v && r && !has.has(r[1])) out.push('a=fmtp:' + r[1] + ' ' + x);
  }
  return out.join('\r\n');
}
const outQ = new Map();
function closeOut(id) { const c = outCalls.get(id); outQ.delete(id); if (c) { outCalls.delete(id); c.close(); } }
function sendStream(to, q, re) {
  if (!stream || !to || to === myId || !peer) return;
  outQ.set(to, q === 'lo' ? 'lo' : 'hi');
  if (outCalls.has(to) && !re) return tune(outCalls.get(to), outQ.get(to));
  const qq = outQ.get(to); closeOut(to); outQ.set(to, qq);
  const c = peer.call(to, stream, {metadata: {kind: 'screen', br: S.br}, sdpTransform: s => boost(pref(s.replace(/useinbandfec=1/g, 'useinbandfec=1;stereo=1;sprop-stereo=1;maxaveragebitrate=' + S.abr * 1000), S.codec), S.br)});
  if (!c) return;
  outCalls.set(to, c);
  c.on('close', () => { if (outCalls.get(to) === c) outCalls.delete(to); });
  [800, 3000].forEach(t => setTimeout(() => tune(c, outQ.get(to)), t));
}
function tune(c, q = 'hi') {
  const pc = c.peerConnection; if (!pc) return;
  pc.getSenders().forEach(async s => {
    if (!s.track) return;
    const p = s.getParameters(); if (!p.encodings || !p.encodings.length) p.encodings = [{}];
    if (s.track.kind === 'video') {
      const lo = q === 'lo';
      p.encodings[0].maxBitrate = (lo ? Math.min(S.br, 1.5) : S.br) * 1e6; p.encodings[0].maxFramerate = lo ? Math.min(S.fps, 24) : S.fps;
      p.encodings[0].scaleResolutionDownBy = lo ? Math.max(1, RES[S.res][0] / 960) : 1;
      p.degradationPreference = !camMode && S.prio === 'detail' ? 'maintain-resolution' : 'maintain-framerate';
      p.encodings[0].networkPriority = 'high'; p.encodings[0].priority = 'high';
    } else p.encodings[0].maxBitrate = S.abr * 1000;
    try { await s.setParameters(p); } catch (e) {}
  });
}

/* ---------- Sala: o anfitrião repassa os avisos; vídeo vai direto entre as pessoas ---------- */
function toRoom(m) {
  if (isHost) { if (!myId) return false; onRoom(myId, m); return true; }
  if (hostConn && hostConn.open) { hostConn.send(m); return true; }
  return false;
}
/* mensagens que chegam do anfitrião (no anfitrião, ele mesmo chama) */
function onMsg(d) {
  if (!d) return;
  if (d.t === 'full') { full = true; setStatus('Sala cheia', 'Já há ' + d.max + (d.max > 1 ? ' convidados.' : ' convidado.') + ' Peça ao anfitrião para liberar mais vagas.'); }
  else if (d.t === 'msg' || d.t === 'sys') addMsg(d);
  else if (d.t === 'users') {
    const firstReady = !roomReady;
    lastList = Array.isArray(d.list) ? d.list : []; roomReady = true;
    lastList.forEach(u => { if (!okH(u.avh) && u.av) avFromData(u.av).then(h => { const x = byId(u.id); if (h && x && !x.avh) { x.avh = h; avRefresh(); } }); });
    checkVersions();
    if (firstReady && S.mxMic && !VO.on) voiceMic();
    const ids = new Set(lastList.map(u => u.id)); [...outCalls.keys()].forEach(id => { if (!ids.has(id)) closeOut(id); });
    renderMembers(); reconcile(); syncVoice(); syncCam(); avNeedAll();
  }
  else if (d.t === 'avget') { if (!isHost && okH(d.h) && d.h === myAvH) avSend(hostConn, d.h); }
  else if (d.t === 'avc') { if (!isHost) avRecv(d); }
  else if (d.t === 'watchreq') sendStream(d.from, d.q, d.re);
  else if (d.t === 'unwatchreq') closeOut(d.from);
  else if (d.t === 'pause' && d.id !== myId && scr.has(d.id)) toast(d.v ? d.name + ' pausou a imagem' : d.name + ' retomou a imagem', d.v ? 'info' : 'ok');
}
/* só no anfitrião: mensagens de qualquer pessoa da sala, inclusive dele mesmo */
const bcast = m => guests.forEach(g => g.conn.open && g.conn.send(m));
const deliver = (id, m) => { if (id === myId) return onMsg(m); const g = guests.get(id); if (g && g.conn.open) g.conn.send(m); };
function post(m) { m.t = 'msg'; addMsg(m); bcast(m); }
function sys(text) { const m = {t: 'sys', text}; addMsg(m); bcast(m); }
function users() {
  const old = [...guests.values()].some(g => g.name && !g.ver);
  const list = [{id: myId, name: me, host: true, ver: APP_VER, av: old ? avData[myAvH] || '' : '', avh: myAvH, live: !!stream, mic: VO.on, cam: !!myCam}];
  guests.forEach((g, id) => g.name && list.push({id, name: g.name, ver: g.ver || 0, av: old && g.avh ? avData[g.avh] || '' : '', avh: g.avh, live: !!g.live, mic: !!g.mic, cam: !!g.cam}));
  bcast({t: 'users', list}); onMsg({t: 'users', list});
}
/* convidado na versão antiga manda a foto como texto: converte para o formato novo */
function legacyIn(g, from, d) {
  if (g.avh || !d.av) return;
  avFromData(d.av).then(h => { if (h && guests.get(from) === g && !g.avh) { g.avh = h; users(); } });
}
function onRoom(from, d) {
  const g = from === myId ? null : guests.get(from);
  if (!d || (from !== myId && !g)) return;
  const name = g ? g.name || 'Convidado' : me;
  if (d.t === 'hello' && g) {
    const fresh = !g.name; g.name = clean(d.name) || 'Convidado'; g.avh = okH(d.avh); g.ver = +d.ver || 0; legacyIn(g, from, d); g.live = !!d.live; g.mic = !!d.mic; g.cam = !!d.cam;
    if (fresh) sys(g.name + ' entrou na sala'); users();
  }
  else if (d.t === 'profile') { if (g) { g.avh = okH(d.avh); if (d.ver) g.ver = +d.ver; legacyIn(g, from, d); } users(); }
  else if (d.t === 'avget') {
    const h = okH(d.h); if (!h) return;
    if (avUrl[h]) { if (g) avSend(g.conn, h); return; }
    if (g) (avWait[h] = avWait[h] || new Set()).add(from);
    const owner = [...guests.entries()].find(([, x]) => x.avh === h);
    if (owner && !avAsked.has(h)) { avAsked.add(h); deliver(owner[0], {t: 'avget', h}); setTimeout(() => avAsked.delete(h), 30000); }
  }
  else if (d.t === 'avc' && g && g.avh === okH(d.h)) avRecv(d);
  else if (d.t === 'voice') { if (g) g.mic = !!d.on; users(); }
  else if (d.t === 'cam') { if (g) g.cam = !!d.on; users(); }
  else if (d.t === 'msg') { const text = String(d.text || '').trim().slice(0, 500); if (text) post({name, text, ts: Date.now(), host: !g}); }
  else if (d.t === 'live') { const on = !!d.on; if (g) { if (g.live === on) return; g.live = on; } sys(name + (on ? ' começou a transmitir' : ' parou de transmitir')); users(); }
  else if (d.t === 'watch' && typeof d.to === 'string') deliver(d.to, {t: 'watchreq', from, q: d.q === 'lo' ? 'lo' : 'hi', re: !!d.re});
  else if (d.t === 'unwatch' && typeof d.to === 'string') deliver(d.to, {t: 'unwatchreq', from});
  else if (d.t === 'pause') { const m = {t: 'pause', id: from, name, v: !!d.v}; bcast(m); onMsg(m); }
}
function startPeer(id) {
  peer = id ? new Peer(id, {config: ICE}) : new Peer({config: ICE});
  peer.on('disconnected', () => { if (!peer.destroyed) peer.reconnect(); });
  peer.on('call', onCall);
  return peer;
}
async function initHost() {
  setStatus('Preparando a sala…', '');
  await loadIce();
  let id; try { id = localStorage.getItem('tl-id'); } catch (e) {}
  if (!id) { id = 'tl' + Math.random().toString(36).slice(2, 10); try { localStorage.setItem('tl-id', id); } catch (e) {} }
  startPeer(id);
  peer.on('open', pid => {
    myId = pid;
    $('#link').value = location.href.split(/[?#]/)[0] + '?v=' + pid; $('#hint').classList.remove('warn'); $('#hint').textContent = 'Mantenha esta aba aberta: ela mantém a sala funcionando para todos.';
    users();
  });
  peer.on('error', e => {
    if (e.type === 'unavailable-id') { try { localStorage.removeItem('tl-id'); } catch (_) {} location.reload(); }
    else if (e.type !== 'peer-unavailable') { $('#hint').classList.add('warn'); $('#hint').textContent = 'Falha na conexão com o servidor (' + e.type + '). Recarregue a página para tentar de novo.'; }
  });
  peer.on('connection', conn => {
    conn.on('open', () => {
      if (!guests.has(conn.peer) && guests.size >= S.max) { conn.send({t: 'full', max: S.max}); setTimeout(() => conn.close(), 500); return; }
      const old = guests.get(conn.peer); if (old && old.conn !== conn) { try { old.conn.close(); } catch (_) {} }
      guests.set(conn.peer, {conn, name: old ? old.name : '', av: old ? old.av : '', live: old ? old.live : false});
    });
    conn.on('data', d => { const g = guests.get(conn.peer); if (g && g.conn === conn) onRoom(conn.peer, d); });
    conn.on('close', () => {
      const g = guests.get(conn.peer);
      if (g && g.conn === conn) { guests.delete(conn.peer); closeOut(conn.peer); if (g.name) sys(g.name + ' saiu da sala'); users(); }
    });
  });
}
async function initViewer() {
  setStatus('Conectando à sala…', '');
  $('#link').value = location.href.split('#')[0];
  await loadIce();
  startPeer();
  peer.on('open', pid => { myId = pid; connect(); });
  peer.on('error', e => {
    if (e.type === 'peer-unavailable' && !roomReady) { setStatus('Aguardando o anfitrião', 'A página dele ainda não está aberta. Tentando de novo…'); retry(3000); }
    else if (['network', 'server-error', 'socket-error', 'socket-closed'].includes(e.type)) { setStatus('Sem conexão', 'Verifique sua internet. Tentando de novo…'); retry(4000); }
  });
}
function retry(ms) { clearTimeout(retryT); retryT = setTimeout(connect, ms); }
function connect() {
  clearTimeout(retryT);
  if (full || !peer || peer.destroyed) return;
  if (peer.disconnected) { peer.reconnect(); return retry(2000); }
  if (hostConn && hostConn.open) return;
  const c = peer.connect(target, {reliable: true}); hostConn = c;
  if (!c) return retry(3000);
  c.on('open', () => { if (hostConn !== c) return; c.send({t: 'hello', name: me, ver: APP_VER, av: avData[myAvH] || '', avh: myAvH, live: !!stream, mic: VO.on, cam: !!myCam}); setStatus('Conectado', 'Carregando a sala…'); });
  c.on('data', d => { if (hostConn === c) onMsg(d); });
  c.on('close', () => {
    if (hostConn !== c || full) return;
    hostConn = null; roomReady = false; focus = null; lastList = [];
    scr.forEach(e => e.call && e.call.close()); scr.clear(); cams.forEach(e => e.call && e.call.close()); cams.clear();
    [...camOut.values()].forEach(x => x.close()); camOut.clear(); [...VO.out.values()].forEach(x => x.close()); VO.out.clear();
    render(); setStatus('Conexão com a sala perdida', 'O anfitrião pode ter fechado a página. Reconectando…'); retry(2000);
  });
}

/* ---------- Transmitir ---------- */
async function start() {
  const wantCam = S.src === 'cam', md = navigator.mediaDevices;
  if (!(md && (wantCam ? md.getUserMedia : md.getDisplayMedia))) return toast(wantCam ? 'Este navegador não consegue abrir a câmera.' : 'Este navegador não compartilha a tela. Use Chrome ou Edge no computador.', 'err');
  if (!roomReady) return toast('Aguarde a conexão com a sala para transmitir.', 'info');
  const [w, h] = RES[S.res], cam = S.src === 'cam';
  setGo('wait'); mixCtx();
  try {
    disp = cam
      /* webcam: pede a resolução e a taxa de quadros escolhidas e deixa a câmera entregar o melhor que tiver. O som vai pelo microfone da sala */
      ? await navigator.mediaDevices.getUserMedia({video: {deviceId: S.camDev ? {ideal: S.camDev} : undefined, width: {ideal: w}, height: {ideal: h}, frameRate: {ideal: S.fps}, aspectRatio: {ideal: 16 / 9}}, audio: false})
      : await navigator.mediaDevices.getDisplayMedia({
        video: {width: {ideal: w}, height: {ideal: h}, frameRate: {ideal: S.fps}},
        audio: {echoCancellation: false, noiseSuppression: false, autoGainControl: false, channelCount: 2, sampleRate: 48000, restrictOwnAudio: true},
        selfBrowserSurface: 'exclude', surfaceSwitching: 'include', systemAudio: 'include', windowAudio: 'window'
      });
  } catch (e) {
    disp = null; setGo(false);
    const n = e && e.name;
    toast(!cam ? 'Compartilhamento cancelado ou bloqueado pelo navegador.'
      : n === 'NotAllowedError' ? 'O navegador bloqueou a câmera. Libere no cadeado ao lado do endereço.'
      : n === 'NotFoundError' ? 'Nenhuma câmera encontrada neste computador.'
      : n === 'NotReadableError' ? 'A câmera está em uso por outro programa. Feche-o e tente de novo.'
      : 'Não foi possível abrir a câmera.', cam ? 'err' : 'info');
    return;
  }
  camMode = cam;
  const vt = disp.getVideoTracks()[0];
  vt.contentHint = !cam && S.prio === 'detail' ? 'detail' : 'motion'; vt.onended = stop;
  if (cam) {
    refreshDevices();
    const st = vt.getSettings();
    if (st.width && (st.width < w * .95 || (st.frameRate && st.frameRate < S.fps * .9))) toast('A câmera está entregando ' + st.width + '×' + st.height + (st.frameRate ? ' a ' + Math.round(st.frameRate) + ' fps' : '') + ' nessa configuração.', 'info');
  }
  const hasAudio = disp.getAudioTracks().length > 0;
  /* ao compartilhar uma guia, o navegador entrega só o som dela (sem o resto do computador e sem a sala): é a separação certa */
  tabAudio = hasAudio && !cam && (vt.getSettings().displaySurface === 'browser');
  attach('screen', hasAudio ? new MediaStream(disp.getAudioTracks()) : null);
  preview = new MediaStream([vt]);
  stream = new MediaStream([vt, MX.dest.stream.getAudioTracks()[0]]);
  await openInput('extra');
  if (HP.ok) { try { await helperNode(); } catch (e) {} }
  helperStream();
  $('#hint').classList.toggle('warn', !cam && !hasAudio && !S.mxMic && !S.mxExtra && !(HP.ok && S.mxApps));
  $('#hint').textContent = tabAudio ? (HP.ok && S.mxApps && appsOn() ? 'Som da guia e dos apps escolhidos incluído.' : 'Som só da guia compartilhada incluído. O resto do computador fica de fora.') : cam ? (HP.ok && S.mxApps && appsOn() ? 'Webcam ao vivo, com o som dos apps escolhidos.' : S.mxMic ? 'Webcam ao vivo. Sua voz vai pelo microfone da sala.' : 'Webcam ao vivo. Ligue o microfone (tecla V) para falar com a sala.') : HP.ok && S.mxApps ? (appsOn() ? 'Som dos apps escolhidos incluído. Ajuste no mixer de áudio.' : 'Nenhum app marcado: abra o mixer de áudio e marque os apps que devem entrar na transmissão.') : hasAudio ? 'Som da tela incluído. Ajuste as fontes no mixer de áudio.' : 'Sem som da tela: ao compartilhar, marque “Compartilhar áudio do sistema” (tela inteira) ou “Compartilhar áudio da guia”.';
  setGo(true); toast('Você está transmitindo', 'ok');
  toRoom({t: 'live', on: true});
  render();
}
function stop() {
  if (!stream) return;
  disp.getTracks().forEach(t => { t.onended = null; t.stop(); });
  ['screen', 'extra'].forEach(k => detach(k, k !== 'screen'));
  stream = null; camMode = false; tabAudio = false; helperStream(); monitor(false); disp = null; preview = null; paused = false;
  $$('[data-act=pause] use').forEach(u => u.setAttribute('href', '#i-pause'));
  $$('[data-act=pause]').forEach(b => { b.dataset.tip = 'Pausar imagem'; b.classList.remove('on'); });
  [...outCalls.keys()].forEach(closeOut);
  last = {}; setGo(false);
  toRoom({t: 'live', on: false});
  $('#hint').classList.remove('warn'); $('#hint').textContent = 'Transmissão encerrada. O link da sala continua o mesmo.';
  reconcile();
}
function setGo(on) {
  goState = on;
  const b = $('#go'); b.disabled = on === 'wait';
  b.classList.toggle('on', on === true); b.setAttribute('aria-pressed', on === true);
  b.querySelector('use').setAttribute('href', on === true ? '#i-sharestop' : S.src === 'cam' ? '#i-cam' : '#i-share');
  b.dataset.tip = on === 'wait' ? (S.src === 'cam' ? 'Abrindo a câmera…' : 'Escolha a tela…') : on ? 'Parar de transmitir' : 'Transmitir minha ' + (S.src === 'cam' ? 'webcam' : 'tela'); b.setAttribute('aria-label', b.dataset.tip);
}
const toggle = () => stream ? stop() : start();
$('#go').onclick = $('#vcStop').onclick = toggle;
let copyT;
async function copyLink() {
  const el = $('#link');
  if (!/^https?:/.test(el.value)) return toast('O link ainda está sendo gerado. Tente em alguns segundos.', 'info');
  try { await navigator.clipboard.writeText(el.value); } catch (e) { el.select(); document.execCommand('copy'); }
  const b = $('#copy'); b.classList.add('done'); $('#copyT').textContent = 'Copiado';
  clearTimeout(copyT); copyT = setTimeout(() => { b.classList.remove('done'); $('#copyT').textContent = 'Copiar link'; }, 1800);
  toast('Link da sala copiado', 'ok');
}
$('#copy').onclick = copyLink;
$('#link').onfocus = e => e.target.select();
$('#newRoom').onclick = async () => {
  if (!await ask('Criar uma nova sala?', 'O link atual deixa de funcionar e todos na sala serão desconectados.', 'Criar nova sala')) return;
  try { localStorage.removeItem('tl-id'); } catch (e) {}
  location.reload();
};

/* ---------- Estatísticas e novas tentativas ---------- */
setInterval(async () => {
  if (roomReady) scr.forEach((e, id) => { if (!e.call && Date.now() - (e.at || 0) > 6000) askScreen(id, true); });
  if (stream) $('#vcS').textContent = outCalls.size ? outCalls.size + (outCalls.size > 1 ? ' pessoas assistindo' : ' pessoa assistindo') : 'Ninguém assistindo ainda';
  const fid = focus && scr.get(focus) && scr.get(focus).call ? focus : [...scr.keys()].find(id => scr.get(id).call);
  const watching = !!fid;
  const c = watching ? scr.get(fid).call : outCalls.values().next().value;
  const pc = c && c.peerConnection;
  const who = watching ? byId(fid) : null;
  if (!pc) return;
  if (last.c !== c) last = {c};
  let rep; try { rep = await pc.getStats(); } catch (e) { return; }
  const cod = {}; let st = null, rtt = null, rel = false;
  rep.forEach(x => { if (x.type === 'codec' && x.mimeType) cod[x.id] = x.mimeType.replace(/^.*\//, ''); });
  rep.forEach(x => {
    if (x.kind === 'video' && (x.type === 'inbound-rtp' || x.type === 'outbound-rtp')) {
      const b = x.bytesReceived != null ? x.bytesReceived : x.bytesSent;
      const mbps = last.t && x.timestamp > last.t ? Math.max(0, (b - last.b) * 8 / ((x.timestamp - last.t) / 1000) / 1e6) : 0;
      last.b = b; last.t = x.timestamp;
      st = {w: x.frameWidth || '?', h: x.frameHeight || '?', fps: Math.round(x.framesPerSecond || 0), mbps, codec: cod[x.codecId] || '-', lim: x.qualityLimitationReason, loss: x.packetsLost};
    }
    if (x.type === 'candidate-pair' && x.nominated && x.currentRoundTripTime != null) {
      rtt = Math.round(x.currentRoundTripTime * 1000);
      const lc = rep.get(x.localCandidateId), rc = rep.get(x.remoteCandidateId);
      rel = !!((lc && lc.candidateType === 'relay') || (rc && rc.candidateType === 'relay'));
    }
  });
  if (!st) return;
  if (rel && !last.w && relayName !== 'Cloudflare') { last.w = 1; toast('Esta conexão passa por um servidor público intermediário e pode ficar lenta. Veja as estatísticas (S).', 'info'); }
  const L = {none: 'nenhuma', bandwidth: 'upload insuficiente', cpu: 'processador no limite', other: 'outra'};
  const rows = [[watching ? 'Tela de' : 'Enviando', watching ? who && who.name : 'sua tela'], ['Resolução', st.w + '×' + st.h], ['Quadros', st.fps + ' fps'], ['Taxa', st.mbps.toFixed(1) + ' Mbps'], ['Codec', st.codec],
    ['Latência', rtt != null ? rtt + ' ms' : '-'], ['Conexão', rel ? 'via ' + relayName : 'direta']];
  if (st.loss != null) rows.push(['Pacotes perdidos', st.loss]);
  if (st.lim) rows.push(['Limitação', L[st.lim] || st.lim]);
  $('#stats').textContent = rows.map(r => r[0].padEnd(18, ' ') + r[1]).join('\n');
}, 1000);

/* ---------- Início ---------- */
$$('select[data-k]').forEach(makeSelect);
try { $('#ni').value = localStorage.getItem('tl-name') || ''; } catch (e) {}
sync(); showPane('p-tx'); paintMe(); syncVol(); setGo(false); paintCam(); refreshDevices(); paintApps();
$('#camSw').onchange = e => { if (e.target.checked !== !!myCam) act.cam(); };
if (S.helperSeen && isWin) { helperConnect(false); setInterval(() => { if (!HP.ok) helperConnect(false); }, 8000); }
if (target) { $('#welT').textContent = 'Entrar na sala'; $('#welD').textContent = 'Escolha como você vai aparecer para os outros e no chat.'; $('#joinB').textContent = 'Entrar na sala'; }
else $('#joinB').textContent = 'Criar minha sala';
$$('.pick').forEach(b => b.onclick = () => $('#avFile').click());
$$('.avrm').forEach(b => b.onclick = async () => { if (myAv) { await setAv(null); toast('Foto removida', 'ok'); } });
$('#avFile').onchange = async e => { const f = e.target.files[0]; e.target.value = ''; if (!f) return; try { await setAv(await loadAvatar(f)); } catch (m) { toast(typeof m === 'string' ? m : 'Não foi possível usar essa imagem.', 'err'); } };
$('#ni').addEventListener('input', paintMe);
$('#nf').onsubmit = e => {
  e.preventDefault();
  me = clean($('#ni').value);
  if (!me) { const c = $('#nf'); c.classList.remove('shake'); void c.offsetWidth; c.classList.add('shake'); $('#ni').focus(); return; }
  try { localStorage.setItem('tl-name', me); } catch (_) {}
  paintMe(); $('#meName').textContent = me; $('#meRole').textContent = isHost ? 'Anfitrião' : 'Convidado';
  $('#modal').classList.add('out'); setTimeout(() => $('#modal').remove(), 220);
  addMsg({t: 'sys', text: 'Você entrou como ' + me});
  audioSession();
  if (S.mxMic) mixCtx();
  isHost ? initHost() : initViewer();
};
addEventListener('resize', moveInd);
requestAnimationFrame(() => requestAnimationFrame(() => document.body.classList.remove('booting')));
