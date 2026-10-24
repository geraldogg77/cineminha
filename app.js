const $ = s => document.querySelector(s), $$ = s => [...document.querySelectorAll(s)];
const vid = $('#v'), badge = $('#badge'), stage = $('#stage'), root = document.documentElement;
const target = new URLSearchParams(location.search).get('v');
document.body.className = target ? 'viewer' : 'host';
const ICE = {iceServers: [
  {urls: 'stun:stun.l.google.com:19302'}, {urls: 'stun:stun1.l.google.com:19302'},
  {urls: ['turn:openrelay.metered.ca:80', 'turn:openrelay.metered.ca:443', 'turn:openrelay.metered.ca:443?transport=tcp'], username: 'openrelayproject', credential: 'openrelayproject'}
]};
const RES = {720: [1280, 720], 1080: [1920, 1080], 1440: [2560, 1440], 2160: [3840, 2160]};
const PRE = {
  bal: {res: 1080, fps: 30, br: 6, prio: 'motion'}, alta: {res: 1080, fps: 60, br: 12, prio: 'motion'},
  max: {res: 1080, fps: 60, br: 25, prio: 'motion'}, txt: {res: 1080, fps: 30, br: 10, prio: 'detail'}
};
const S = {theme: 'dark', accent: '#5865F2', calm: false, res: 1080, fps: 60, br: 12, prio: 'motion', codec: 'auto', abr: 320, max: 2};
try { Object.assign(S, JSON.parse(localStorage.getItem('tl-set') || '{}')); } catch (e) {}
let peer, stream, call, hostConn, me = '', full = false, paused = false, last = {};
const viewers = new Map();
const clean = s => String(s || '').trim().slice(0, 20);
const hue = n => { let h = 0; for (const c of n) h = (h * 31 + c.charCodeAt(0)) % 360; return h; };
/* Fotos de perfil: ficam no navegador de cada pessoa e só viajam pela conexão da sala */
const avatars = {}; let myAv = '';
const okAv = s => typeof s === 'string' && s.length < 900000 && /^data:image\/(png|jpe?g|gif|webp);base64,[A-Za-z0-9+/=]+$/.test(s) ? s : '';
try { myAv = okAv(localStorage.getItem('tl-av') || ''); } catch (e) {}
const pic = (el, src) => { el.textContent = ''; el.style.background = 'center/cover no-repeat url("' + src + '")'; };
const avatar = (el, n) => {
  const src = n === me && myAv ? myAv : avatars[n];
  if (src) return pic(el, src);
  el.textContent = (n[0] || '?').toUpperCase(); el.style.background = 'hsl(' + hue(n) + ',50%,42%)';
};
function paintMe() {
  $$('.mepic').forEach(el => {
    if (myAv) return pic(el, myAv);
    const n = me || clean($('#ni').value) || '?';
    el.textContent = n[0].toUpperCase(); el.style.background = 'hsl(' + hue(n) + ',50%,42%)';
  });
}
function loadAvatar(file) {
  return new Promise((res, rej) => {
    if (!file || !file.type.startsWith('image/')) return rej('Escolha um arquivo de imagem.');
    const fr = new FileReader();
    fr.onerror = () => rej('Não consegui ler esse arquivo.');
    fr.onload = () => {
      if (file.type === 'image/gif' && file.size <= 600 * 1024) return res(fr.result);
      const img = new Image();
      img.onerror = () => rej('Não consegui abrir essa imagem.');
      img.onload = () => {
        const c = document.createElement('canvas'); c.width = c.height = 160;
        const s = Math.min(img.width, img.height);
        c.getContext('2d').drawImage(img, (img.width - s) / 2, (img.height - s) / 2, s, s, 0, 0, 160, 160);
        if (file.type === 'image/gif') toast('GIF acima de 600 KB: usei só o primeiro quadro.');
        res(c.toDataURL('image/webp', .85));
      };
      img.src = fr.result;
    };
    fr.readAsDataURL(file);
  });
}
function setAv(src) {
  myAv = src;
  try { src ? localStorage.setItem('tl-av', src) : localStorage.removeItem('tl-av'); } catch (e) { toast('Sem espaço para salvar a foto: ela vale só nesta sessão.'); }
  paintMe();
  if (!me) return;
  if (!target) users(); else if (hostConn && hostConn.open) hostConn.send({t: 'profile', av: myAv});
}
let tt; function toast(m) { const t = $('#toast'); t.textContent = m; t.classList.add('on'); clearTimeout(tt); tt = setTimeout(() => t.classList.remove('on'), 2600); }
const icon = (sel, id) => $$(sel + ' use').forEach(u => u.setAttribute('href', '#' + id));

/* ---------- Configurações ---------- */
function sync() {
  root.dataset.theme = S.theme; root.style.setProperty('--accent', S.accent); root.classList.toggle('calm', S.calm);
  $$('[data-k]').forEach(el => { const v = S[el.dataset.k]; if (el.type === 'checkbox') el.checked = v; else el.value = v; });
  $('#acc').value = S.accent;
  $$('.sw button').forEach(b => b.classList.toggle('on', b.dataset.c.toLowerCase() === S.accent.toLowerCase()));
  $('#brv').textContent = S.br + ' Mbps';
  $('#need').textContent = 'Upload necessário: cerca de ' + Math.ceil((S.br + S.abr / 1000) * S.max) + ' Mbps para ' + S.max + (S.max > 1 ? ' pessoas' : ' pessoa') + '. Teste sua velocidade antes de transmitir.';
}
const save = () => { try { localStorage.setItem('tl-set', JSON.stringify(S)); } catch (e) {} };
function live(k) {
  if (!stream) return;
  const vt = stream.getVideoTracks()[0];
  vt.contentHint = S.prio === 'detail' ? 'detail' : 'motion';
  if (!k || k === 'res' || k === 'fps') {
    const [w, h] = RES[S.res];
    vt.applyConstraints({width: {ideal: w}, height: {ideal: h}, frameRate: {ideal: S.fps}})
      .then(() => { const s = vt.getSettings(); toast('Captura: ' + s.width + '×' + s.height + ' · ' + Math.round(s.frameRate) + ' fps'); })
      .catch(() => toast('Não foi possível mudar a captura agora.'));
  }
  viewers.forEach(v => v.call && tune(v.call));
}
$$('[data-k]').forEach(el => el.oninput = () => {
  const k = el.dataset.k;
  S[k] = el.type === 'checkbox' ? el.checked : el.dataset.n !== undefined ? +el.value : el.value;
  save(); sync(); if (['res', 'fps', 'br', 'prio', 'abr'].includes(k)) live(k);
});
$$('[data-pre]').forEach(b => b.onclick = () => { Object.assign(S, PRE[b.dataset.pre]); save(); sync(); live(); });
$$('.sw button').forEach(b => b.onclick = () => { S.accent = b.dataset.c; save(); sync(); });
$('#acc').oninput = e => { S.accent = e.target.value; save(); sync(); };
function showPane(id) { $$('.tab').forEach(t => t.classList.toggle('on', t.dataset.p === id)); $$('.pane').forEach(p => p.hidden = p.id !== id); }
$$('.tab').forEach(t => t.onclick = () => showPane(t.dataset.p));
function drawer(o) { $('#drawer').classList.toggle('open', o); $('#scrim').classList.toggle('open', o); }
$('#scrim').onclick = $('#dclose').onclick = () => drawer(false);

/* ---------- Ações do player ---------- */
function syncVol() { const m = vid.muted || vid.volume === 0; icon('#muteB', m ? 'mute' : 'vol'); $('#headB').classList.toggle('off', m); }
const act = {
  fs: () => document.fullscreenElement ? document.exitFullscreen() : stage.requestFullscreen(),
  theater: () => document.body.classList.toggle('theater'),
  chat: () => document.body.classList.toggle('nochat'),
  invite: () => $('#copy').click(),
  stats: () => { $('#stats').hidden = !$('#stats').hidden; },
  settings: () => { showPane(target ? 'p-ap' : $('.tab.on') ? $('.tab.on').dataset.p : 'p-tx'); drawer(true); },
  pip: () => document.pictureInPictureElement ? document.exitPictureInPicture() : (vid.requestPictureInPicture ? vid.requestPictureInPicture().catch(() => toast('Imagem sobre imagem indisponível agora.')) : toast('Seu navegador não suporta imagem sobre imagem.')),
  mute: () => { vid.muted = !vid.muted; $('#sound').hidden = true; syncVol(); },
  pause: () => {
    if (!stream) return;
    paused = !paused; stream.getTracks().forEach(t => t.enabled = !paused);
    bcast({t: 'pause', v: paused}); icon('[data-act=pause]', paused ? 'play' : 'pause');
    toast(paused ? 'Imagem pausada para os espectadores' : 'Transmissão retomada');
  }
};
$$('[data-act]').forEach(b => b.onclick = () => act[b.dataset.act]());
vid.ondblclick = act.fs;
let it; const wake = () => { stage.classList.add('act'); clearTimeout(it); it = setTimeout(() => stage.classList.remove('act'), 2800); };
['mousemove', 'pointerdown'].forEach(e => stage.addEventListener(e, wake));
document.addEventListener('keydown', e => {
  if (e.target.closest('input,select,textarea') || e.ctrlKey || e.metaKey || e.altKey) return;
  const k = e.key.toLowerCase(), m = {f: 'fs', t: 'theater', c: 'chat', s: 'stats', m: target ? 'mute' : '', p: target ? '' : 'pause'}[k];
  if (m) { e.preventDefault(); act[m](); wake(); }
});
$('#sound').onclick = () => { vid.muted = false; vid.play(); $('#sound').hidden = true; syncVol(); };
$('#vol').oninput = e => { vid.volume = e.target.value; vid.muted = false; syncVol(); };

/* ---------- Chat ---------- */
function addMsg(m) {
  const box = $('#msgs'), d = document.createElement('div');
  if (m.t === 'sys') { d.className = 'sys'; d.textContent = m.text; }
  else {
    d.className = 'msg';
    d.innerHTML = '<div class="av"></div><div><div class="mh"><b></b><i class="tag" hidden>Anfitrião</i><time></time></div><p></p></div>';
    avatar(d.querySelector('.av'), m.name);
    const b = d.querySelector('b'); b.textContent = m.name; b.style.color = 'hsl(' + hue(m.name) + ',70%,' + (S.theme === 'light' ? '38%' : '72%') + ')';
    d.querySelector('.tag').hidden = !m.host;
    d.querySelector('time').textContent = new Date(m.ts).toLocaleTimeString('pt-BR', {hour: '2-digit', minute: '2-digit'});
    d.querySelector('p').textContent = m.text;
  }
  box.append(d);
  while (box.children.length > 200) box.firstChild.remove();
  box.scrollTop = box.scrollHeight;
}
let lastList = [];
function renderMembers(list) {
  lastList = list;
  list.forEach(u => { u.av = okAv(u.av); if (u.av) avatars[u.name] = u.av; else delete avatars[u.name]; });
  const el = $('#members'), av = $('#avs'), on = badge.classList.contains('on'); el.textContent = ''; av.textContent = '';
  list.forEach(u => {
    const r = document.createElement('div'); r.className = 'mem';
    r.innerHTML = '<div class="av on"></div><div class="mi"><b></b><small></small></div>';
    avatar(r.querySelector('.av'), u.name); r.querySelector('b').textContent = u.name;
    r.querySelector('small').textContent = u.host ? (on ? 'Transmitindo agora' : 'Anfitrião') : 'Assistindo';
    el.append(r);
    const a = document.createElement('div'); a.className = 'av on' + (u.host && on ? ' talk' : ''); avatar(a, u.name); a.title = u.name; av.append(a);
    if (u.host) { const ri = $('#roomIcon'); if (u.av) pic(ri, u.av); else { ri.style.background = ''; ri.textContent = (u.name[0] || '?').toUpperCase(); } $('#roomName').textContent = $('#roomT').textContent = document.title = 'Sala de ' + u.name; }
  });
  $('#memTitle').textContent = 'Membros — ' + list.length;
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
$('#f').onsubmit = e => {
  e.preventDefault();
  const text = $('#mi').value.trim(); if (!text) return;
  $('#mi').value = '';
  if (!target) post({name: me, text, ts: Date.now(), host: true});
  else if (hostConn && hostConn.open) hostConn.send({t: 'msg', text});
  else addMsg({t: 'sys', text: 'Sem conexão com o anfitrião. Sua mensagem não foi enviada.'});
};
function setStatus(text, on, sub) {
  $('#ph').hidden = !!on; $('#phText').textContent = text || ''; $('#phSub').textContent = sub || '';
  badge.textContent = on ? 'AO VIVO' : 'OFFLINE'; badge.classList.toggle('on', !!on);
  $('#vc').hidden = !on; $('#rw').classList.toggle('live', !!on); stage.classList.toggle('live', !!on);
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
  peer.on('open', () => { $('#link').value = location.href.split(/[?#]/)[0] + '?v=' + id; });
  peer.on('disconnected', () => peer.reconnect());
  peer.on('error', e => {
    if (e.type === 'unavailable-id') { try { localStorage.removeItem('tl-id'); } catch (_) {} location.reload(); }
    else $('#hint').textContent = 'Erro de conexão (' + e.type + '). Recarregue a página.';
  });
  peer.on('connection', conn => {
    conn.on('open', () => {
      if (!viewers.has(conn.peer) && viewers.size >= S.max) { conn.send({t: 'full', max: S.max}); setTimeout(() => conn.close(), 500); return; }
      viewers.set(conn.peer, {conn, name: ''});
      if (stream) callViewer(conn.peer);
      users();
    });
    conn.on('data', d => {
      const v = viewers.get(conn.peer); if (!v || !d) return;
      if (d.t === 'hello') { v.name = clean(d.name) || 'Convidado'; v.av = okAv(d.av); sys(v.name + ' entrou.'); users(); if (paused) conn.send({t: 'pause', v: true}); }
      else if (d.t === 'profile') { v.av = okAv(d.av); users(); }
      else if (d.t === 'msg') { const text = String(d.text || '').trim().slice(0, 500); if (text) post({name: v.name, text, ts: Date.now()}); }
    });
    conn.on('close', () => {
      const v = viewers.get(conn.peer);
      if (v && v.conn === conn) { if (v.call) v.call.close(); viewers.delete(conn.peer); if (v.name) sys(v.name + ' saiu.'); users(); }
    });
  });
  renderMembers([{name: me, host: true}]); users();
  setStatus('Pronto para transmitir', false, 'Ajuste a qualidade em Configurações, inicie e envie o link para quem vai assistir.');
}
async function start() {
  const [w, h] = RES[S.res];
  try {
    stream = await navigator.mediaDevices.getDisplayMedia({
      video: {width: {ideal: w}, height: {ideal: h}, frameRate: {ideal: S.fps}},
      audio: {echoCancellation: false, noiseSuppression: false, autoGainControl: false, channelCount: 2, sampleRate: 48000},
      selfBrowserSurface: 'exclude', surfaceSwitching: 'include', systemAudio: 'include'
    });
  } catch (e) { toast('Compartilhamento cancelado ou bloqueado pelo navegador.'); return; }
  const vt = stream.getVideoTracks()[0];
  vt.contentHint = S.prio === 'detail' ? 'detail' : 'motion'; vt.onended = stop;
  vid.srcObject = stream; vid.muted = true; vid.play();
  $('#hint').textContent = stream.getAudioTracks().length ? 'Áudio incluído na transmissão.' : 'Sem áudio: marque “Compartilhar áudio do sistema” (tela inteira) ou “áudio da guia” (aba).';
  setStatus('', true); setGo(true);
  viewers.forEach((_, id) => callViewer(id));
}
function stop() {
  if (stream) stream.getTracks().forEach(t => t.stop());
  stream = null; vid.srcObject = null; paused = false; icon('[data-act=pause]', 'pause');
  viewers.forEach(v => v.call && v.call.close());
  $('#res').textContent = ''; $('#stats').textContent = ''; setGo(false);
  setStatus('Transmissão encerrada', false, 'Clique em iniciar para transmitir de novo.');
}
function setGo(on) { ['#go', '#goBig'].forEach(s => { $(s).textContent = on ? 'Parar transmissão' : 'Iniciar transmissão'; $(s).classList.toggle('stop', on); }); }
function callViewer(id) {
  const v = viewers.get(id); if (!v || !stream) return;
  const c = peer.call(id, stream, {metadata: {br: S.br}, sdpTransform: s => boost(pref(s.replace(/useinbandfec=1/g, 'useinbandfec=1;stereo=1;sprop-stereo=1;maxaveragebitrate=' + S.abr * 1000), S.codec), S.br)});
  v.call = c;
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
$('#copy').onclick = async () => {
  const el = $('#link');
  try { await navigator.clipboard.writeText(el.value); } catch (e) { el.select(); document.execCommand('copy'); }
  toast('Link copiado');
};

$('#newRoom').onclick = () => { if (confirm('Criar uma nova sala? O link atual deixa de funcionar.')) { try { localStorage.removeItem('tl-id'); } catch (e) {} location.reload(); } };

/* ---------- Espectador ---------- */
function initViewer() {
  setStatus('Conectando…', false);
  peer = new Peer({config: ICE});
  peer.on('open', connect);
  peer.on('disconnected', () => peer.reconnect());
  peer.on('call', c => {
    call = c; c.answer(undefined, {sdpTransform: s => boost(s, (c.metadata && c.metadata.br) || 12)});
    c.on('stream', s => {
      vid.srcObject = s; vid.muted = true; vid.play().catch(() => {});
      setStatus('', true); $('#sound').hidden = false; syncVol();
    });
    c.on('close', () => {
      vid.srcObject = null; $('#sound').hidden = true; $('#res').textContent = '';
      setStatus('A transmissão terminou', false, 'A imagem volta sozinha quando ela recomeçar.');
    });
  });
  peer.on('error', e => {
    if (e.type === 'peer-unavailable') { setStatus('Aguardando o anfitrião', false, 'A página dele ainda não está aberta. Tentando de novo…'); setTimeout(connect, 3000); }
  });
}
function connect() {
  if (full) return;
  const c = peer.connect(target, {reliable: true}); hostConn = c;
  c.on('open', () => { c.send({t: 'hello', name: me, av: myAv}); if (!vid.srcObject) setStatus('Conectado', false, 'Aguardando a transmissão começar.'); });
  c.on('data', d => {
    if (!d) return;
    if (d.t === 'full') { full = true; setStatus('Sala cheia', false, 'Já há ' + d.max + ' pessoas assistindo.'); }
    else if (d.t === 'msg' || d.t === 'sys') addMsg(d);
    else if (d.t === 'users') { renderMembers(d.list); $('#count').textContent = (d.list.length - 1) + ' assistindo'; }
    else if (d.t === 'pause') toast(d.v ? 'O anfitrião pausou a imagem' : 'Transmissão retomada');
  });
  c.on('close', () => { if (!full) { setStatus('Conexão perdida', false, 'Reconectando…'); setTimeout(connect, 2000); } });
}

/* ---------- Estatísticas ---------- */
setInterval(async () => {
  const c = target ? call : [...viewers.values()].find(v => v.call);
  const cc = target ? c : c && c.call, pc = cc && cc.peerConnection;
  if (!pc || !vid.srcObject) return;
  if (last.c !== cc) last = {c: cc};
  const rep = await pc.getStats(), cod = {}; let st = null, rtt = null, rel = false;
  rep.forEach(x => { if (x.type === 'codec') cod[x.id] = x.mimeType.replace(/^.*\//, ''); });
  rep.forEach(x => {
    if (x.kind === 'video' && (x.type === 'inbound-rtp' || x.type === 'outbound-rtp')) {
      const b = x.bytesReceived != null ? x.bytesReceived : x.bytesSent;
      const mbps = last.t ? (b - last.b) * 8 / ((x.timestamp - last.t) / 1000) / 1e6 : 0;
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
  if (rel && !last.w) { last.w = 1; toast('Esta conexão passa por um servidor retransmissor e fica limitada. Veja as estatísticas (S).'); }
  $('#res').textContent = $('#vcS').textContent = st.w + '×' + st.h + ' · ' + st.fps + ' fps · ' + st.mbps.toFixed(1) + ' Mbps';
  const L = {none: 'nenhuma', bandwidth: 'upload insuficiente', cpu: 'CPU no limite', other: 'outra'};
  $('#stats').textContent = 'Resolução  ' + st.w + '×' + st.h + '\nQuadros  ' + st.fps + ' fps\nTaxa  ' + st.mbps.toFixed(1) + ' Mbps\nCodec  ' + st.codec +
    '\nLatência  ' + (rtt != null ? rtt + ' ms' : '-') + '\nConexão  ' + (rel ? 'retransmitida (lenta)' : 'direta') + (st.loss != null ? '\nPacotes perdidos  ' + st.loss : '') + (st.lim ? '\nLimitação  ' + (L[st.lim] || st.lim) : '');
}, 1000);

/* ---------- Início ---------- */
try { $('#ni').value = localStorage.getItem('tl-name') || ''; } catch (e) {}
sync(); showPane(target ? 'p-ap' : 'p-tx'); paintMe();
$$('.pick').forEach(b => b.onclick = () => $('#avFile').click());
$$('.avrm').forEach(b => b.onclick = () => setAv(''));
$('#avFile').onchange = async e => { const f = e.target.files[0]; e.target.value = ''; if (!f) return; try { setAv(await loadAvatar(f)); } catch (m) { toast(String(m)); } };
$('#ni').addEventListener('input', paintMe);
$('#nf').onsubmit = e => {
  e.preventDefault();
  me = clean($('#ni').value); if (!me) return;
  try { localStorage.setItem('tl-name', me); } catch (_) {}
  paintMe(); $('#meName').textContent = me; $('#meRole').textContent = target ? 'Espectador' : 'Anfitrião';
  $('#modal').classList.add('out'); setTimeout(() => $('#modal').remove(), 250);
  addMsg({t: 'sys', text: 'Bem-vindo ao chat, ' + me + '.'});
  if (!target && !(navigator.mediaDevices && navigator.mediaDevices.getDisplayMedia)) $('#hint').textContent = 'Este navegador não permite compartilhar a tela. Use Chrome ou Edge no computador.';
  target ? initViewer() : initHost();
};
