'use strict';
const $ = s => document.querySelector(s), $$ = s => [...document.querySelectorAll(s)];
const vid = $('#v'), badge = $('#badge'), stage = $('#stage'), root = document.documentElement;
const target = new URLSearchParams(location.search).get('v');
document.body.classList.add(target ? 'viewer' : 'host');
const ICE = {iceServers: [
  {urls: 'stun:stun.l.google.com:19302'}, {urls: 'stun:stun1.l.google.com:19302'},
  {urls: ['turn:openrelay.metered.ca:80', 'turn:openrelay.metered.ca:443', 'turn:openrelay.metered.ca:443?transport=tcp'], username: 'openrelayproject', credential: 'openrelayproject'}
]};
const RES = {720: [1280, 720], 1080: [1920, 1080], 1440: [2560, 1440], 2160: [3840, 2160]};
const PRE = {
  bal: {res: 1080, fps: 30, br: 6, prio: 'motion'}, alta: {res: 1080, fps: 60, br: 12, prio: 'motion'},
  max: {res: 1080, fps: 60, br: 25, prio: 'motion'}, txt: {res: 1080, fps: 30, br: 10, prio: 'detail'}
};
const S = {theme: 'dark', accent: '#5B7CFA', calm: false, res: 1080, fps: 60, br: 12, prio: 'motion', codec: 'auto', abr: 320, max: 2};
try { Object.assign(S, JSON.parse(localStorage.getItem('tl-set') || '{}')); } catch (e) {}
if (!['dark', 'classic', 'oled', 'light'].includes(S.theme)) S.theme = 'dark';
if (!/^#[0-9a-f]{6}$/i.test(S.accent)) S.accent = '#5B7CFA';
/* versão 8 tinha âmbar como padrão: quem ficou com ele sem escolher volta ao azul uma única vez */
try { if (!localStorage.getItem('tl-acc2')) { if (S.accent.toUpperCase() === '#F2B544') S.accent = '#5B7CFA'; localStorage.setItem('tl-acc2', '1'); } } catch (e) {}
let peer, stream, call, hostConn, me = '', full = false, paused = false, last = {}, retryT = 0, unread = 0;
const viewers = new Map();
const clean = s => String(s || '').trim().slice(0, 20);
const hue = n => { let h = 0; for (const c of n) h = (h * 31 + c.charCodeAt(0)) % 360; return h; };
const play = () => { const p = vid.play(); if (p) p.catch(() => {}); };
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
  if (!target) users(); else if (hostConn && hostConn.open) hostConn.send({t: 'profile', av: myAv});
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
  const opts = [...sel.options].map((o, i) => {
    const it = document.createElement('div'); it.className = 'dd-opt'; it.setAttribute('role', 'option'); it.id = l.id + '-' + i; it.dataset.v = o.value;
    it.innerHTML = '<span></span>' + (o.dataset.d ? '<small></small>' : '') + '<svg class="i"><use href="#i-check"/></svg>';
    it.querySelector('span').textContent = o.textContent; if (o.dataset.d) it.querySelector('small').textContent = o.dataset.d;
    it.onpointermove = () => hl(i);
    it.onclick = () => choose(i);
    l.append(it); return it;
  });
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
  sel._refresh = refresh; refresh();
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
  $('#need').textContent = 'Upload necessário: cerca de ' + Math.ceil((S.br + S.abr / 1000) * S.max) + ' Mbps para ' + S.max + (S.max > 1 ? ' pessoas' : ' pessoa') + '. Teste sua velocidade antes de transmitir.';
  if (!target && me) $('#count').textContent = viewers.size + ' de ' + S.max + ' espectadores';
}
const save = () => { try { localStorage.setItem('tl-set', JSON.stringify(S)); } catch (e) {} };
function live(k) {
  if (!stream) return;
  const vt = stream.getVideoTracks()[0];
  vt.contentHint = S.prio === 'detail' ? 'detail' : 'motion';
  if (!k || k === 'res' || k === 'fps') {
    const [w, h] = RES[S.res];
    vt.applyConstraints({width: {ideal: w}, height: {ideal: h}, frameRate: {ideal: S.fps}})
      .then(() => { const s = vt.getSettings(); toast('Captura: ' + s.width + '×' + s.height + ', ' + Math.round(s.frameRate) + ' fps', 'ok'); })
      .catch(() => toast('Não foi possível mudar a captura agora.', 'err'));
  }
  viewers.forEach(v => v.call && tune(v.call));
}
$$('[data-k]').forEach(el => el.addEventListener(el.type === 'checkbox' ? 'change' : 'input', () => {
  const k = el.dataset.k;
  S[k] = el.type === 'checkbox' ? el.checked : el.dataset.n !== undefined ? +el.value : el.value;
  save(); sync(); if (['res', 'fps', 'br', 'prio', 'abr'].includes(k)) live(k);
  if (k === 'max' && !target && me) users();
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
  const m = vid.muted || vid.volume === 0;
  $$('#muteB use').forEach(u => u.setAttribute('href', m ? '#i-mute' : '#i-vol'));
  $('#headB').classList.toggle('off', m);
  const r = $('#vol'); r.value = vid.muted ? 0 : vid.volume; fill(r);
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
  settings: () => { nav(false); showPane(target ? 'p-ap' : ($('.tab.on') ? $('.tab.on').dataset.p : 'p-tx')); drawer(true); },
  pip: () => {
    if (document.pictureInPictureElement) return document.exitPictureInPicture();
    if (!vid.srcObject) return toast('Comece ou aguarde a transmissão para usar imagem sobre imagem.', 'info');
    vid.requestPictureInPicture ? vid.requestPictureInPicture().catch(() => toast('Imagem sobre imagem indisponível agora.', 'err')) : toast('Seu navegador não suporta imagem sobre imagem.', 'err');
  },
  mute: () => { vid.muted = !vid.muted; if (!vid.muted && vid.volume === 0) vid.volume = 1; $('#sound').hidden = true; syncVol(); },
  pause: () => {
    if (!stream) return toast('Inicie a transmissão antes de pausar.', 'info');
    paused = !paused; stream.getTracks().forEach(t => t.enabled = !paused);
    bcast({t: 'pause', v: paused});
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
  const k = e.key.toLowerCase(), m = {f: 'fs', t: 'theater', c: 'chat', s: 'stats', m: target ? 'mute' : '', p: target ? '' : 'pause'}[k];
  if (m) { e.preventDefault(); act[m](); wake(); }
});
$('#sound').onclick = () => { vid.muted = false; if (vid.volume === 0) vid.volume = 1; play(); $('#sound').hidden = true; syncVol(); };
$('#vol').oninput = e => { vid.volume = +e.target.value; vid.muted = vid.volume === 0; $('#sound').hidden = true; syncVol(); };

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
let lastList = [];
function renderMembers(list) {
  lastList = list;
  list.forEach(u => { u.av = okAv(u.av); if (u.av) avatars[u.name] = u.av; else delete avatars[u.name]; });
  const el = $('#members'), av = $('#avs'), on = badge.classList.contains('on'), known = new Set([...el.children].map(c => c.dataset.n));
  el.textContent = ''; av.textContent = '';
  list.forEach(u => {
    const r = document.createElement('div'); r.className = 'mem'; r.dataset.n = u.name;
    if (known.has(u.name)) r.style.animation = 'none';
    r.innerHTML = '<div class="av on"></div><div class="mi"><b></b><small></small></div>';
    avatar(r.querySelector('.av'), u.name); r.querySelector('b').textContent = u.name + (u.name === me ? ' (você)' : '');
    const sm = r.querySelector('small'); sm.textContent = u.host ? (on ? 'Transmitindo agora' : 'Anfitrião') : 'Assistindo'; sm.classList.toggle('live', !!(u.host && on));
    el.append(r);
    if (av.children.length < 5) { const a = document.createElement('div'); a.className = 'av on' + (u.host && on ? ' talk' : ''); avatar(a, u.name); a.title = u.name; av.append(a); }
    if (u.host) {
      const ri = $('#roomIcon'); if (u.av) pic(ri, u.av); else { ri.style.background = ''; ri.textContent = (u.name[0] || '?').toUpperCase(); }
      const t = 'Sala de ' + u.name; $('#roomName').textContent = $('#roomT').textContent = t; document.title = t + ' · Cineminha';
      ri.dataset.tip = t;
    }
  });
  $('#memTitle').textContent = 'Na sala, ' + list.length;
  $('#chatCount').textContent = list.length + (list.length > 1 ? ' pessoas' : ' pessoa');
}
const bcast = m => viewers.forEach(v => v.conn.open && v.conn.send(m));
function post(m) { m.t = 'msg'; addMsg(m); bcast(m); }
function sys(text) { const m = {t: 'sys', text}; addMsg(m); bcast(m); }
function users() {
  const list = [{name: me, host: true, av: myAv}];
  viewers.forEach(v => v.name && list.push({name: v.name, av: v.av}));
  renderMembers(list); bcast({t: 'users', list});
  $('#count').textContent = viewers.size + ' de ' + S.max + ' espectadores';
}
$('#mi').addEventListener('input', () => { $('#sendB').disabled = !$('#mi').value.trim(); });
$('#f').onsubmit = e => {
  e.preventDefault();
  const text = $('#mi').value.trim(); if (!text) return;
  $('#mi').value = ''; $('#sendB').disabled = true;
  if (!target) post({name: me, text, ts: Date.now(), host: true});
  else if (hostConn && hostConn.open) hostConn.send({t: 'msg', text});
  else addMsg({t: 'sys', text: 'Sem conexão com o anfitrião. Sua mensagem não foi enviada.'});
};
function setStatus(text, on, sub) {
  $('#ph').hidden = !!on; $('#phText').textContent = text || ''; $('#phSub').textContent = sub || '';
  $('#badgeT').textContent = on ? 'ao vivo' : 'offline'; badge.classList.toggle('on', !!on);
  $('#vc').hidden = !on; $('#rw').classList.toggle('live', !!on); stage.classList.toggle('live', !!on);
  $('#sideDot').classList.toggle('on', !!on); $('#navLive').hidden = !on;
  if (!on) { $('#res').textContent = ''; $('#vcS').textContent = 'Conectando…'; }
  if (lastList.length) renderMembers(lastList);
}

/* ---------- Anfitrião ---------- */
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
function initHost() {
  let id; try { id = localStorage.getItem('tl-id'); } catch (e) {}
  if (!id) { id = 'tl' + Math.random().toString(36).slice(2, 10); try { localStorage.setItem('tl-id', id); } catch (e) {} }
  peer = new Peer(id, {config: ICE});
  peer.on('open', () => { $('#link').value = location.href.split(/[?#]/)[0] + '?v=' + id; $('#hint').classList.remove('warn'); $('#hint').textContent = 'Mantenha esta aba aberta durante a transmissão.'; });
  peer.on('disconnected', () => { if (!peer.destroyed) peer.reconnect(); });
  peer.on('error', e => {
    if (e.type === 'unavailable-id') { try { localStorage.removeItem('tl-id'); } catch (_) {} location.reload(); }
    else if (e.type !== 'peer-unavailable') { $('#hint').classList.add('warn'); $('#hint').textContent = 'Falha na conexão com o servidor (' + e.type + '). Recarregue a página para tentar de novo.'; }
  });
  peer.on('connection', conn => {
    conn.on('open', () => {
      if (!viewers.has(conn.peer) && viewers.size >= S.max) { conn.send({t: 'full', max: S.max}); setTimeout(() => conn.close(), 500); return; }
      const old = viewers.get(conn.peer); if (old && old.conn !== conn) { try { old.conn.close(); } catch (_) {} if (old.call) old.call.close(); }
      viewers.set(conn.peer, {conn, name: old ? old.name : '', av: old ? old.av : ''});
      if (stream) callViewer(conn.peer);
      users();
    });
    conn.on('data', d => {
      const v = viewers.get(conn.peer); if (!v || v.conn !== conn || !d) return;
      if (d.t === 'hello') { const fresh = !v.name; v.name = clean(d.name) || 'Convidado'; v.av = okAv(d.av); if (fresh) sys(v.name + ' entrou na sala'); users(); if (paused) conn.send({t: 'pause', v: true}); }
      else if (d.t === 'profile') { v.av = okAv(d.av); users(); }
      else if (d.t === 'msg') { const text = String(d.text || '').trim().slice(0, 500); if (text) post({name: v.name || 'Convidado', text, ts: Date.now()}); }
    });
    conn.on('close', () => {
      const v = viewers.get(conn.peer);
      if (v && v.conn === conn) { if (v.call) v.call.close(); viewers.delete(conn.peer); if (v.name) sys(v.name + ' saiu da sala'); users(); }
    });
  });
  users();
  setStatus('Pronto para transmitir', false, 'Escolha a qualidade em Configurações, comece e envie o convite para quem vai assistir.');
}
async function start() {
  if (!(navigator.mediaDevices && navigator.mediaDevices.getDisplayMedia)) return toast('Este navegador não compartilha a tela. Use Chrome ou Edge no computador.', 'err');
  const [w, h] = RES[S.res];
  setGo('wait');
  try {
    stream = await navigator.mediaDevices.getDisplayMedia({
      video: {width: {ideal: w}, height: {ideal: h}, frameRate: {ideal: S.fps}},
      audio: {echoCancellation: false, noiseSuppression: false, autoGainControl: false, channelCount: 2, sampleRate: 48000},
      selfBrowserSurface: 'exclude', surfaceSwitching: 'include', systemAudio: 'include'
    });
  } catch (e) { stream = null; setGo(false); toast('Compartilhamento cancelado ou bloqueado pelo navegador.', 'info'); return; }
  const vt = stream.getVideoTracks()[0];
  vt.contentHint = S.prio === 'detail' ? 'detail' : 'motion'; vt.onended = stop;
  vid.srcObject = stream; vid.muted = true; play();
  const hasAudio = stream.getAudioTracks().length;
  $('#hint').classList.toggle('warn', !hasAudio);
  $('#hint').textContent = hasAudio ? 'Áudio incluído na transmissão.' : 'Sem áudio: ao compartilhar, marque “Compartilhar áudio do sistema” (tela inteira) ou “Compartilhar áudio da guia”.';
  setStatus('', true); setGo(true); toast('Você está ao vivo', 'ok');
  viewers.forEach((_, id) => callViewer(id));
}
function stop() {
  if (!stream) return;
  stream.getTracks().forEach(t => { t.onended = null; t.stop(); });
  stream = null; vid.srcObject = null; paused = false;
  $$('[data-act=pause] use').forEach(u => u.setAttribute('href', '#i-pause'));
  $$('[data-act=pause]').forEach(b => { b.dataset.tip = 'Pausar imagem'; b.classList.remove('on'); });
  viewers.forEach(v => { if (v.call) { v.call.close(); v.call = null; } });
  $('#stats').textContent = ''; $('#stats').hidden = true; last = {}; setGo(false);
  if (document.pictureInPictureElement) document.exitPictureInPicture().catch(() => {});
  setStatus('Transmissão encerrada', false, 'Clique em iniciar para transmitir de novo. O link continua o mesmo.');
}
function setGo(on) {
  ['#go', '#goBig'].forEach(s => {
    const b = $(s); b.disabled = on === 'wait';
    b.querySelector('span').textContent = on === 'wait' ? 'Escolha a tela…' : on ? 'Parar transmissão' : 'Iniciar transmissão';
    b.querySelector('use').setAttribute('href', on === true ? '#i-stop' : '#i-play'); b.classList.toggle('stop', on === true);
  });
}
function callViewer(id) {
  const v = viewers.get(id); if (!v || !stream) return;
  if (v.call) v.call.close();
  const c = peer.call(id, stream, {metadata: {br: S.br}, sdpTransform: s => boost(pref(s.replace(/useinbandfec=1/g, 'useinbandfec=1;stereo=1;sprop-stereo=1;maxaveragebitrate=' + S.abr * 1000), S.codec), S.br)});
  if (!c) return;
  v.call = c;
  c.on('close', () => { if (v.call === c) v.call = null; });
  [800, 3000].forEach(t => setTimeout(() => tune(c), t));
}
function tune(c) {
  const pc = c.peerConnection; if (!pc) return;
  pc.getSenders().forEach(async s => {
    if (!s.track) return;
    const p = s.getParameters(); if (!p.encodings || !p.encodings.length) p.encodings = [{}];
    if (s.track.kind === 'video') {
      p.encodings[0].maxBitrate = S.br * 1e6; p.encodings[0].maxFramerate = S.fps;
      p.degradationPreference = S.prio === 'detail' ? 'maintain-resolution' : 'maintain-framerate';
      p.encodings[0].networkPriority = 'high'; p.encodings[0].priority = 'high';
    } else p.encodings[0].maxBitrate = S.abr * 1000;
    try { await s.setParameters(p); } catch (e) {}
  });
}
const toggle = () => stream ? stop() : start();
$('#go').onclick = $('#goBig').onclick = $('#vcStop').onclick = toggle;
let copyT;
async function copyLink() {
  if (target) { try { await navigator.clipboard.writeText(location.href); toast('Link da sala copiado', 'ok'); } catch (e) {} return; }
  const el = $('#link');
  if (!/^https?:/.test(el.value)) return toast('O link ainda está sendo gerado. Tente em alguns segundos.', 'info');
  try { await navigator.clipboard.writeText(el.value); } catch (e) { el.select(); document.execCommand('copy'); }
  const b = $('#copy'); b.classList.add('done'); $('#copyT').textContent = 'Copiado';
  clearTimeout(copyT); copyT = setTimeout(() => { b.classList.remove('done'); $('#copyT').textContent = 'Copiar link'; }, 1800);
  toast('Link do convite copiado', 'ok');
}
$('#copy').onclick = copyLink;
$('#link').onfocus = e => e.target.select();
$('#newRoom').onclick = async () => {
  if (!await ask('Criar uma nova sala?', 'O link atual deixa de funcionar e quem estiver assistindo será desconectado.', 'Criar nova sala')) return;
  try { localStorage.removeItem('tl-id'); } catch (e) {}
  location.reload();
};

/* ---------- Espectador ---------- */
function initViewer() {
  setStatus('Conectando à sala…', false, '');
  peer = new Peer({config: ICE});
  peer.on('open', connect);
  peer.on('disconnected', () => { if (!peer.destroyed) peer.reconnect(); });
  peer.on('call', c => {
    if (call && call !== c) call.close();
    call = c; c.answer(undefined, {sdpTransform: s => boost(s, (c.metadata && c.metadata.br) || 12)});
    c.on('stream', s => {
      if (call !== c) return;
      vid.srcObject = s; vid.muted = true; play();
      setStatus('', true); $('#sound').hidden = false; syncVol();
    });
    c.on('close', () => {
      if (call !== c) return;
      call = null; vid.srcObject = null; $('#sound').hidden = true;
      setStatus('A transmissão terminou', false, 'A imagem volta sozinha quando o anfitrião recomeçar.');
    });
  });
  peer.on('error', e => {
    if (e.type === 'peer-unavailable') { setStatus('Aguardando o anfitrião', false, 'A página dele ainda não está aberta. Tentando de novo…'); retry(3000); }
    else if (['network', 'server-error', 'socket-error', 'socket-closed'].includes(e.type)) { setStatus('Sem conexão', false, 'Verifique sua internet. Tentando de novo…'); retry(4000); }
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
  c.on('open', () => { if (hostConn !== c) return; c.send({t: 'hello', name: me, av: myAv}); if (!vid.srcObject) setStatus('Conectado', false, 'Aguardando o anfitrião começar a transmissão.'); });
  c.on('data', d => {
    if (!d || hostConn !== c) return;
    if (d.t === 'full') { full = true; setStatus('Sala cheia', false, 'Já há ' + d.max + (d.max > 1 ? ' pessoas assistindo.' : ' pessoa assistindo.') + ' Peça ao anfitrião para liberar mais vagas.'); }
    else if (d.t === 'msg' || d.t === 'sys') addMsg(d);
    else if (d.t === 'users') { renderMembers(d.list); $('#count').textContent = Math.max(0, d.list.length - 1) + ' assistindo'; }
    else if (d.t === 'pause') toast(d.v ? 'O anfitrião pausou a imagem' : 'Transmissão retomada', d.v ? 'info' : 'ok');
  });
  c.on('close', () => {
    if (hostConn !== c || full) return;
    hostConn = null;
    setStatus('Conexão perdida', false, 'Reconectando…'); retry(2000);
  });
}

/* ---------- Estatísticas ---------- */
setInterval(async () => {
  const c = target ? call : [...viewers.values()].find(v => v.call);
  const cc = target ? c : c && c.call, pc = cc && cc.peerConnection;
  if (!pc || !vid.srcObject) return;
  if (last.c !== cc) last = {c: cc};
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
  if (rel && !last.w) { last.w = 1; toast('Esta conexão passa por um servidor intermediário e fica mais lenta. Veja as estatísticas (S).', 'info'); }
  $('#res').textContent = $('#vcS').textContent = st.w + '×' + st.h + ' · ' + st.fps + ' fps · ' + st.mbps.toFixed(1) + ' Mbps';
  const L = {none: 'nenhuma', bandwidth: 'upload insuficiente', cpu: 'processador no limite', other: 'outra'};
  const rows = [['Resolução', st.w + '×' + st.h], ['Quadros', st.fps + ' fps'], ['Taxa', st.mbps.toFixed(1) + ' Mbps'], ['Codec', st.codec],
    ['Latência', rtt != null ? rtt + ' ms' : '-'], ['Conexão', rel ? 'intermediada (lenta)' : 'direta']];
  if (st.loss != null) rows.push(['Pacotes perdidos', st.loss]);
  if (st.lim) rows.push(['Limitação', L[st.lim] || st.lim]);
  $('#stats').textContent = rows.map(r => r[0].padEnd(18, ' ') + r[1]).join('\n');
}, 1000);

/* ---------- Início ---------- */
$$('select[data-k]').forEach(makeSelect);
try { $('#ni').value = localStorage.getItem('tl-name') || ''; } catch (e) {}
sync(); showPane(target ? 'p-ap' : 'p-tx'); paintMe(); syncVol();
if (target) { $('#vcT').textContent = 'Assistindo ao vivo'; $('#welT').textContent = 'Entrar na transmissão'; $('#welD').textContent = 'Escolha como você vai aparecer para o anfitrião e no chat.'; $('#joinB').textContent = 'Entrar na sala'; }
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
  paintMe(); $('#meName').textContent = me; $('#meRole').textContent = target ? 'Espectador' : 'Anfitrião';
  $('#modal').classList.add('out'); setTimeout(() => $('#modal').remove(), 220);
  addMsg({t: 'sys', text: 'Você entrou como ' + me});
  if (!target && !(navigator.mediaDevices && navigator.mediaDevices.getDisplayMedia)) { $('#hint').classList.add('warn'); $('#hint').textContent = 'Este navegador não permite compartilhar a tela. Use Chrome ou Edge no computador.'; }
  target ? initViewer() : initHost();
};
addEventListener('resize', moveInd);
requestAnimationFrame(() => requestAnimationFrame(() => document.body.classList.remove('booting')));
