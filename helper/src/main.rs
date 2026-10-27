//! Cineminha Áudio
//! Fica na bandeja do Windows, lista os apps que estão tocando som e captura só os que a
//! pessoa marcar no Cineminha. O som mixado vai para a página por um WebSocket local
//! (127.0.0.1), então nada sai do computador por aqui: quem envia para a sala é o navegador.
//!
//! Como a separação funciona (mesmo princípio do win-capture-audio do OBS):
//!  - captura por processo com a API de loopback de processo do Windows (inclui a árvore do processo);
//!  - a escolha de quem capturar fica em `cineminha_logic::plan`: nunca captura uma árvore que
//!    tenha um app desmarcado dentro, então desmarcar sempre tira o som daquele app;
//!  - cada pacote é posicionado pelo horário em que o Windows o capturou (QPC), com 40 ms de folga;
//!  - pacotes marcados como silêncio pelo Windows viram silêncio de verdade;
//!  - apps desmarcados que estão tocando são capturados só para comparação (nunca entram na mistura),
//!    para descobrir apps que repetem o som de outros (OBS com monitoramento, Radeon, apps de streaming).
#![windows_subsystem = "windows"]

use std::collections::{HashMap, HashSet, VecDeque};
use std::net::{TcpListener, TcpStream};
use std::sync::atomic::{AtomicBool, AtomicU64, AtomicUsize, Ordering};
use std::sync::mpsc::{channel, Receiver, Sender};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::{Duration, Instant};

use base64::Engine;
use cineminha_logic as logic;
use serde::Deserialize;
use serde_json::json;
use tungstenite::handshake::server::{ErrorResponse, Request, Response};
use tungstenite::Message;
use windows::core::{w, Interface, PCWSTR, PWSTR};
use windows::Win32::Foundation::*;
use windows::Win32::Graphics::Gdi::*;
use windows::Win32::Media::Audio::*;
use windows::Win32::NetworkManagement::IpHelper::*;
use windows::Win32::Networking::WinSock::AF_INET;
use windows::Win32::Storage::FileSystem::*;
use windows::Win32::System::Com::*;
use windows::Win32::System::Diagnostics::ToolHelp::*;
use windows::Win32::System::LibraryLoader::GetModuleHandleW;
use windows::Win32::System::Performance::{QueryPerformanceCounter, QueryPerformanceFrequency};
use windows::Win32::System::Threading::*;
use windows::Win32::UI::Shell::*;
use windows::Win32::UI::WindowsAndMessaging::*;

const PORT: u16 = 47833;
const RATE: usize = logic::RATE as usize;
const CH: usize = logic::CH;
const SITE: &str = "https://cineminha.online/";
const ALLOWED: &[&str] = &["https://cineminha.online", "https://www.cineminha.online", "https://cineminha.pages.dev", "https://geraldogg77.github.io"];
/// captura de um app que saiu da lista continua aberta (em silêncio) por este tempo; voltar é instantâneo
const GRACE: Duration = Duration::from_secs(15);

/* ---------------- Relógio e registro ---------------- */

/// horário do Windows em unidades de 100 ns, o mesmo relógio dos pacotes de áudio
fn qpc_100ns() -> u64 {
    unsafe {
        let (mut f, mut c) = (0i64, 0i64);
        let _ = QueryPerformanceFrequency(&mut f);
        let _ = QueryPerformanceCounter(&mut c);
        ((c as i128) * 10_000_000 / (f.max(1) as i128)) as u64
    }
}
static START: std::sync::OnceLock<Instant> = std::sync::OnceLock::new();
fn up_ms() -> u64 { START.get_or_init(Instant::now).elapsed().as_millis() as u64 }
static LOG: Mutex<Option<std::fs::File>> = Mutex::new(None);
fn log_path() -> std::path::PathBuf {
    let base = std::env::var("LOCALAPPDATA").unwrap_or_else(|_| ".".into());
    std::path::Path::new(&base).join("CineminhaAudio").join("registro.txt")
}
fn log_open() {
    let p = log_path();
    if let Some(d) = p.parent() { let _ = std::fs::create_dir_all(d); }
    *LOG.lock().unwrap() = std::fs::File::create(&p).ok();
}
fn log(msg: &str) {
    use std::io::Write;
    if let Some(f) = LOG.lock().unwrap().as_mut() {
        let t = up_ms();
        let _ = writeln!(f, "[{:>4}:{:02}.{:03}] {}", t / 60000, (t / 1000) % 60, t % 1000, msg);
        let _ = f.flush();
    }
}

/* ---------------- Estado ---------------- */

#[derive(Clone)]
struct App {
    key: String,
    name: String,
    icon: String,
    pids: Vec<u32>,
    active: bool,
}

struct Pref { on: bool, vol: f32 }

struct Client { tx: Sender<Message>, streaming: Arc<AtomicBool> }

struct Cap {
    stop: Arc<AtomicBool>,
    q: Arc<Mutex<VecDeque<(u64, Vec<f32>)>>>,
    alive: Arc<AtomicBool>,
    last: Arc<AtomicU64>,
    packets: Arc<AtomicU64>,
    silent: Arc<AtomicU64>,
    err: Arc<Mutex<Option<String>>>,
    key: String,
    unused_since: Option<Instant>,
}

struct State {
    apps: Vec<App>,
    sessions: Vec<(u32, String, bool)>,
    table: HashMap<u32, logic::Proc>,
    prefs: HashMap<String, Pref>,
    clients: Vec<Client>,
    caps: HashMap<u32, Cap>,
    stopping: Vec<(u32, Arc<AtomicBool>)>,
    gains: HashMap<u32, f32>,
    plan: logic::Plan,
    /// apps (caminho do executável) do navegador onde a sala está aberta
    room: HashSet<String>,
    /// app → (apps cujo som ele repete, até quando o aviso vale)
    repeats: HashMap<String, (Vec<String>, Instant)>,
    version: usize,
    error: Option<String>,
}
type Shared = Arc<Mutex<State>>;
static CONNECTED: AtomicUsize = AtomicUsize::new(0);

/// app que o site nunca marcou fica de fora (o site manda a marcação de cada app assim que vê a lista)
fn pref_of(prefs: &HashMap<String, Pref>, key: &str) -> (bool, f32) {
    prefs.get(key).map(|p| (p.on, p.vol)).unwrap_or((false, 1.0))
}
fn streaming(st: &State) -> bool { st.clients.iter().any(|c| c.streaming.load(Ordering::Relaxed)) }
fn name_of(st: &State, key: &str) -> String {
    st.apps.iter().find(|a| a.key == key).map(|a| a.name.clone()).unwrap_or_else(|| {
        std::path::Path::new(key).file_stem().map(|s| s.to_string_lossy().to_string()).unwrap_or_else(|| key.to_string())
    })
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


fn scan(icons: &mut HashMap<String, (String, String)>) -> (Vec<App>, Vec<(u32, String, bool)>, HashMap<u32, logic::Proc>) {
    let me = std::process::id();
    let raw = process_table();
    let table: HashMap<u32, logic::Proc> = raw.iter().map(|(&pid, (parent, exe))| (pid, logic::Proc { parent: *parent, exe: exe.clone() })).collect();
    let my_exe = exe_path(me).unwrap_or_default().to_lowercase();
    let mut groups: HashMap<String, App> = HashMap::new();
    let mut sessions = Vec::new();
    for (pid, active) in audio_sessions() {
        let exe_name = raw.get(&pid).map(|t| t.1.clone()).unwrap_or_default();
        if SHELL.contains(&exe_name.as_str()) { continue; }
        let Some(path) = exe_path(pid) else { continue };
        let key = path.to_lowercase();
        if key == my_exe { continue; }
        let (name, icon) = icons.entry(key.clone()).or_insert_with(|| {
            let stem = std::path::Path::new(&path).file_stem().map(|s| s.to_string_lossy().to_string()).unwrap_or_default();
            (file_description(&path).unwrap_or(stem), icon_png(&path))
        }).clone();
        let g = groups.entry(key.clone()).or_insert(App { key: key.clone(), name, icon, pids: vec![], active: false });
        if !g.pids.contains(&pid) { g.pids.push(pid); }
        g.active |= active;
        if !sessions.iter().any(|(p, _, _)| *p == pid) { sessions.push((pid, key, active)); }
    }
    let mut apps: Vec<App> = groups.into_values().collect();
    apps.sort_by(|a, b| a.name.to_lowercase().cmp(&b.name.to_lowercase()));
    (apps, sessions, table)
}

/// situação de cada app para a interface
fn app_state(st: &State, a: &App) -> (&'static str, Option<String>) {
    let (on, _) = pref_of(&st.prefs, &a.key);
    if !on { return ("", None); }
    if st.plan.blocked.contains_key(&a.key) && !st.plan.mixed.values().any(|(k, _)| k == &a.key) { return ("bloqueado", None); }
    if !streaming(st) { return ("pronto", None); }
    let caps: Vec<&Cap> = st.plan.mixed.iter().filter(|(_, (k, _))| k == &a.key).filter_map(|(p, _)| st.caps.get(p)).collect();
    if caps.is_empty() {
        // a captura pode estar dentro da de outro app marcado
        if st.plan.includes.values().any(|v| v.contains(&a.key)) { return ("junto", None); }
        return ("iniciando", None);
    }
    if let Some(e) = caps.iter().find_map(|c| c.err.lock().unwrap().clone()) { if caps.iter().all(|c| !c.alive.load(Ordering::Relaxed)) { return ("falhou", Some(e)); } }
    let now = up_ms();
    if caps.iter().any(|c| now.saturating_sub(c.last.load(Ordering::Relaxed)) < 1500) { "ok" } else { "sem som" }.into_pair()
}
trait Pair { fn into_pair(self) -> (&'static str, Option<String>); }
impl Pair for &'static str { fn into_pair(self) -> (&'static str, Option<String>) { (self, None) } }

fn apps_json(st: &State) -> String {
    let now = Instant::now();
    let list: Vec<_> = st.apps.iter().map(|a| {
        let (on, vol) = pref_of(&st.prefs, &a.key);
        let (state, err) = app_state(st, a);
        let names = |v: &Vec<String>| v.iter().map(|k| name_of(st, k)).collect::<Vec<_>>();
        let blocked = st.plan.blocked.get(&a.key).map(names).unwrap_or_default();
        let includes = st.plan.includes.get(&a.key).map(names).unwrap_or_default();
        let repeats = st.repeats.get(&a.key).filter(|(_, t)| *t > now).map(|(v, _)| names(v)).unwrap_or_default();
        json!({"key": a.key, "name": a.name, "icon": a.icon, "active": a.active, "on": on, "vol": (vol * 100.0).round(),
               "includes": includes, "blocked": blocked, "repeats": repeats, "room": st.room.contains(&a.key), "state": state, "err": err})
    }).collect();
    json!({"t": "apps", "list": list, "error": st.error}).to_string()
}

fn broadcast_text(st: &mut State, text: String) {
    st.clients.retain(|c| c.tx.send(Message::Text(text.clone().into())).is_ok());
}

/* ---------------- Captura por processo ---------------- */

fn start_capture(pid: u32, key: String) -> Cap {
    let cap = Cap {
        stop: Arc::new(AtomicBool::new(false)), q: Arc::new(Mutex::new(VecDeque::new())), alive: Arc::new(AtomicBool::new(true)),
        last: Arc::new(AtomicU64::new(0)), packets: Arc::new(AtomicU64::new(0)), silent: Arc::new(AtomicU64::new(0)),
        err: Arc::new(Mutex::new(None)), key: key.clone(), unused_since: None,
    };
    let (stop, q, alive, last, packets, silent, err) = (cap.stop.clone(), cap.q.clone(), cap.alive.clone(), cap.last.clone(), cap.packets.clone(), cap.silent.clone(), cap.err.clone());
    log(&format!("captura iniciada: {key} (processo {pid})"));
    thread::spawn(move || {
        let r = capture_loop(pid, &stop, &q, &last, &packets, &silent);
        alive.store(false, Ordering::Relaxed);
        match r {
            Ok(()) => log(&format!("captura encerrada: {key} (processo {pid})")),
            Err(e) => {
                let msg = format!("{e}");
                log(&format!("captura falhou: {key} (processo {pid}): {msg}"));
                *err.lock().unwrap() = Some(if msg.contains("0x80070490") || msg.to_lowercase().contains("not found") {
                    "Este Windows não permite capturar o som de um app separado. Atualize para o Windows 11 ou para a versão mais recente do Windows 10.".into()
                } else { msg });
            }
        }
    });
    cap
}

/// Lê os pacotes do Windows assim que ficam prontos (evento), com um buffer de 1 s para nada se perder
/// se o computador demorar. Cada pacote vai com o horário em que foi capturado.
fn capture_loop(pid: u32, stop: &AtomicBool, q: &Mutex<VecDeque<(u64, Vec<f32>)>>, last: &AtomicU64, packets: &AtomicU64, silent: &AtomicU64) -> Result<(), Box<dyn std::error::Error>> {
    let _ = wasapi::initialize_mta();
    let fmt = wasapi::WaveFormat::new(32, 32, &wasapi::SampleType::Float, RATE, CH, None);
    let mut client = wasapi::AudioClient::new_application_loopback_client(pid, true)?;
    client.initialize_client(&fmt, &wasapi::Direction::Capture, &wasapi::StreamMode::EventsShared { autoconvert: true, buffer_duration_hns: 10_000_000 })?;
    let ev = client.set_get_eventhandle()?;
    let cap = client.get_audiocaptureclient()?;
    let frame = CH * 4;
    let mut data = vec![0u8; RATE * frame / 10];
    client.start_stream()?;
    while !stop.load(Ordering::Relaxed) {
        let _ = ev.wait_for_event(200);
        loop {
            let n = cap.get_next_packet_size()?.unwrap_or(0) as usize;
            if n == 0 { break; }
            if data.len() < n * frame { data.resize(n * frame, 0); }
            let (got, info) = cap.read_from_device(&mut data[..n * frame])?;
            let got = got as usize;
            if got == 0 { break; }
            packets.fetch_add(1, Ordering::Relaxed);
            last.store(up_ms(), Ordering::Relaxed);
            // pacote marcado como silêncio: o conteúdo não vale; fica de fora (vira silêncio na mistura)
            if info.flags.silent { silent.fetch_add(1, Ordering::Relaxed); continue; }
            let samples: Vec<f32> = data[..got * frame].chunks_exact(4).map(|c| f32::from_le_bytes([c[0], c[1], c[2], c[3]])).collect();
            let mut g = q.lock().unwrap();
            g.push_back((info.timestamp, samples));
            while g.len() > 400 { g.pop_front(); }
        }
    }
    let _ = client.stop_stream();
    Ok(())
}

/// Decide quem capturar a partir das marcações e liga/desliga as capturas.
fn manage(shared: &Shared) {
    let mut guard = shared.lock().unwrap();
    let st = &mut *guard;
    let on_air = streaming(st);
    let sessions: Vec<logic::SessionIn> = st.sessions.iter().map(|(pid, key, active)| {
        let (on, vol) = pref_of(&st.prefs, key);
        logic::SessionIn { pid: *pid, key: key.clone(), on, vol, active: *active }
    }).collect();
    let plan = logic::plan(&st.table, &sessions, &st.room);
    // log de mudanças de plano
    let desc = |p: &logic::Plan| { let mut v: Vec<String> = p.mixed.iter().map(|(pid, (k, _))| format!("{k}#{pid}")).collect(); v.sort(); v.join(", ") };
    if desc(&plan) != desc(&st.plan) || plan.blocked.len() != st.plan.blocked.len() {
        log(&format!("mistura: [{}]{}", desc(&plan), if plan.blocked.is_empty() { String::new() } else { format!(" bloqueados: {:?}", plan.blocked) }));
    }
    st.gains = plan.mixed.iter().map(|(pid, (_, vol))| (*pid, *vol)).collect();
    let mut want: HashMap<u32, String> = HashMap::new();
    if on_air {
        for (pid, (k, _)) in &plan.mixed { want.insert(*pid, k.clone()); }
        for (pid, k) in &plan.analysis { want.entry(*pid).or_insert_with(|| k.clone()); }
    }
    st.plan = plan;

    let now = Instant::now();
    let pids: Vec<u32> = st.caps.keys().copied().collect();
    for pid in pids {
        let drop_it = {
            let c = st.caps.get_mut(&pid).unwrap();
            if !c.alive.load(Ordering::Relaxed) { true }
            else if want.contains_key(&pid) { c.unused_since = None; false }
            else if !on_air { true }
            else { now.duration_since(*c.unused_since.get_or_insert(now)) > GRACE }
        };
        if drop_it {
            if let Some(c) = st.caps.remove(&pid) { c.stop.store(true, Ordering::Relaxed); st.stopping.push((pid, c.alive.clone())); }
        }
    }
    st.stopping.retain(|(_, a)| a.load(Ordering::Relaxed));
    for (pid, key) in want {
        if st.caps.contains_key(&pid) || st.stopping.iter().any(|(p, _)| *p == pid) { continue; }
        st.caps.insert(pid, start_capture(pid, key));
    }
}

/* ---------------- Mistura ---------------- */

fn mixer(shared: Shared) {
    let mut core = logic::MixCore::default();
    let mut ticks = 0u64;
    let mut was_on = false;
    loop {
        thread::sleep(Duration::from_millis(10));
        let now = logic::t100_to_frame(qpc_100ns());
        let mut guard = shared.lock().unwrap();
        let st = &mut *guard;
        if !streaming(st) {
            if was_on { core.reset(); was_on = false; }
            for c in st.caps.values() { c.q.lock().unwrap().clear(); }
            continue;
        }
        was_on = true;
        if core.begin(now) { log("a mistura ficou para trás e recomeçou perto do agora"); }
        for (pid, c) in st.caps.iter() {
            let mut q = c.q.lock().unwrap();
            while let Some((ts, s)) = q.pop_front() { core.place(*pid, logic::t100_to_frame(ts), &s); }
        }
        let alive: HashSet<u32> = st.caps.keys().copied().collect();
        core.keep(&alive);
        let out = core.emit(now, &st.gains);
        if !out.is_empty() {
            let mut bytes = Vec::with_capacity(out.len() * 4);
            for s in &out { bytes.extend_from_slice(&s.clamp(-1.0, 1.0).to_le_bytes()); }
            st.clients.retain(|c| !c.streaming.load(Ordering::Relaxed) || c.tx.send(Message::Binary(bytes.clone().into())).is_ok());
        }
        ticks += 1;
        // a cada 150 ms: nível de cada app (antes do volume) e situação da captura
        if ticks % 15 == 0 {
            let mut lv: HashMap<String, f32> = HashMap::new();
            let mut stt: HashMap<String, &str> = HashMap::new();
            for a in &st.apps {
                let mut best = 0f32;
                for (pid, c) in &st.caps { if c.key == a.key { if let Some(e) = core.env.get(pid) { for v in e.iter().rev().take(15) { best = best.max(*v); } } } }
                if st.caps.values().any(|c| c.key == a.key) { lv.insert(a.key.clone(), (best * 1000.0).round() / 1000.0); }
                let (s, _) = app_state(st, a);
                if !s.is_empty() { stt.insert(a.key.clone(), s); }
            }
            let text = json!({"t": "levels", "l": lv, "s": stt}).to_string();
            st.clients.retain(|c| !c.streaming.load(Ordering::Relaxed) || c.tx.send(Message::Text(text.clone().into())).is_ok());
        }
        // a cada 1 s: quem está repetindo o som de quem
        if ticks % 100 == 0 {
            let mut env: HashMap<String, Vec<f32>> = HashMap::new();
            for (pid, c) in &st.caps {
                let Some(e) = core.env.get(pid) else { continue };
                let v = env.entry(c.key.clone()).or_insert_with(|| vec![0.0; e.len()]);
                if v.len() < e.len() { v.resize(e.len(), 0.0); }
                let off = v.len() - e.len();
                for (i, x) in e.iter().enumerate() { v[off + i] = v[off + i].max(*x); }
            }
            let found = logic::repeats(&env, 0.85);
            let until = Instant::now() + Duration::from_secs(15);
            let mut changed = false;
            for (a, list) in found {
                let names: Vec<String> = list.into_iter().map(|(b, _)| b).collect();
                let same = st.repeats.get(&a).map_or(false, |(v, _)| *v == names);
                if !same { log(&format!("{} parece repetir o som de {:?}", a, names)); changed = true; }
                st.repeats.insert(a, (names, until));
            }
            let before = st.repeats.len();
            let now_i = Instant::now();
            st.repeats.retain(|_, (_, t)| *t > now_i);
            if changed || before != st.repeats.len() { st.version += 1; }
            if ticks % 1000 == 0 {
                // resumo a cada 10 s no registro, para diagnóstico
                let mut parts: Vec<String> = st.caps.iter().map(|(pid, c)| format!("{}#{} {}pac {}sil vol={:?}", c.key.rsplit('\\').next().unwrap_or(""), pid, c.packets.load(Ordering::Relaxed), c.silent.load(Ordering::Relaxed), st.gains.get(pid))).collect();
                parts.sort();
                log(&format!("resumo: atrasados={} | {}", core.late, parts.join(" | ")));
            }
        }
    }
}

/* ---------------- Qual navegador abriu a conexão ---------------- */

/// O navegador que conecta ao programa é o mesmo em que a sala está aberta. Marcar esse navegador
/// devolveria as vozes e as telas da sala para a transmissão (eco), então a interface avisa.
fn browser_of_connection(peer_port: u16) -> Option<String> {
    unsafe {
        let mut size = 0u32;
        let _ = GetExtendedTcpTable(None, &mut size, false, AF_INET.0 as u32, TCP_TABLE_OWNER_PID_ALL, 0);
        if size == 0 { return None; }
        let mut buf = vec![0u8; size as usize + 1024];
        size = buf.len() as u32;
        if GetExtendedTcpTable(Some(buf.as_mut_ptr() as *mut _), &mut size, false, AF_INET.0 as u32, TCP_TABLE_OWNER_PID_ALL, 0) != 0 { return None; }
        let t = &*(buf.as_ptr() as *const MIB_TCPTABLE_OWNER_PID);
        let rows = std::slice::from_raw_parts(t.table.as_ptr(), t.dwNumEntries as usize);
        let port = |v: u32| u16::from_be((v & 0xffff) as u16);
        let row = rows.iter().find(|r| port(r.dwLocalPort) == peer_port && port(r.dwRemotePort) == PORT)?;
        let pid = row.dwOwningPid;
        // sobe até o processo principal do navegador
        let table = process_table();
        let exe = table.get(&pid)?.1.clone();
        let mut cur = pid;
        for _ in 0..8 {
            let Some((parent, _)) = table.get(&cur) else { break };
            match table.get(parent) { Some((_, e)) if *e == exe && *parent != cur => cur = *parent, _ => break }
        }
        exe_path(cur).map(|p| p.to_lowercase())
    }
}

/* ---------------- WebSocket local ---------------- */

#[derive(Deserialize)]
struct In { t: String, key: Option<String>, on: Option<bool>, vol: Option<f32>, apps: Option<HashMap<String, PrefIn>> }
#[derive(Deserialize)]
struct PrefIn { on: bool, vol: Option<f32> }

fn origin_ok(o: &str) -> bool {
    // só o próprio site: nenhuma outra página, nem servidores locais, controla o programa
    ALLOWED.contains(&o)
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
            log(&format!("conexão recusada de {o}"));
            let mut r = ErrorResponse::new(Some("origem não autorizada".into()));
            *r.status_mut() = tungstenite::http::StatusCode::FORBIDDEN; Err(r)
        }
    };
    let peer_port = stream.peer_addr().map(|a| a.port()).unwrap_or(0);
    // mensagens do site são pequenas: limita o tamanho para ninguém travar o programa
    let mut cfg = tungstenite::protocol::WebSocketConfig::default();
    cfg.max_message_size = Some(64 * 1024); cfg.max_frame_size = Some(64 * 1024);
    let mut ws = tungstenite::accept_hdr_with_config(stream.try_clone()?, check, Some(cfg))?;
    stream.set_nodelay(true)?;
    stream.set_nonblocking(true)?;
    let browser = browser_of_connection(peer_port);
    log(&format!("site conectado (navegador: {})", browser.as_deref().unwrap_or("desconhecido")));
    let (tx, rx): (Sender<Message>, Receiver<Message>) = channel();
    let on_air = Arc::new(AtomicBool::new(false));
    {
        let mut st = shared.lock().unwrap();
        if let Some(b) = &browser { st.room.insert(b.clone()); }
        st.clients.push(Client { tx: tx.clone(), streaming: on_air.clone() });
        st.version += 1;
        let hello = json!({"t": "hello", "v": 2, "ver": env!("CARGO_PKG_VERSION"), "rate": RATE, "ch": CH, "name": "Cineminha Áudio", "room": browser}).to_string();
        let _ = tx.send(Message::Text(hello.into()));
        let _ = tx.send(Message::Text(apps_json(&st).into()));
    }
    CONNECTED.fetch_add(1, Ordering::Relaxed);
    let would = |e: &tungstenite::Error| matches!(e, tungstenite::Error::Io(io) if io.kind() == std::io::ErrorKind::WouldBlock);
    let result = (|| -> Result<(), Box<dyn std::error::Error>> {
        loop {
            let mut busy = false;
            match ws.read() {
                Ok(Message::Text(t)) => {
                    busy = true;
                    if let Ok(m) = serde_json::from_str::<In>(&t) {
                        let mut st = shared.lock().unwrap();
                        match m.t.as_str() {
                            "start" => { if !on_air.swap(true, Ordering::Relaxed) { log("transmissão começou: som dos apps ligado"); } }
                            "stop" => { if on_air.swap(false, Ordering::Relaxed) { log("transmissão parou"); } }
                            "set" => if let Some(k) = m.key {
                                let (on0, vol0) = pref_of(&st.prefs, &k);
                                let on = m.on.unwrap_or(on0);
                                log(&format!("{} {}", if on { "marcado:" } else { "desmarcado:" }, k));
                                st.prefs.insert(k, Pref { on, vol: m.vol.map(|v| (v / 100.0).clamp(0.0, 1.5)).unwrap_or(vol0) });
                            },
                            "prefs" => if let Some(a) = m.apps {
                                for (k, p) in a { st.prefs.insert(k, Pref { on: p.on, vol: p.vol.map(|v| (v / 100.0).clamp(0.0, 1.5)).unwrap_or(1.0) }); }
                            },
                            _ => {}
                        }
                        st.version += 1;
                        drop(st);
                        manage(&shared);
                    }
                }
                Ok(Message::Close(_)) => break,
                Ok(_) => { busy = true; }
                Err(ref e) if would(e) => {}
                Err(e) => { log(&format!("conexão com o site caiu: {e}")); break; }
            }
            let mut wrote = false;
            while let Ok(msg) = rx.try_recv() {
                wrote = true;
                if let Err(e) = ws.write(msg) { if !would(&e) { log(&format!("erro ao enviar: {e}")); return Ok(()); } }
            }
            if wrote { if let Err(e) = ws.flush() { if !would(&e) { log(&format!("erro ao enviar: {e}")); return Ok(()); } } }
            if !busy && !wrote { thread::sleep(Duration::from_millis(2)); }
        }
        Ok(())
    })();
    on_air.store(false, Ordering::Relaxed);
    log("site desconectado");
    CONNECTED.fetch_sub(1, Ordering::Relaxed);
    {
        let mut st = shared.lock().unwrap();
        st.clients.retain(|c| !Arc::ptr_eq(&c.streaming, &on_air));
        if st.clients.is_empty() { st.room.clear(); }
    }
    manage(&shared);
    result
}
/* ---------------- Bandeja do Windows ---------------- */

const WM_TRAY: u32 = WM_APP + 1;
const ID_OPEN: usize = 1;
const ID_QUIT: usize = 2;
const ID_LOG: usize = 3;

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
                let _ = AppendMenuW(menu, MF_STRING, ID_LOG, w!("Abrir registro (diagnóstico)"));
                let _ = AppendMenuW(menu, MF_STRING, ID_QUIT, w!("Sair"));
                let mut pt = POINT::default();
                let _ = GetCursorPos(&mut pt);
                let _ = SetForegroundWindow(hwnd);
                let cmd = TrackPopupMenu(menu, TPM_RETURNCMD | TPM_RIGHTBUTTON | TPM_BOTTOMALIGN, pt.x, pt.y, Some(0), hwnd, None);
                let _ = DestroyMenu(menu);
                match cmd.0 as usize {
                    ID_OPEN => { ShellExecuteW(None, w!("open"), PCWSTR(wide(SITE).as_ptr()), PCWSTR::null(), PCWSTR::null(), SW_SHOWNORMAL); }
                    ID_LOG => { let p = wide(&log_path().to_string_lossy()); ShellExecuteW(None, w!("open"), PCWSTR(p.as_ptr()), PCWSTR::null(), PCWSTR::null(), SW_SHOWNORMAL); }
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
    log_open();
    log(&format!("Cineminha Áudio {} ligado", env!("CARGO_PKG_VERSION")));
    let listener = match TcpListener::bind(("127.0.0.1", PORT)) {
        Ok(l) => l,
        Err(_) => { message_box("Não foi possível iniciar: a porta 47833 está em uso por outro programa."); return; }
    };
    let shared: Shared = Arc::new(Mutex::new(State {
        apps: vec![], sessions: vec![], table: HashMap::new(), prefs: HashMap::new(), clients: vec![], caps: HashMap::new(),
        stopping: vec![], gains: HashMap::new(), plan: logic::Plan::default(), room: HashSet::new(), repeats: HashMap::new(),
        version: 0, error: None,
    }));

    { let sh = shared.clone(); thread::spawn(move || serve(sh, listener)); }
    {
        let sh = shared.clone();
        thread::Builder::new().name("mistura".into()).spawn(move || {
            unsafe { let _ = windows::Win32::System::Threading::SetThreadPriority(windows::Win32::System::Threading::GetCurrentThread(), THREAD_PRIORITY_HIGHEST); }
            mixer(sh)
        }).ok();
    }
    {
        // varre os apps a cada 1 s e avisa o site quando algo muda
        let sh = shared.clone();
        thread::spawn(move || {
            unsafe { let _ = CoInitializeEx(None, COINIT_MULTITHREADED); }
            let mut icons = HashMap::new();
            let (mut last_sent, mut last_version) = (String::new(), usize::MAX);
            loop {
                let (apps, sessions, table) = scan(&mut icons);
                {
                    let mut st = sh.lock().unwrap();
                    st.apps = apps; st.sessions = sessions; st.table = table;
                }
                manage(&sh);
                {
                    let mut st = sh.lock().unwrap();
                    let text = apps_json(&st);
                    if text != last_sent || st.version != last_version {
                        last_sent = text.clone(); last_version = st.version;
                        broadcast_text(&mut st, text);
                    }
                }
                thread::sleep(Duration::from_millis(1000));
            }
        });
    }
    tray();
}
