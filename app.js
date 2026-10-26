'use strict';
const $ = s => document.querySelector(s), $$ = s => [...document.querySelectorAll(s)];
const vid = $('#v'), badge = $('#badge'), stage = $('#stage'), root = document.documentElement;
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
let want = null, inCall = null, inStream = null, reqAt = 0, wantMuted = true, deaf = false;
const clean = s => String(s || '').trim().slice(0, 20);
const hue = n => { let h = 0; for (const c of n) h = (h * 31 + c.charCodeAt(0)) % 360; return h; };
const play = () => { const p = vid.play(); if (p) p.catch(() => { if (!vid.muted) { wantMuted = true; vid.muted = true; needSound(); vid.play().catch(() => {}); } }); };
/* mostra "Ativar som" quando o navegador (principalmente no celular) bloqueou o som até um toque */
function needSound() { const b = document.querySelector('#sound'); if (b) b.hidden = false; if (typeof syncVol === 'function') syncVol(); }
/* iPhone: sem isso, a página obedece à chave de silencioso e o som pode sair pelo alto-falante de ligação */
function audioSession() { try { if (navigator.audioSession) navigator.audioSession.type = VO.on ? 'play-and-record' : 'playback'; } catch (e) {} }
const narrow = () => matchMedia('(max-width:900px)').matches;

/* ---------- Fotos de perfil: ficam no navegador e só viajam pela conexão da sala ---------- */
const avatars = {}; let myAv = '';
const okAv = s => typeof s === 'string' && s.length < 900000 && /^data:image\/(png|jpe?g|gif|webp);base64,[A-Za-z0-9+/=]+$/.test(s) ? s : '';
try { myAv = okAv(localStorage.getItem('tl-av') || ''); } catch (e) {}
const pic = (el, src) => { el.textContent = ''; el.style.background = 'center/cover no-repeat url("' + src + '")'; };
const initial = (el, n) => { el.textContent = (n[0] || '?').toUpperCase(); el.style.background = 'hsl(' + hue(n) + ',42%,40%)'; };
const avatar = (el, n) => { const src = n === me && myAv ? myAv : avatars[n]; src ? pic(el, src) : initial(el, n); };
function paintMe() {
  $$('.mepic').forEach(el => myAv ? pic(el, myAv) : initial(el, me || clean($('#ni') && $('#ni').value) || '?'));
}
function loadAvatar(file) {
  return new Promise((res, rej) => {
    if (!file || !file.type.startsWith('image/')) return rej('Escolha um arquivo de imagem.');
    const fr = new FileReader();
    fr.onerror = () => rej('Não foi possível ler esse arquivo.');
    fr.onload = () => {
      if (file.type === 'image/gif' && file.size <= 600 * 1024) return res(fr.result);
      const img = new Image();
      img.onerror = () => rej('Não foi possível abrir essa imagem.');
      img.onload = () => {
        const c = document.createElement('canvas'); c.width = c.height = 160;
        const s = Math.min(img.width, img.height);
        c.getContext('2d').drawImage(img, (img.width - s) / 2, (img.height - s) / 2, s, s, 0, 0, 160, 160);
        if (file.type === 'image/gif') toast('GIF acima de 600 KB: foi usado só o primeiro quadro.', 'info');
        res(c.toDataURL('image/webp', .85));
      };
      img.src = fr.result;
    };
    fr.readAsDataURL(file);
  });
}
function setAv(src) {
  myAv = src;
  try { src ? localStorage.setItem('tl-av', src) : localStorage.removeItem('tl-av'); } catch (e) { toast('Sem espaço para salvar a foto. Ela vale só nesta sessão.', 'err'); }
  paintMe();
  if (src) toast('Foto atualizada', 'ok');
  if (!me) return;
  toRoom({t: 'profile', av: myAv});
}

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
  $('#camSel').hidden = S.src !== 'cam'; setGo(goState);
  $$('.micB').forEach(b => { b.classList.toggle('on', S.mxMic); b.querySelector('use').setAttribute('href', S.mxMic ? '#i-mic' : '#i-micoff'); b.dataset.tip = S.mxMic ? 'Desligar microfone' : 'Ligar microfone'; });
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
  outCalls.forEach(tune);
}
$$('[data-k]').forEach(el => el.addEventListener(el.type === 'checkbox' ? 'change' : 'input', () => {
  const k = el.dataset.k;
  S[k] = el.type === 'checkbox' ? el.checked : el.dataset.n !== undefined ? +el.value : el.value;
  save(); sync(); if (['res', 'fps', 'br', 'prio', 'abr'].includes(k)) live(k);
  mixChanged(k);
  if (k === 'max' && isHost && me) users();
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
  const m = wantMuted || vid.volume === 0;
  $$('#muteB use').forEach(u => u.setAttribute('href', m ? '#i-mute' : '#i-vol'));
  const r = $('#vol'); r.value = wantMuted ? 0 : vid.volume; fill(r);
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
    if (!vid.srcObject) return toast('Comece ou aguarde a transmissão para usar imagem sobre imagem.', 'info');
    vid.requestPictureInPicture ? vid.requestPictureInPicture().catch(() => toast('Imagem sobre imagem indisponível agora.', 'err')) : toast('Seu navegador não suporta imagem sobre imagem.', 'err');
  },
  deaf: () => { deaf = !deaf; paintDeaf(); toast(deaf ? 'Som da sala desligado: você não ouve vozes nem telas' : 'Som da sala ligado', deaf ? 'info' : 'ok'); },
  mute: () => { wantMuted = !wantMuted; if (!wantMuted && vid.volume === 0) vid.volume = 1; $('#sound').hidden = true; applyMute(); syncVol(); },
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
vid.ondblclick = act.fs;
let it; const wake = () => { stage.classList.add('act'); clearTimeout(it); it = setTimeout(() => stage.classList.remove('act'), 2800); };
['pointermove', 'pointerdown'].forEach(e => stage.addEventListener(e, wake));
stage.addEventListener('pointerleave', () => { clearTimeout(it); it = setTimeout(() => stage.classList.remove('act'), 600); });
document.addEventListener('keydown', e => {
  if (e.key === 'Escape') {
    if (openDD) return openDD.close();
    if ($('#drawer').classList.contains('open')) return drawer(false);
    if (document.body.classList.contains('navopen')) return nav(false);
    return;
  }
  if ($('#modal') || !$('#confirm').hidden || e.target.closest('input,select,textarea,[contenteditable]') || e.ctrlKey || e.metaKey || e.altKey) return;
  const k = e.key.toLowerCase(), m = {f: 'fs', t: 'theater', c: 'chat', s: 'stats', m: 'mute', p: 'pause', v: 'mic', d: 'deaf'}[k];
  if (m) { e.preventDefault(); act[m](); wake(); }
});
$('#sound').onclick = () => { audioSession(); wantMuted = false; if (vid.volume === 0) vid.volume = 1; applyMute(); play(); VO.inc.forEach(v => v.el.play().catch(() => {})); if (MX.ctx && MX.ctx.state === 'suspended') MX.ctx.resume().catch(() => {}); $('#sound').hidden = true; syncVol(); };
$('#vol').oninput = e => { vid.volume = +e.target.value; wantMuted = vid.volume === 0; $('#sound').hidden = true; applyMute(); syncVol(); };
const applyMute = () => { vid.muted = want === myId || wantMuted || deaf; };

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
  return MX.ctx;
}
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
  exclusive(k);
  if (k === 'mxScreen' || k === 'vScreen') { gain('screen'); paintApps(); }
  else if (k === 'vMic') gain('mic');
  else if (k === 'vExtra') gain('extra');
  else if (k === 'mxApps' || k === 'vApps') { gain('apps'); helperStream(); }
  else if (k === 'mxMic' || k === 'micDev') voiceMic();
  else if (k === 'outDev') applySinks();
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
function applySinks() { sinkOf(vid); VO.inc.forEach(v => sinkOf(v.el)); }
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
  const b = $('#headB'); b.classList.toggle('deaf', deaf); b.querySelector('use').setAttribute('href', deaf ? '#i-deaf' : '#i-headset');
  b.dataset.tip = deaf ? 'Ligar o som da sala' : 'Desligar o som da sala';
}
/* anel verde em quem está falando */
const lvl = (an, buf) => { an.getByteTimeDomainData(buf); let s = 0; for (const x of buf) { const y = (x - 128) / 128; s += y * y; } return Math.sqrt(s / buf.length); };
/* o nível de quem fala vem das estatísticas da conexão, sem passar o som pelo Web Audio (no iPhone isso mudava o som de lugar) */
setInterval(async () => {
  const talking = new Set();
  if (VO.on && MX.nodes.mic && lvl(MX.nodes.mic.an, MX.nodes.mic.buf) > .02) talking.add(myId);
  for (const [id, v] of VO.inc) {
    const pc = v.call.peerConnection; if (!pc || deaf) continue;
    try { (await pc.getStats()).forEach(x => { if (x.type === 'inbound-rtp' && x.kind === 'audio' && (x.audioLevel || 0) > .03) talking.add(id); }); } catch (e) {}
  }
  $$('.mem').forEach(r => r.querySelector('.av').classList.toggle('speak', talking.has(r.dataset.id)));
  $$('#avs .av').forEach(a => a.classList.toggle('speak', talking.has(a.dataset.id)));
}, 250);
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
const HP = {ws: null, ok: false, apps: [], node: null, poll: 0, error: null, ver: '', sig: ''};
const HELPER_LATEST = '1.3.1';
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
    if (typeof e.data !== 'string') { if (HP.node) HP.node.port.postMessage(new Float32Array(e.data), [e.data]); return; }
    let d; try { d = JSON.parse(e.data); } catch (_) { return; }
    if (d.t === 'hello') { HP.ver = d.ver || '1.0.0'; paintApps(); }
    else if (d.t === 'levels') { $$('.app').forEach(r => { const v = d.l && d.l[r.dataset.key]; r.style.setProperty('--al', Math.min(1, (v || 0) * 3.2).toFixed(3)); r.classList.toggle('lv', v != null); }); }
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
  $('#appsSub').textContent = 'Cineminha Áudio conectado · ' + appsOn() + ' de ' + HP.apps.length + ' apps';
}
$('#appDl').addEventListener('click', () => { $('#appGetH').hidden = false; helperPoll(180000); });
$('#appDl2').addEventListener('click', () => { toast('Antes de abrir o arquivo novo, feche o atual: ícone azul perto do relógio › Sair.', 'info'); helperPoll(180000); });
$('#appConn').onclick = () => { $('#appGetH').hidden = false; helperConnect(true); helperPoll(60000); };

/* ---------- Chat ---------- */
let lastAuthor = null;
function addMsg(m) {
  const box = $('#msgs'), d = document.createElement('div');
  if (m.t === 'sys') { d.className = 'sys'; d.textContent = m.text; lastAuthor = null; }
  else {
    const cont = lastAuthor && lastAuthor.name === m.name && m.ts - lastAuthor.ts < 180000;
    d.className = 'msg' + (cont ? ' cont' : '');
    d.innerHTML = '<div class="av"></div><div><div class="mh"><b></b><i class="tag" hidden>Anfitrião</i><time></time></div><p></p></div>';
    avatar(d.querySelector('.av'), m.name);
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

/* ---------- Membros e telas ao vivo ---------- */
let lastList = [];
const byId = id => lastList.find(u => u.id === id);
const liveIds = () => lastList.filter(u => u.live).map(u => u.id);
function renderMembers() {
  const list = lastList;
  list.forEach(u => { u.av = okAv(u.av); if (u.av) avatars[u.name] = u.av; else delete avatars[u.name]; });
  const el = $('#members'), av = $('#avs'), known = new Set([...el.children].map(c => c.dataset.id));
  el.textContent = ''; av.textContent = '';
  list.forEach(u => {
    const r = document.createElement('div'), mine = u.id === myId, can = u.live && !mine && u.id !== want;
    r.className = 'mem' + (can ? ' can' : '') + (u.live && u.id === want && !mine ? ' cur' : ''); r.dataset.id = u.id;
    if (known.has(u.id)) r.style.animation = 'none';
    r.innerHTML = '<div class="av on"></div><div class="mi"><b></b><small></small></div>' + (can ? '<span class="watch">Assistir</span>' : u.mic && mine ? '<svg class="i vmic"><use href="#i-mic"/></svg>' : '');
    avatar(r.querySelector('.av'), u.name); r.querySelector('b').textContent = u.name + (mine ? ' (você)' : '');
    const sm = r.querySelector('small');
    sm.textContent = u.live ? (mine ? 'Transmitindo agora' : u.id === want ? 'Você está assistindo' : 'Transmitindo agora') : u.host ? 'Anfitrião' : 'Na sala';
    sm.classList.toggle('live', !!u.live);
    if (can) { r.tabIndex = 0; r.setAttribute('role', 'button'); r.setAttribute('aria-label', 'Assistir a tela de ' + u.name); r.onclick = () => { nav(false); watch(u.id); }; r.onkeydown = e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); r.click(); } }; }
    if (!mine && (u.mic || vMuted.has(u.id))) {
      const b = document.createElement('button'); b.type = 'button'; b.className = 'ibtn vmute';
      b.innerHTML = '<svg class="i"><use href="#i-mic"/></svg>';
      b.onclick = e => { e.stopPropagation(); toggleVoiceMute(u.id, u.name, b); };
      b.onkeydown = e => e.stopPropagation();
      paintVoiceMute(b, u.id, u.name); r.append(b);
    }
    el.append(r);
    if (av.children.length < 5) { const a = document.createElement('div'); a.className = 'av on' + (u.live ? ' talk' : ''); avatar(a, u.name); a.title = u.name; a.dataset.id = u.id; av.append(a); }
    if (u.host) {
      const ri = $('#roomIcon'); if (u.av) pic(ri, u.av); else { ri.style.background = ''; ri.textContent = (u.name[0] || '?').toUpperCase(); }
      const t = 'Sala de ' + u.name; $('#roomName').textContent = $('#roomT').textContent = t; document.title = t + ' · Cineminha';
      ri.dataset.tip = t;
    }
  });
  $('#memTitle').textContent = 'Na sala, ' + list.length;
  const ppl = list.length + (list.length > 1 ? ' pessoas' : ' pessoa');
  $('#chatCount').textContent = ppl; $('#count').textContent = ppl + (isHost ? ' (máx. ' + (S.max + 1) + ')' : '');
}
function renderScreens() {
  const box = $('#screens'), ids = liveIds();
  box.hidden = !ids.length;
  const known = new Set([...box.children].map(c => c.dataset.id));
  box.textContent = '';
  ids.forEach(id => {
    const u = byId(id), b = document.createElement('button'), mine = id === myId;
    b.className = 'scr'; b.dataset.id = id; b.setAttribute('role', 'tab'); b.setAttribute('aria-selected', id === want);
    if (known.has(id)) b.style.animation = 'none';
    b.innerHTML = '<div class="av"></div><span></span><i aria-hidden="true"></i>';
    avatar(b.querySelector('.av'), u.name); b.querySelector('span').textContent = mine ? 'Sua tela' : 'Tela de ' + u.name;
    b.onclick = () => watch(id);
    box.append(b);
  });
}
function paintLive() {
  const any = liveIds().length > 0;
  $('#badgeT').textContent = any ? 'ao vivo' : 'offline'; badge.classList.toggle('on', any);
  $('#rw').classList.toggle('live', any); $('#sideDot').classList.toggle('on', any); $('#navLive').hidden = !any;
  $('#vc').hidden = !stream; document.body.classList.toggle('presenting', !!stream);
}
function setStatus(text, sub) { $('#phText').textContent = text || ''; $('#phSub').textContent = sub || ''; }
function showVideo(on) { $('#ph').hidden = on; stage.classList.toggle('live', on); if (!on) $('#res').textContent = ''; }
/* desenha o palco conforme o que estou assistindo */
function render() {
  document.body.classList.toggle('selfview', want === myId);
  if (want === myId && preview) {
    if (vid.srcObject !== preview) vid.srcObject = preview;
    applyMute(); play(); showVideo(true); $('#sound').hidden = true;
  } else if (want && inStream) {
    if (vid.srcObject !== inStream) { vid.srcObject = inStream; $('#sound').hidden = !wantMuted; sinkOf(vid); }
    applyMute(); play(); showVideo(true);
  } else {
    vid.srcObject = null; $('#sound').hidden = true; showVideo(false);
    if (!roomReady) return;
    const u = want && byId(want);
    if (u) setStatus('Conectando à tela de ' + u.name + '…', 'A imagem aparece em alguns segundos.');
    else if (navigator.mediaDevices && (navigator.mediaDevices.getDisplayMedia || navigator.mediaDevices.getUserMedia)) setStatus('Ninguém está transmitindo', 'Compartilhe sua tela com a sala ou espere alguém começar. Todos podem transmitir.');
    else setStatus('Ninguém está transmitindo', 'Assim que alguém começar, a tela aparece aqui. Para transmitir, use Chrome ou Edge no computador.');
  }
  syncVol(); renderScreens(); paintLive();
}

/* ---------- Assistir ---------- */
function closeIn() { const c = inCall; inCall = null; inStream = null; if (c) c.close(); }
function requestWatch() { reqAt = Date.now(); toRoom({t: 'watch', to: want}); }
function watch(id) {
  if (id === want) return;
  if (want && want !== myId) toRoom({t: 'unwatch', to: want});
  closeIn(); last = {};
  want = id;
  if (id && id !== myId) requestWatch();
  render(); renderMembers();
}
/* chamado sempre que a lista da sala muda: escolhe sozinho uma tela quando a atual some */
function reconcile() {
  const ids = liveIds();
  if (want && want !== myId && !ids.includes(want)) { closeIn(); want = null; }
  if (want === myId && !stream) want = null;
  if (!want) { const pick = ids.find(id => id !== myId); if (pick) { want = pick; requestWatch(); } else if (stream) want = myId; }
  render();
}
function onCall(c) {
  if (c.metadata && c.metadata.kind === 'voice') return onVoiceCall(c);
  if (c.peer !== want) { c.close(); return; }
  if (inCall && inCall !== c) { const o = inCall; inCall = null; o.close(); }
  inCall = c; last = {};
  c.answer(undefined, {sdpTransform: s => boost(s, (c.metadata && c.metadata.br) || 12)});
  c.on('stream', s => { if (inCall !== c) return; inStream = s; render(); });
  c.on('close', () => { if (inCall !== c) return; inCall = null; inStream = null; reqAt = Date.now() - 3500; render(); });
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
function closeOut(id) { const c = outCalls.get(id); if (c) { outCalls.delete(id); c.close(); } }
function sendStream(to) {
  if (!stream || !to || to === myId || !peer) return;
  closeOut(to);
  const c = peer.call(to, stream, {metadata: {br: S.br}, sdpTransform: s => boost(pref(s.replace(/useinbandfec=1/g, 'useinbandfec=1;stereo=1;sprop-stereo=1;maxaveragebitrate=' + S.abr * 1000), S.codec), S.br)});
  if (!c) return;
  outCalls.set(to, c);
  c.on('close', () => { if (outCalls.get(to) === c) outCalls.delete(to); });
  [800, 3000].forEach(t => setTimeout(() => tune(c), t));
}
function tune(c) {
  const pc = c.peerConnection; if (!pc) return;
  pc.getSenders().forEach(async s => {
    if (!s.track) return;
    const p = s.getParameters(); if (!p.encodings || !p.encodings.length) p.encodings = [{}];
    if (s.track.kind === 'video') {
      p.encodings[0].maxBitrate = S.br * 1e6; p.encodings[0].maxFramerate = S.fps;
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
    if (firstReady && S.mxMic && !VO.on) voiceMic();
    const ids = new Set(lastList.map(u => u.id)); [...outCalls.keys()].forEach(id => { if (!ids.has(id)) closeOut(id); });
    renderMembers(); reconcile(); syncVoice();
  }
  else if (d.t === 'watchreq') sendStream(d.from);
  else if (d.t === 'unwatchreq') closeOut(d.from);
  else if (d.t === 'pause' && d.id === want && d.id !== myId) toast(d.v ? d.name + ' pausou a imagem' : d.name + ' retomou a imagem', d.v ? 'info' : 'ok');
}
/* só no anfitrião: mensagens de qualquer pessoa da sala, inclusive dele mesmo */
const bcast = m => guests.forEach(g => g.conn.open && g.conn.send(m));
const deliver = (id, m) => { if (id === myId) return onMsg(m); const g = guests.get(id); if (g && g.conn.open) g.conn.send(m); };
function post(m) { m.t = 'msg'; addMsg(m); bcast(m); }
function sys(text) { const m = {t: 'sys', text}; addMsg(m); bcast(m); }
function users() {
  const list = [{id: myId, name: me, host: true, av: myAv, live: !!stream, mic: VO.on}];
  guests.forEach((g, id) => g.name && list.push({id, name: g.name, av: g.av, live: !!g.live, mic: !!g.mic}));
  bcast({t: 'users', list}); onMsg({t: 'users', list});
}
function onRoom(from, d) {
  const g = from === myId ? null : guests.get(from);
  if (!d || (from !== myId && !g)) return;
  const name = g ? g.name || 'Convidado' : me;
  if (d.t === 'hello' && g) {
    const fresh = !g.name; g.name = clean(d.name) || 'Convidado'; g.av = okAv(d.av); g.live = !!d.live; g.mic = !!d.mic;
    if (fresh) sys(g.name + ' entrou na sala'); users();
  }
  else if (d.t === 'profile') { if (g) g.av = okAv(d.av); users(); }
  else if (d.t === 'voice') { if (g) g.mic = !!d.on; users(); }
  else if (d.t === 'msg') { const text = String(d.text || '').trim().slice(0, 500); if (text) post({name, text, ts: Date.now(), host: !g}); }
  else if (d.t === 'live') { const on = !!d.on; if (g) { if (g.live === on) return; g.live = on; } sys(name + (on ? ' começou a transmitir' : ' parou de transmitir')); users(); }
  else if (d.t === 'watch' && typeof d.to === 'string') deliver(d.to, {t: 'watchreq', from});
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
  c.on('open', () => { if (hostConn !== c) return; c.send({t: 'hello', name: me, av: myAv, live: !!stream, mic: VO.on}); setStatus('Conectado', 'Carregando a sala…'); });
  c.on('data', d => { if (hostConn === c) onMsg(d); });
  c.on('close', () => {
    if (hostConn !== c || full) return;
    hostConn = null; roomReady = false; closeIn(); want = null; lastList = [];
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
        selfBrowserSurface: 'exclude', surfaceSwitching: 'include', systemAudio: 'include'
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
  if (!want || !liveIds().includes(want)) { closeIn(); want = myId; }
  toRoom({t: 'live', on: true});
  render();
}
function stop() {
  if (!stream) return;
  disp.getTracks().forEach(t => { t.onended = null; t.stop(); });
  ['screen', 'extra'].forEach(k => detach(k, k !== 'screen'));
  stream = null; camMode = false; tabAudio = false; helperStream(); disp = null; preview = null; paused = false;
  $$('[data-act=pause] use').forEach(u => u.setAttribute('href', '#i-pause'));
  $$('[data-act=pause]').forEach(b => { b.dataset.tip = 'Pausar imagem'; b.classList.remove('on'); });
  [...outCalls.keys()].forEach(closeOut);
  if (want === myId) { want = null; $('#stats').hidden = true; }
  last = {}; setGo(false);
  if (document.pictureInPictureElement && want === null) document.exitPictureInPicture().catch(() => {});
  toRoom({t: 'live', on: false});
  $('#hint').classList.remove('warn'); $('#hint').textContent = 'Transmissão encerrada. O link da sala continua o mesmo.';
  reconcile();
}
function setGo(on) {
  goState = on;
  ['#go', '#goBig'].forEach(s => {
    const b = $(s); b.disabled = on === 'wait';
    b.querySelector('span').textContent = on === 'wait' ? (S.src === 'cam' ? 'Abrindo a câmera…' : 'Escolha a tela…') : on ? 'Parar transmissão' : 'Transmitir minha ' + (S.src === 'cam' ? 'webcam' : 'tela');
    b.querySelector('use').setAttribute('href', on === true ? '#i-stop' : '#i-play'); b.classList.toggle('stop', on === true);
  });
}
const toggle = () => stream ? stop() : start();
$('#go').onclick = $('#goBig').onclick = $('#vcStop').onclick = toggle;
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
  if (want && want !== myId && !inCall && roomReady && liveIds().includes(want) && Date.now() - reqAt > 6000) requestWatch();
  const watching = want && want !== myId;
  const c = watching ? inCall : outCalls.values().next().value;
  const pc = c && c.peerConnection;
  const who = watching ? byId(want) : null;
  if (!pc || !vid.srcObject) { if (want === myId && preview) { const s = preview.getVideoTracks()[0].getSettings(); $('#res').textContent = 'Sua tela · ' + (s.width || '?') + '×' + (s.height || '?') + ' · ' + Math.round(s.frameRate || 0) + ' fps'; $('#vcS').textContent = 'Ninguém assistindo ainda'; } return; }
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
  const line = st.w + '×' + st.h + ' · ' + st.fps + ' fps · ' + st.mbps.toFixed(1) + ' Mbps';
  $('#res').textContent = (who ? who.name + ' · ' : 'Sua tela · ') + line;
  if (stream) $('#vcS').textContent = outCalls.size ? outCalls.size + (outCalls.size > 1 ? ' pessoas assistindo' : ' pessoa assistindo') : 'Ninguém assistindo ainda';
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
sync(); showPane('p-tx'); paintMe(); syncVol(); setGo(false); refreshDevices(); paintApps();
if (S.helperSeen && isWin) { helperConnect(false); setInterval(() => { if (!HP.ok) helperConnect(false); }, 8000); }
if (target) { $('#welT').textContent = 'Entrar na sala'; $('#welD').textContent = 'Escolha como você vai aparecer para os outros e no chat.'; $('#joinB').textContent = 'Entrar na sala'; }
else $('#joinB').textContent = 'Criar minha sala';
$$('.pick').forEach(b => b.onclick = () => $('#avFile').click());
$$('.avrm').forEach(b => b.onclick = () => { if (myAv) { setAv(''); toast('Foto removida', 'ok'); } });
$('#avFile').onchange = async e => { const f = e.target.files[0]; e.target.value = ''; if (!f) return; try { setAv(await loadAvatar(f)); } catch (m) { toast(String(m), 'err'); } };
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
