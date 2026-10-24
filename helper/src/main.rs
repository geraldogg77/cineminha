//! Cineminha Áudio
//! Fica na bandeja do Windows, lista os apps que estão tocando som e captura só os que a
//! pessoa marcar no Cineminha. O som mixado vai para a página por um WebSocket local
//! (127.0.0.1), então nada sai do computador por aqui: quem envia para a sala é o navegador.
#![windows_subsystem = "windows"]

use std::collections::{HashMap, HashSet, VecDeque};
use std::net::{TcpListener, TcpStream};
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::mpsc::{channel, Receiver, Sender};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::{Duration, Instant};

use base64::Engine;
use serde::Deserialize;
use serde_json::json;
use tungstenite::handshake::server::{ErrorResponse, Request, Response};
use tungstenite::Message;
use windows::core::{w, Interface, PCWSTR, PWSTR};
use windows::Win32::Foundation::*;
use windows::Win32::Graphics::Gdi::*;
use windows::Win32::Media::Audio::*;
use windows::Win32::Storage::FileSystem::*;
use windows::Win32::System::Com::*;
use windows::Win32::System::Diagnostics::ToolHelp::*;
use windows::Win32::System::LibraryLoader::GetModuleHandleW;
use windows::Win32::System::Threading::*;
use windows::Win32::UI::Shell::*;
use windows::Win32::UI::WindowsAndMessaging::*;

const PORT: u16 = 47833;
const RATE: usize = 48000;
const CH: usize = 2;
const TICK: usize = RATE / 100; // 10 ms
const SITE: &str = "https://geraldogg77.github.io/cineminha/";
const ALLOWED: &[&str] = &["https://geraldogg77.github.io"];

/* ---------------- Estado compartilhado ---------------- */

#[derive(Clone)]
struct App {
    key: String,      // caminho do executável em minúsculas
    name: String,     // nome amigável (descrição do arquivo)
    icon: String,     // data:image/png;base64,...
    roots: Vec<u32>,  // processos donos das sessões de áudio (alvos da captura)
    active: bool,     // tocando agora
    includes: Vec<String>, // outros apps que entram junto (o Windows captura o app e tudo que ele abriu)
}

struct Pref { on: bool, vol: f32 }

struct Client { tx: Sender<Message>, streaming: Arc<AtomicBool> }

struct State {
    apps: Vec<App>,
    prefs: HashMap<String, Pref>,
    clients: Vec<Client>,
    caps: HashMap<u32, Cap>,
    version: usize,
    error: Option<String>,
    tree: HashMap<u32, HashSet<u32>>,
}

struct Cap { stop: Arc<AtomicBool>, buf: Arc<Mutex<VecDeque<f32>>>, primed: bool }

type Shared = Arc<Mutex<State>>;
static CONNECTED: AtomicUsize = AtomicUsize::new(0);

fn pref_of<'a>(prefs: &'a HashMap<String, Pref>, key: &str) -> (bool, f32) {
    prefs.get(key).map(|p| (p.on, p.vol)).unwrap_or((true, 1.0))
}

/* ---------------- Utilidades Win32 ---------------- */

fn wide(s: &str) -> Vec<u16> { s.encode_utf16().chain(std::iter::once(0)).collect() }
fn from_wide(buf: &[u16]) -> String {
    let n = buf.iter().position(|&c| c == 0).unwrap_or(buf.len());
    String::from_utf16_lossy(&buf[..n])
}
fn message_box(text: &str) {
    unsafe {
        let t = wide(text);
        MessageBoxW(None, PCWSTR(t.as_ptr()), w!("Cineminha Áudio"), MB_OK | MB_ICONINFORMATION);
    }
}

fn exe_path(pid: u32) -> Option<String> {
    unsafe {
        let h = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, pid).ok()?;
        let mut buf = [0u16; 1024];
        let mut len = buf.len() as u32;
        let r = QueryFullProcessImageNameW(h, PROCESS_NAME_WIN32, PWSTR(buf.as_mut_ptr()), &mut len);
        let _ = CloseHandle(h);
        r.ok()?;
        Some(String::from_utf16_lossy(&buf[..len as usize]))
    }
}

/// pid → (pai, nome do executável em minúsculas)
fn process_table() -> HashMap<u32, (u32, String)> {
    let mut map = HashMap::new();
    unsafe {
        let Ok(snap) = CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0) else { return map };
        let mut e = PROCESSENTRY32W { dwSize: std::mem::size_of::<PROCESSENTRY32W>() as u32, ..Default::default() };
        if Process32FirstW(snap, &mut e).is_ok() {
            loop {
                map.insert(e.th32ProcessID, (e.th32ParentProcessID, from_wide(&e.szExeFile).to_lowercase()));
                if Process32NextW(snap, &mut e).is_err() { break; }
            }
        }
        let _ = CloseHandle(snap);
    }
    map
}


fn file_description(path: &str) -> Option<String> {
    unsafe {
        let p = wide(path);
        let size = GetFileVersionInfoSizeW(PCWSTR(p.as_ptr()), None);
        if size == 0 { return None; }
        let mut data = vec![0u8; size as usize];
        GetFileVersionInfoW(PCWSTR(p.as_ptr()), Some(0), size, data.as_mut_ptr() as *mut _).ok()?;
        let mut ptr: *mut std::ffi::c_void = std::ptr::null_mut();
        let mut len = 0u32;
        let tr = wide("\\VarFileInfo\\Translation");
        if !VerQueryValueW(data.as_ptr() as *const _, PCWSTR(tr.as_ptr()), &mut ptr, &mut len).as_bool() || len < 4 { return None; }
        let lang = *(ptr as *const u16);
        let cp = *((ptr as *const u16).add(1));
        let q = wide(&format!("\\StringFileInfo\\{:04x}{:04x}\\FileDescription", lang, cp));
        if !VerQueryValueW(data.as_ptr() as *const _, PCWSTR(q.as_ptr()), &mut ptr, &mut len).as_bool() || len == 0 { return None; }
        let s = from_wide(std::slice::from_raw_parts(ptr as *const u16, len as usize));
        let s = s.trim().to_string();
        if s.is_empty() { None } else { Some(s) }
    }
}

fn icon_png(path: &str) -> String {
    unsafe {
        let p = wide(path);
        let mut info = SHFILEINFOW::default();
        let r = SHGetFileInfoW(PCWSTR(p.as_ptr()), FILE_FLAGS_AND_ATTRIBUTES(0), Some(&mut info), std::mem::size_of::<SHFILEINFOW>() as u32, SHGFI_ICON | SHGFI_LARGEICON);
        if r == 0 || info.hIcon.is_invalid() { return String::new(); }
        let hicon = info.hIcon;
        let mut ii = ICONINFO::default();
        let mut out = String::new();
        if GetIconInfo(hicon, &mut ii).is_ok() {
            let size = 32i32;
            let mut bi = BITMAPINFO::default();
            bi.bmiHeader.biSize = std::mem::size_of::<BITMAPINFOHEADER>() as u32;
            bi.bmiHeader.biWidth = size;
            bi.bmiHeader.biHeight = -size;
            bi.bmiHeader.biPlanes = 1;
            bi.bmiHeader.biBitCount = 32;
            bi.bmiHeader.biCompression = BI_RGB.0;
            let mut px = vec![0u8; (size * size * 4) as usize];
            let dc = GetDC(None);
            let lines = GetDIBits(dc, ii.hbmColor, 0, size as u32, Some(px.as_mut_ptr() as *mut _), &mut bi, DIB_RGB_COLORS);
            ReleaseDC(None, dc);
            if lines > 0 {
                let has_alpha = px.chunks(4).any(|c| c[3] != 0);
                for c in px.chunks_mut(4) { c.swap(0, 2); if !has_alpha { c[3] = 255; } }
                let mut png_bytes = Vec::new();
                {
                    let mut enc = png::Encoder::new(&mut png_bytes, size as u32, size as u32);
                    enc.set_color(png::ColorType::Rgba);
                    enc.set_depth(png::BitDepth::Eight);
                    if let Ok(mut wr) = enc.write_header() { let _ = wr.write_image_data(&px); }
                }
                out = format!("data:image/png;base64,{}", base64::engine::general_purpose::STANDARD.encode(&png_bytes));
            }
            if !ii.hbmColor.is_invalid() { let _ = DeleteObject(ii.hbmColor.into()); }
            if !ii.hbmMask.is_invalid() { let _ = DeleteObject(ii.hbmMask.into()); }
        }
        let _ = DestroyIcon(hicon);
        out
    }
}

/* ---------------- Lista de apps com som ---------------- */

/// Varre as sessões de áudio de todas as saídas: (pid, tocando agora)
fn audio_sessions() -> Vec<(u32, bool)> {
    let mut out = Vec::new();
    unsafe {
        let Ok(en) = CoCreateInstance::<_, IMMDeviceEnumerator>(&MMDeviceEnumerator, None, CLSCTX_ALL) else { return out };
        let Ok(devs) = en.EnumAudioEndpoints(eRender, DEVICE_STATE_ACTIVE) else { return out };
        let n = devs.GetCount().unwrap_or(0);
        for i in 0..n {
            let Ok(dev) = devs.Item(i) else { continue };
            let Ok(mgr) = dev.Activate::<IAudioSessionManager2>(CLSCTX_ALL, None) else { continue };
            let Ok(list) = mgr.GetSessionEnumerator() else { continue };
            let count = list.GetCount().unwrap_or(0);
            for j in 0..count {
                let Ok(ctl) = list.GetSession(j) else { continue };
                let Ok(ctl2) = ctl.cast::<IAudioSessionControl2>() else { continue };
                if ctl2.IsSystemSoundsSession() == S_OK { continue; }
                let state = ctl.GetState().unwrap_or(AudioSessionStateExpired);
                if state == AudioSessionStateExpired { continue; }
                let Ok(pid) = ctl2.GetProcessId() else { continue };
                if pid == 0 { continue; }
                out.push((pid, state == AudioSessionStateActive));
            }
        }
    }
    out
}

/// Programas do próprio Windows que abrem quase todos os outros: capturar um deles
/// levaria o som do computador inteiro, então ficam fora da lista.
const SHELL: &[&str] = &["explorer.exe", "sihost.exe", "svchost.exe", "audiodg.exe", "runtimebroker.exe",
    "shellexperiencehost.exe", "startmenuexperiencehost.exe", "applicationframehost.exe", "textinputhost.exe",
    "dwm.exe", "winlogon.exe", "services.exe", "taskhostw.exe", "searchhost.exe", "systemsettings.exe"];

/// todos os descendentes de um processo
fn descendants(pid: u32, table: &HashMap<u32, (u32, String)>) -> HashSet<u32> {
    let mut out = HashSet::new();
    let mut stack = vec![pid];
    while let Some(p) = stack.pop() {
        for (c, (parent, _)) in table.iter() {
            if *parent == p && *c != p && out.insert(*c) { stack.push(*c); }
        }
    }
    out
}

fn scan_apps(icons: &mut HashMap<String, (String, String)>) -> (Vec<App>, HashMap<u32, HashSet<u32>>) {
    let me = std::process::id();
    let table = process_table();
    let my_exe = exe_path(me).unwrap_or_default().to_lowercase();
    let mut groups: HashMap<String, App> = HashMap::new();
    for (pid, active) in audio_sessions() {
        let exe_name = table.get(&pid).map(|t| t.1.clone()).unwrap_or_default();
        if SHELL.contains(&exe_name.as_str()) { continue; }
        let Some(path) = exe_path(pid) else { continue };
        let key = path.to_lowercase();
        if key == my_exe { continue; }
        let (name, icon) = icons.entry(key.clone()).or_insert_with(|| {
            let stem = std::path::Path::new(&path).file_stem().map(|s| s.to_string_lossy().to_string()).unwrap_or_default();
            (file_description(&path).unwrap_or(stem), icon_png(&path))
        }).clone();
        let g = groups.entry(key.clone()).or_insert(App { key, name, icon, roots: vec![], active: false, includes: vec![] });
        if !g.roots.contains(&pid) { g.roots.push(pid); }
        g.active |= active;
    }
    let mut apps: Vec<App> = groups.into_values().collect();
    // quem leva quem junto: o Windows captura o processo e todos os filhos dele
    let mut tree: HashMap<u32, HashSet<u32>> = HashMap::new();
    for a in &apps { for r in &a.roots { tree.insert(*r, descendants(*r, &table)); } }
    let snapshot: Vec<(String, Vec<u32>)> = apps.iter().map(|a| (a.name.clone(), a.roots.clone())).collect();
    for a in apps.iter_mut() {
        let mine: HashSet<u32> = a.roots.iter().flat_map(|r| tree.get(r).cloned().unwrap_or_default()).collect();
        a.includes = snapshot.iter().filter(|(n, roots)| *n != a.name && roots.iter().any(|r| mine.contains(r))).map(|(n, _)| n.clone()).collect();
    }
    apps.sort_by(|a, b| a.name.to_lowercase().cmp(&b.name.to_lowercase()));
    (apps, tree)
}

fn apps_json(st: &State) -> String {
    let list: Vec<_> = st.apps.iter().map(|a| {
        let (on, vol) = pref_of(&st.prefs, &a.key);
        json!({"key": a.key, "name": a.name, "icon": a.icon, "active": a.active, "on": on, "vol": (vol * 100.0).round(), "includes": a.includes})
    }).collect();
    json!({"t": "apps", "list": list, "error": st.error}).to_string()
}

fn broadcast_text(st: &mut State, text: String) {
    st.clients.retain(|c| c.tx.send(Message::Text(text.clone().into())).is_ok());
}

/* ---------------- Captura por app ---------------- */

fn start_capture(pid: u32, shared: Shared) -> Cap {
    let stop = Arc::new(AtomicBool::new(false));
    let buf = Arc::new(Mutex::new(VecDeque::with_capacity(RATE * CH / 5)));
    let (s2, b2) = (stop.clone(), buf.clone());
    thread::spawn(move || {
        if let Err(e) = capture_loop(pid, &s2, &b2) {
            let msg = format!("{e}");
            let mut st = shared.lock().unwrap();
            if st.error.is_none() {
                st.error = Some(if msg.contains("0x80070490") || msg.contains("Activate") {
                    "Este Windows não permite capturar o som de um app separado. Atualize para o Windows 11 ou para a versão mais recente do Windows 10.".into()
                } else { format!("Não foi possível capturar um app: {msg}") });
                st.version += 1;
            }
        }
    });
    Cap { stop, buf, primed: false }
}

fn capture_loop(pid: u32, stop: &AtomicBool, buf: &Mutex<VecDeque<f32>>) -> Result<(), Box<dyn std::error::Error>> {
    let _ = wasapi::initialize_mta();
    let fmt = wasapi::WaveFormat::new(32, 32, &wasapi::SampleType::Float, RATE, CH, None);
    let mut client = wasapi::AudioClient::new_application_loopback_client(pid, true)?;
    client.initialize_client(&fmt, &wasapi::Direction::Capture, &wasapi::StreamMode::EventsShared { autoconvert: true, buffer_duration_hns: 0 })?;
    let ev = client.set_get_eventhandle()?;
    let cap = client.get_audiocaptureclient()?;
    let mut raw: VecDeque<u8> = VecDeque::new();
    client.start_stream()?;
    while !stop.load(Ordering::Relaxed) {
        let _ = ev.wait_for_event(100); // app em silêncio não gera eventos: só segue em frente
        while let Ok(Some(n)) = cap.get_next_packet_size() {
            if n == 0 { break; }
            cap.read_from_device_to_deque(&mut raw)?;
        }
        if raw.len() >= 4 {
            let mut b = buf.lock().unwrap();
            while raw.len() >= 4 {
                let s = [raw.pop_front().unwrap(), raw.pop_front().unwrap(), raw.pop_front().unwrap(), raw.pop_front().unwrap()];
                b.push_back(f32::from_le_bytes(s));
            }
            let max = RATE * CH / 4; // no máximo 250 ms guardados
            while b.len() > max { b.pop_front(); }
        }
    }
    let _ = client.stop_stream();
    Ok(())
}

/// Liga e desliga capturas conforme o que o site pediu
fn manage_captures(shared: &Shared) {
    let mut st = shared.lock().unwrap();
    let streaming = st.clients.iter().any(|c| c.streaming.load(Ordering::Relaxed));
    let mut want: HashSet<u32> = HashSet::new();
    if streaming {
        for a in &st.apps { if pref_of(&st.prefs, &a.key).0 { want.extend(a.roots.iter().copied()); } }
        // um alvo que já está dentro da árvore de outro alvo sairia duplicado
        let covered: HashSet<u32> = want.iter().filter(|p| want.iter().any(|o| o != *p && st.tree.get(o).map_or(false, |d| d.contains(p)))).copied().collect();
        want.retain(|p| !covered.contains(p));
    }
    let running: Vec<u32> = st.caps.keys().copied().collect();
    for pid in running { if !want.contains(&pid) { if let Some(c) = st.caps.remove(&pid) { c.stop.store(true, Ordering::Relaxed); } } }
    for pid in want { if !st.caps.contains_key(&pid) { let c = start_capture(pid, shared.clone()); st.caps.insert(pid, c); } }
}

/* ---------------- Mixer: junta os apps e manda para o site a cada 10 ms ---------------- */

fn mixer(shared: Shared) {
    let period = Duration::from_millis(10);
    let mut next = Instant::now() + period;
    let mut mix = vec![0f32; TICK * CH];
    loop {
        let now = Instant::now();
        if next > now { thread::sleep(next - now); } else if now - next > Duration::from_millis(60) { next = now; }
        next += period;
        let mut st = shared.lock().unwrap();
        if !st.clients.iter().any(|c| c.streaming.load(Ordering::Relaxed)) { continue; }
        mix.iter_mut().for_each(|s| *s = 0.0);
        let gains: HashMap<u32, f32> = st.apps.iter().flat_map(|a| {
            let (on, vol) = pref_of(&st.prefs, &a.key);
            a.roots.iter().map(move |r| (*r, if on { vol } else { 0.0 }))
        }).collect();
        for (pid, cap) in st.caps.iter_mut() {
            let g = *gains.get(pid).unwrap_or(&0.0);
            let mut b = cap.buf.lock().unwrap();
            if !cap.primed { if b.len() >= TICK * CH * 3 { cap.primed = true; } else { continue; } }
            let n = b.len().min(TICK * CH);
            for (i, s) in b.drain(..n).enumerate() { mix[i] += s * g; }
            if n < TICK * CH { cap.primed = false; }
            if b.len() > TICK * CH * 10 { let extra = b.len() - TICK * CH * 3; b.drain(..extra); }
        }
        let mut bytes = Vec::with_capacity(mix.len() * 4);
        for s in &mix { bytes.extend_from_slice(&s.clamp(-1.0, 1.0).to_le_bytes()); }
        st.clients.retain(|c| !c.streaming.load(Ordering::Relaxed) || c.tx.send(Message::Binary(bytes.clone())).is_ok());
    }
}

/* ---------------- WebSocket local ---------------- */

#[derive(Deserialize)]
struct In { t: String, key: Option<String>, on: Option<bool>, vol: Option<f32>, apps: Option<HashMap<String, PrefIn>> }
#[derive(Deserialize)]
struct PrefIn { on: bool, vol: Option<f32> }

fn origin_ok(o: &str) -> bool {
    ALLOWED.contains(&o) || o.starts_with("http://localhost:") || o.starts_with("http://127.0.0.1:") || o == "http://localhost"
}

fn serve(shared: Shared, listener: TcpListener) {
    for stream in listener.incoming().flatten() {
        let sh = shared.clone();
        thread::spawn(move || { let _ = client_loop(sh, stream); });
    }
}

fn client_loop(shared: Shared, stream: TcpStream) -> Result<(), Box<dyn std::error::Error>> {
    let check = |req: &Request, resp: Response| -> Result<Response, ErrorResponse> {
        let o = req.headers().get("origin").and_then(|v| v.to_str().ok()).unwrap_or("");
        if origin_ok(o) { Ok(resp) } else {
            let mut r = ErrorResponse::new(Some("origem não autorizada".into()));
            *r.status_mut() = tungstenite::http::StatusCode::FORBIDDEN; Err(r)
        }
    };
    let mut ws = tungstenite::accept_hdr(stream.try_clone()?, check)?;
    stream.set_read_timeout(Some(Duration::from_millis(5)))?;
    stream.set_nodelay(true)?;
    let (tx, rx): (Sender<Message>, Receiver<Message>) = channel();
    let streaming = Arc::new(AtomicBool::new(false));
    {
        let mut st = shared.lock().unwrap();
        st.clients.push(Client { tx: tx.clone(), streaming: streaming.clone() });
        let hello = json!({"t": "hello", "v": 1, "rate": RATE, "ch": CH, "name": "Cineminha Áudio"}).to_string();
        let _ = tx.send(Message::Text(hello.into()));
        let _ = tx.send(Message::Text(apps_json(&st).into()));
    }
    CONNECTED.fetch_add(1, Ordering::Relaxed);
    let result = (|| -> Result<(), Box<dyn std::error::Error>> {
        loop {
            match ws.read() {
                Ok(Message::Text(t)) => {
                    if let Ok(m) = serde_json::from_str::<In>(&t) {
                        let mut st = shared.lock().unwrap();
                        match m.t.as_str() {
                            "start" => streaming.store(true, Ordering::Relaxed),
                            "stop" => streaming.store(false, Ordering::Relaxed),
                            "set" => if let Some(k) = m.key {
                                let (on0, vol0) = pref_of(&st.prefs, &k);
                                st.prefs.insert(k, Pref { on: m.on.unwrap_or(on0), vol: m.vol.map(|v| (v / 100.0).clamp(0.0, 1.5)).unwrap_or(vol0) });
                                st.version += 1;
                            },
                            "prefs" => if let Some(a) = m.apps {
                                for (k, p) in a { st.prefs.insert(k, Pref { on: p.on, vol: p.vol.map(|v| (v / 100.0).clamp(0.0, 1.5)).unwrap_or(1.0) }); }
                                st.version += 1;
                            },
                            _ => {}
                        }
                        drop(st);
                        manage_captures(&shared);
                    }
                }
                Ok(Message::Close(_)) => break,
                Ok(_) => {}
                Err(tungstenite::Error::Io(e)) if e.kind() == std::io::ErrorKind::WouldBlock || e.kind() == std::io::ErrorKind::TimedOut => {}
                Err(_) => break,
            }
            let mut sent = false;
            while let Ok(msg) = rx.try_recv() { ws.write(msg)?; sent = true; }
            if sent { ws.flush()?; }
        }
        Ok(())
    })();
    streaming.store(false, Ordering::Relaxed);
    CONNECTED.fetch_sub(1, Ordering::Relaxed);
    shared.lock().unwrap().clients.retain(|c| !Arc::ptr_eq(&c.streaming, &streaming));
    manage_captures(&shared);
    result
}

/* ---------------- Bandeja do Windows ---------------- */

const WM_TRAY: u32 = WM_APP + 1;
const ID_OPEN: usize = 1;
const ID_QUIT: usize = 2;

fn make_icon() -> HICON {
    unsafe {
        let s = 32i32;
        let mut px = vec![0u8; (s * s * 4) as usize];
        for y in 0..s { for x in 0..s {
            let (fx, fy) = (x as f32 + 0.5, y as f32 + 0.5);
            // quadrado arredondado azul
            let r = 8.0f32; let (cx, cy) = (fx.clamp(r, s as f32 - r), fy.clamp(r, s as f32 - r));
            let d = ((fx - cx).powi(2) + (fy - cy).powi(2)).sqrt();
            let a = (r + 0.5 - d).clamp(0.0, 1.0);
            let (mut cr, mut cg, mut cb) = (0x5Bu8, 0x7Cu8, 0xFAu8);
            // triângulo branco de play
            let inside = fx >= 12.0 && fx <= 23.0 && (fy - 16.0).abs() <= (23.0 - fx) * 0.62;
            if inside { cr = 255; cg = 255; cb = 255; }
            let i = ((y * s + x) * 4) as usize;
            let al = (a * 255.0) as u8;
            px[i] = (cb as f32 * a) as u8; px[i + 1] = (cg as f32 * a) as u8; px[i + 2] = (cr as f32 * a) as u8; px[i + 3] = al;
        } }
        let mut bi = BITMAPINFO::default();
        bi.bmiHeader.biSize = std::mem::size_of::<BITMAPINFOHEADER>() as u32;
        bi.bmiHeader.biWidth = s; bi.bmiHeader.biHeight = -s; bi.bmiHeader.biPlanes = 1; bi.bmiHeader.biBitCount = 32;
        let dc = GetDC(None);
        let mut bits: *mut std::ffi::c_void = std::ptr::null_mut();
        let color = CreateDIBSection(Some(dc), &bi, DIB_RGB_COLORS, &mut bits, None, 0).unwrap_or_default();
        ReleaseDC(None, dc);
        if !bits.is_null() { std::ptr::copy_nonoverlapping(px.as_ptr(), bits as *mut u8, px.len()); }
        let mask = CreateBitmap(s, s, 1, 1, None);
        let ii = ICONINFO { fIcon: true.into(), xHotspot: 0, yHotspot: 0, hbmMask: mask, hbmColor: color };
        CreateIconIndirect(&ii).unwrap_or_default()
    }
}

fn set_tip(nid: &mut NOTIFYICONDATAW, text: &str) {
    let t: Vec<u16> = text.encode_utf16().take(127).collect();
    nid.szTip = [0; 128];
    nid.szTip[..t.len()].copy_from_slice(&t);
}

static mut NID: Option<NOTIFYICONDATAW> = None;

unsafe extern "system" fn wndproc(hwnd: HWND, msg: u32, wp: WPARAM, lp: LPARAM) -> LRESULT {
    match msg {
        WM_TRAY => {
            let ev = (lp.0 & 0xffff) as u32;
            if ev == WM_RBUTTONUP || ev == WM_LBUTTONUP || ev == WM_CONTEXTMENU {
                let menu = CreatePopupMenu().unwrap_or_default();
                let n = CONNECTED.load(Ordering::Relaxed);
                let status = wide(if n > 0 { "Conectado ao Cineminha" } else { "Aguardando o Cineminha" });
                let _ = AppendMenuW(menu, MF_STRING | MF_GRAYED, 0, PCWSTR(status.as_ptr()));
                let _ = AppendMenuW(menu, MF_SEPARATOR, 0, PCWSTR::null());
                let _ = AppendMenuW(menu, MF_STRING, ID_OPEN, w!("Abrir o Cineminha"));
                let _ = AppendMenuW(menu, MF_STRING, ID_QUIT, w!("Sair"));
                let mut pt = POINT::default();
                let _ = GetCursorPos(&mut pt);
                let _ = SetForegroundWindow(hwnd);
                let cmd = TrackPopupMenu(menu, TPM_RETURNCMD | TPM_RIGHTBUTTON | TPM_BOTTOMALIGN, pt.x, pt.y, Some(0), hwnd, None);
                let _ = DestroyMenu(menu);
                match cmd.0 as usize {
                    ID_OPEN => { ShellExecuteW(None, w!("open"), PCWSTR(wide(SITE).as_ptr()), PCWSTR::null(), PCWSTR::null(), SW_SHOWNORMAL); }
                    ID_QUIT => { quit(); }
                    _ => {}
                }
            }
            LRESULT(0)
        }
        WM_TIMER => {
            #[allow(static_mut_refs)]
            if let Some(nid) = NID.as_mut() {
                let n = CONNECTED.load(Ordering::Relaxed);
                set_tip(nid, if n > 0 { "Cineminha Áudio: conectado" } else { "Cineminha Áudio: aguardando o site" });
                nid.uFlags = NIF_TIP;
                let _ = Shell_NotifyIconW(NIM_MODIFY, nid);
            }
            LRESULT(0)
        }
        _ => DefWindowProcW(hwnd, msg, wp, lp),
    }
}

fn quit() -> ! {
    unsafe {
        #[allow(static_mut_refs)]
        if let Some(nid) = NID.as_ref() { let _ = Shell_NotifyIconW(NIM_DELETE, nid); }
    }
    std::process::exit(0)
}

fn tray() {
    unsafe {
        let inst = GetModuleHandleW(None).unwrap_or_default();
        let class = w!("CineminhaAudioTray");
        let wc = WNDCLASSW { lpfnWndProc: Some(wndproc), hInstance: inst.into(), lpszClassName: class, ..Default::default() };
        RegisterClassW(&wc);
        let hwnd = CreateWindowExW(WINDOW_EX_STYLE(0), class, w!("Cineminha Áudio"), WS_OVERLAPPED, 0, 0, 0, 0, None, None, Some(inst.into()), None).unwrap_or_default();
        let mut nid = NOTIFYICONDATAW { cbSize: std::mem::size_of::<NOTIFYICONDATAW>() as u32, hWnd: hwnd, uID: 1, ..Default::default() };
        nid.uFlags = NIF_ICON | NIF_TIP | NIF_MESSAGE | NIF_INFO;
        nid.uCallbackMessage = WM_TRAY;
        nid.hIcon = make_icon();
        set_tip(&mut nid, "Cineminha Áudio: aguardando o site");
        let title: Vec<u16> = "Cineminha Áudio está ligado".encode_utf16().collect();
        let body: Vec<u16> = "Abra o Cineminha e escolha os apps no mixer de áudio. O ícone fica aqui na bandeja.".encode_utf16().collect();
        nid.szInfoTitle[..title.len()].copy_from_slice(&title);
        nid.szInfo[..body.len()].copy_from_slice(&body);
        nid.dwInfoFlags = NIIF_INFO;
        let _ = Shell_NotifyIconW(NIM_ADD, &nid);
        NID = Some(nid);
        SetTimer(Some(hwnd), 1, 2000, None);
        let mut msg = MSG::default();
        while GetMessageW(&mut msg, None, 0, 0).as_bool() {
            let _ = TranslateMessage(&msg);
            DispatchMessageW(&msg);
        }
    }
}

/* ---------------- Início ---------------- */

fn main() {
    unsafe {
        let _ = CreateMutexW(None, true, w!("CineminhaAudioUnico"));
        if GetLastError() == ERROR_ALREADY_EXISTS {
            message_box("O Cineminha Áudio já está ligado. Procure o ícone azul na bandeja do Windows, perto do relógio.");
            return;
        }
    }
    let listener = match TcpListener::bind(("127.0.0.1", PORT)) {
        Ok(l) => l,
        Err(_) => { message_box("Não foi possível iniciar: a porta 47833 está em uso por outro programa."); return; }
    };
    let shared: Shared = Arc::new(Mutex::new(State { apps: vec![], prefs: HashMap::new(), clients: vec![], caps: HashMap::new(), version: 0, error: None, tree: HashMap::new() }));

    { let sh = shared.clone(); thread::spawn(move || serve(sh, listener)); }
    { let sh = shared.clone(); thread::spawn(move || mixer(sh)); }
    {
        // varre os apps a cada 1,5 s e avisa o site quando a lista muda
        let sh = shared.clone();
        thread::spawn(move || {
            unsafe { let _ = CoInitializeEx(None, COINIT_MULTITHREADED); }
            let mut icons = HashMap::new();
            let mut last_sent = String::new();
            let mut last_version = usize::MAX;
            loop {
                let (apps, tree) = scan_apps(&mut icons);
                {
                    let mut st = sh.lock().unwrap();
                    st.apps = apps; st.tree = tree;
                    let text = apps_json(&st);
                    if text != last_sent || st.version != last_version {
                        last_sent = text.clone(); last_version = st.version;
                        broadcast_text(&mut st, text);
                    }
                }
                manage_captures(&sh);
                thread::sleep(Duration::from_millis(1500));
            }
        });
    }
    tray();
}
