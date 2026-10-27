//! Lógica do Cineminha Áudio que não depende do Windows.
//!
//! O Windows captura o som de um processo junto com todos os processos que ele abriu
//! (PROCESS_LOOPBACK_MODE_INCLUDE_TARGET_PROCESS_TREE) e não oferece um modo "só este processo".
//! Por isso a escolha de quem capturar é o que garante a separação:
//!  - cada app marcado é capturado pelo processo dono da sessão de áudio;
//!  - sobe para o processo principal do mesmo programa só se nenhum app desmarcado estiver
//!    na árvore dele (assim a captura sobrevive ao Chrome/Discord recriarem o processo do som);
//!  - nunca captura uma árvore que tenha um app desmarcado: nesse caso o app fica bloqueado
//!    e a interface explica quem está bloqueando (o mesmo critério do win-capture-audio do OBS).
//! A mistura posiciona cada pacote pelo horário em que o Windows o capturou, como o OBS faz,
//! para os apps ficarem alinhados e o silêncio não virar falha.

use std::collections::{HashMap, HashSet, VecDeque};

pub const RATE: u64 = 48_000;
pub const CH: usize = 2;
/// a mistura sai com este atraso em relação ao agora, para dar tempo de os pacotes chegarem
pub const LATENCY_MS: u64 = 40;
/// ao começar (ou depois de um atraso grande), a mistura começa este tanto atrás do agora
pub const START_MS: u64 = 120;
/// tamanho de cada ponto do envelope usado para detectar repetição (10 ms)
pub const ENV_BLOCK: usize = (RATE / 100) as usize;
/// quantos pontos de envelope guardar (3 s)
pub const ENV_LEN: usize = 300;

pub const fn ms_to_frames(ms: u64) -> u64 { RATE * ms / 1000 }
/// horário do Windows (unidades de 100 ns) para número da amostra a 48 kHz
pub fn t100_to_frame(t: u64) -> u64 { ((t as u128) * RATE as u128 / 10_000_000) as u64 }

/* ---------------- Escolha de quem capturar ---------------- */

#[derive(Clone, Debug)]
pub struct Proc { pub parent: u32, pub exe: String }

#[derive(Clone, Debug)]
pub struct SessionIn {
    pub pid: u32,
    /// identifica o app (caminho do executável em minúsculas)
    pub key: String,
    pub on: bool,
    pub vol: f32,
    /// tocando agora
    pub active: bool,
}

#[derive(Default, Debug)]
pub struct Plan {
    /// processo alvo → (app, volume) que entra na transmissão
    pub mixed: HashMap<u32, (String, f32)>,
    /// processo alvo → app capturado só para análise (não entra na transmissão)
    pub analysis: HashMap<u32, String>,
    /// app marcado que ficou de fora → apps desmarcados que estão dentro dele
    pub blocked: HashMap<String, Vec<String>>,
    /// app marcado → outros apps marcados que entram junto na mesma captura
    pub includes: HashMap<String, Vec<String>>,
}

pub fn children(table: &HashMap<u32, Proc>) -> HashMap<u32, Vec<u32>> {
    let mut ch: HashMap<u32, Vec<u32>> = HashMap::new();
    for (&pid, p) in table { if p.parent != pid { ch.entry(p.parent).or_default().push(pid); } }
    ch
}

/// o processo e todos os que ele abriu
pub fn subtree(pid: u32, ch: &HashMap<u32, Vec<u32>>) -> HashSet<u32> {
    let mut out = HashSet::new();
    let mut stack = vec![pid];
    while let Some(p) = stack.pop() {
        if !out.insert(p) { continue; }
        if let Some(c) = ch.get(&p) { stack.extend(c.iter().copied()); }
    }
    out
}

pub fn plan(table: &HashMap<u32, Proc>, sessions: &[SessionIn], no_analysis: &HashSet<String>) -> Plan {
    let ch = children(table);
    let mut plan = Plan::default();
    // sessões desmarcadas: nenhuma captura pode conter uma delas
    let off: HashMap<u32, &str> = sessions.iter().filter(|s| !s.on).map(|s| (s.pid, s.key.as_str())).collect();
    let exe_of = |pid: u32| table.get(&pid).map(|p| p.exe.as_str()).unwrap_or("");
    let leaks = |pid: u32| -> Vec<String> {
        let t = subtree(pid, &ch);
        let mut v: Vec<String> = off.iter().filter(|(p, _)| t.contains(p)).map(|(_, k)| k.to_string()).collect();
        v.sort(); v.dedup(); v
    };

    let mut targets: HashMap<u32, (String, f32)> = HashMap::new();
    for s in sessions.iter().filter(|s| s.on) {
        let bad = leaks(s.pid);
        if !bad.is_empty() {
            let e = plan.blocked.entry(s.key.clone()).or_default();
            for b in bad { if !e.contains(&b) { e.push(b); } }
            continue;
        }
        // sobe pelo mesmo programa enquanto a árvore continuar limpa
        let exe = exe_of(s.pid).to_string();
        let mut target = s.pid;
        for _ in 0..8 {
            let Some(p) = table.get(&target) else { break };
            let parent = p.parent;
            if parent == 0 || parent == target || exe.is_empty() || exe_of(parent) != exe { break; }
            if !leaks(parent).is_empty() { break; }
            target = parent;
        }
        targets.entry(target).or_insert((s.key.clone(), s.vol));
    }
    // um alvo que já está dentro da árvore de outro alvo sairia duplicado
    let ids: Vec<u32> = targets.keys().copied().collect();
    let trees: HashMap<u32, HashSet<u32>> = ids.iter().map(|&p| (p, subtree(p, &ch))).collect();
    for &t in &ids {
        if ids.iter().any(|&o| o != t && trees[&o].contains(&t)) { continue; }
        let (key, vol) = targets[&t].clone();
        // quem mais (marcado) vem junto nesta captura
        let mut inc: Vec<String> = sessions.iter().filter(|s| s.on && s.key != key && trees[&t].contains(&s.pid)).map(|s| s.key.clone()).collect();
        inc.sort(); inc.dedup();
        if !inc.is_empty() { plan.includes.entry(key.clone()).or_default().extend(inc); }
        plan.mixed.insert(t, (key, vol));
    }
    // app desmarcado que está tocando: captura só para análise (descobrir se ele repete o som de outros)
    for s in sessions.iter().filter(|s| !s.on && s.active && !no_analysis.contains(&s.key)) {
        if plan.mixed.contains_key(&s.pid) { continue; }
        if plan.analysis.len() >= 12 { break; }
        plan.analysis.insert(s.pid, s.key.clone());
    }
    for v in plan.includes.values_mut() { v.sort(); v.dedup(); }
    plan
}

/* ---------------- Mistura pelo horário de cada pacote ---------------- */

#[derive(Default)]
pub struct MixCore {
    /// número da amostra que a próxima saída começa
    pub cursor: Option<u64>,
    tracks: HashMap<u32, VecDeque<f32>>,
    part: HashMap<u32, (f64, usize)>,
    blk: usize,
    /// envelope (força do som a cada 10 ms) de cada processo capturado, alinhado entre todos
    pub env: HashMap<u32, VecDeque<f32>>,
    /// pacotes que chegaram tarde demais e foram descartados
    pub late: u64,
}

impl MixCore {
    pub fn reset(&mut self) { self.cursor = None; self.tracks.clear(); self.part.clear(); self.blk = 0; self.env.clear(); }

    /// prepara a saída para o momento `now` (amostras); retorna true se precisou recomeçar
    pub fn begin(&mut self, now: u64) -> bool {
        let start = now.saturating_sub(ms_to_frames(START_MS));
        match self.cursor {
            None => { self.cursor = Some(start); false }
            Some(c) if now > c + ms_to_frames(500) + ms_to_frames(LATENCY_MS) => {
                // ficou muito para trás (computador travou, por exemplo): recomeça perto do agora
                self.tracks.clear(); self.part.clear(); self.cursor = Some(start); true
            }
            _ => false,
        }
    }

    /// coloca um pacote capturado no lugar certo da linha do tempo do processo `pid`
    pub fn place(&mut self, pid: u32, at: u64, samples: &[f32]) {
        let Some(c) = self.cursor else { return };
        let frames = samples.len() / CH;
        let rel = at as i64 - c as i64;
        if rel + frames as i64 <= 0 { self.late += 1; return; }
        if rel > ms_to_frames(2000) as i64 { return; }
        let skip = if rel < 0 { (-rel) as usize } else { 0 };
        let off = rel.max(0) as usize;
        let tr = self.tracks.entry(pid).or_default();
        let need = (off + frames - skip) * CH;
        if tr.len() < need { tr.resize(need, 0.0); }
        for (i, v) in samples[skip * CH..].iter().enumerate() { tr[off * CH + i] += *v; }
    }

    /// entrega tudo que já pode sair até `now` (menos a latência), misturado com os volumes de `gains`
    pub fn emit(&mut self, now: u64, gains: &HashMap<u32, f32>) -> Vec<f32> {
        let Some(c) = self.cursor else { return Vec::new() };
        let end = now.saturating_sub(ms_to_frames(LATENCY_MS));
        if end <= c { return Vec::new(); }
        let ready = ((end - c) as usize).min(ms_to_frames(200) as usize);
        let mut out = vec![0f32; ready * CH];
        let pids: Vec<u32> = self.tracks.keys().copied().chain(self.env.keys().copied()).collect::<HashSet<_>>().into_iter().collect();
        for pid in &pids {
            let g = gains.get(pid).copied().unwrap_or(0.0);
            let p = self.part.entry(*pid).or_insert((0.0, 0));
            if let Some(tr) = self.tracks.get_mut(pid) {
                let k = tr.len().min(ready * CH);
                for (i, v) in tr.drain(..k).enumerate() { out[i] += v * g; p.0 += (v * v) as f64; }
            }
            p.1 += ready * CH;
        }
        // fecha os pontos de envelope de 10 ms
        self.blk += ready;
        while self.blk >= ENV_BLOCK {
            self.blk -= ENV_BLOCK;
            for pid in &pids {
                let (s, n) = self.part.remove(pid).unwrap_or((0.0, 0));
                let rms = if n > 0 { (s / n as f64).sqrt() as f32 } else { 0.0 };
                let e = self.env.entry(*pid).or_default();
                e.push_back(rms);
                while e.len() > ENV_LEN { e.pop_front(); }
            }
        }
        self.cursor = Some(c + ready as u64);
        out
    }

    /// esquece processos que não são mais capturados
    pub fn keep(&mut self, alive: &HashSet<u32>) {
        self.tracks.retain(|p, _| alive.contains(p));
        self.part.retain(|p, _| alive.contains(p));
        self.env.retain(|p, _| alive.contains(p));
    }
}

/* ---------------- Detecção de app que repete o som de outro ---------------- */

/// Programas como o OBS (com monitoramento), o Radeon Settings ou apps que transmitem o som do PC
/// tocam de novo o que os outros apps tocam. Marcar um deles leva o som desses outros apps junto.
/// Compara a força do som de cada app ao longo dos últimos segundos: se o envelope de A acompanha o
/// de B e vem depois dele (de 10 a 80 ms, o tempo que um programa leva para tocar de novo), A está repetindo B.
/// A exigência de vir depois separa quem repete de quem toca o original.
pub fn repeats(env: &HashMap<String, Vec<f32>>, min_r: f32) -> HashMap<String, Vec<(String, f32)>> {
    let mut out: HashMap<String, Vec<(String, f32)>> = HashMap::new();
    let active = |v: &[f32]| -> bool {
        let loud = v.iter().filter(|x| **x > 0.003).count();
        v.len() >= 150 && loud * 10 >= v.len() * 3
    };
    for (a, ea) in env {
        if !active(ea) { continue; }
        for (b, eb) in env {
            if a == b || !active(eb) { continue; }
            let n = ea.len().min(eb.len());
            let (xa, xb) = (&ea[ea.len() - n..], &eb[eb.len() - n..]);
            let (mut best, mut at) = (-1f32, 0i32);
            for lag in -8i32..=8 {
                let r = pearson(xa, xb, lag);
                if r > best { best = r; at = lag; }
            }
            // lag negativo: o som de A aparece depois do de B
            if best >= min_r && at < 0 { out.entry(a.clone()).or_default().push((b.clone(), best)); }
        }
    }
    for v in out.values_mut() { v.sort_by(|x, y| y.1.partial_cmp(&x.1).unwrap()); }
    out
}

fn pearson(a: &[f32], b: &[f32], lag: i32) -> f32 {
    let n = a.len() as i32;
    let (mut sa, mut sb, mut saa, mut sbb, mut sab, mut k) = (0f64, 0f64, 0f64, 0f64, 0f64, 0f64);
    for i in 0..n {
        let j = i + lag;
        if j < 0 || j >= n { continue; }
        let (x, y) = (a[i as usize] as f64, b[j as usize] as f64);
        sa += x; sb += y; saa += x * x; sbb += y * y; sab += x * y; k += 1.0;
    }
    if k < 50.0 { return 0.0; }
    let cov = sab / k - (sa / k) * (sb / k);
    let va = saa / k - (sa / k).powi(2);
    let vb = sbb / k - (sb / k).powi(2);
    if va <= 1e-12 || vb <= 1e-12 { return 0.0; }
    (cov / (va.sqrt() * vb.sqrt())) as f32
}

#[cfg(test)]
mod tests {
    use super::*;

    fn t(rows: &[(u32, u32, &str)]) -> HashMap<u32, Proc> {
        rows.iter().map(|&(pid, parent, exe)| (pid, Proc { parent, exe: exe.into() })).collect()
    }
    fn s(pid: u32, key: &str, on: bool) -> SessionIn { SessionIn { pid, key: key.into(), on, vol: 1.0, active: true } }

    #[test]
    fn chrome_sobe_para_o_processo_principal() {
        // explorer → chrome (principal) → chrome (serviço de áudio)
        let tb = t(&[(1, 0, "explorer.exe"), (10, 1, "chrome.exe"), (11, 10, "chrome.exe"), (12, 10, "chrome.exe")]);
        let p = plan(&tb, &[s(12, "chrome", true)], &HashSet::new());
        assert_eq!(p.mixed.keys().copied().collect::<Vec<_>>(), vec![10]);
    }

    #[test]
    fn steam_marcada_nao_leva_o_jogo_desmarcado() {
        // steam → steamwebhelper (som da loja) ; steam → jogo (desmarcado)
        let tb = t(&[(1, 0, "explorer.exe"), (20, 1, "steam.exe"), (21, 20, "steamwebhelper.exe"), (22, 20, "jogo.exe")]);
        let p = plan(&tb, &[s(20, "steam", true), s(21, "steam-web", true), s(22, "jogo", false)], &HashSet::new());
        assert!(!p.mixed.contains_key(&20), "a árvore da Steam contém o jogo desmarcado");
        assert!(p.mixed.contains_key(&21));
        assert_eq!(p.blocked.get("steam").unwrap(), &vec!["jogo".to_string()]);
    }

    #[test]
    fn processo_do_mesmo_programa_nao_sobe_se_vazar() {
        // discord principal tem um filho de outro app desmarcado: fica no processo do som
        let tb = t(&[(30, 1, "discord.exe"), (31, 30, "discord.exe"), (32, 30, "outro.exe")]);
        let p = plan(&tb, &[s(31, "discord", true), s(32, "outro", false)], &HashSet::new());
        assert_eq!(p.mixed.keys().copied().collect::<Vec<_>>(), vec![31]);
        assert!(p.blocked.is_empty());
    }

    #[test]
    fn sem_duplicar_quem_ja_esta_dentro() {
        let tb = t(&[(40, 1, "launcher.exe"), (41, 40, "game.exe")]);
        let p = plan(&tb, &[s(40, "launcher", true), s(41, "game", true)], &HashSet::new());
        assert_eq!(p.mixed.len(), 1);
        assert!(p.mixed.contains_key(&40));
        assert_eq!(p.includes.get("launcher").unwrap(), &vec!["game".to_string()]);
    }

    #[test]
    fn desmarcado_tocando_vira_analise_e_navegador_da_sala_nao() {
        let tb = t(&[(50, 1, "spotify.exe"), (60, 1, "brave.exe")]);
        let mut no = HashSet::new(); no.insert("brave".to_string());
        let p = plan(&tb, &[s(50, "spotify", false), s(60, "brave", false)], &no);
        assert!(p.mixed.is_empty());
        assert!(p.analysis.contains_key(&50));
        assert!(!p.analysis.contains_key(&60));
    }

    #[test]
    fn mistura_alinha_pelo_horario() {
        let mut m = MixCore::default();
        let now = 1_000_000u64;
        m.begin(now);
        let c = m.cursor.unwrap();
        // pacote do app 1 começa no cursor, do app 2 começa 100 amostras depois
        m.place(1, c, &vec![0.5; 480 * CH]);
        m.place(2, c + 100, &vec![0.25; 480 * CH]);
        let g: HashMap<u32, f32> = [(1, 1.0), (2, 1.0)].into_iter().collect();
        let out = m.emit(c + ms_to_frames(LATENCY_MS) + 600, &g);
        assert_eq!(out.len(), 600 * CH);
        assert!((out[0] - 0.5).abs() < 1e-6);
        assert!((out[99 * CH] - 0.5).abs() < 1e-6);
        assert!((out[100 * CH] - 0.75).abs() < 1e-6, "os dois juntos a partir da amostra 100");
        assert!((out[500 * CH] - 0.25).abs() < 1e-6, "só o app 2 depois do fim do app 1");
        assert!(out[590 * CH].abs() < 1e-6, "silêncio onde nenhum app tocou");
    }

    #[test]
    fn desmarcado_nao_entra_na_mistura_e_atrasado_e_descartado() {
        let mut m = MixCore::default();
        m.begin(1_000_000);
        let c = m.cursor.unwrap();
        m.place(1, c, &vec![0.9; 100 * CH]);
        m.place(3, c, &vec![0.9; 100 * CH]);
        let g: HashMap<u32, f32> = [(1, 0.0)].into_iter().collect();
        let out = m.emit(c + ms_to_frames(LATENCY_MS) + 100, &g);
        assert!(out.iter().all(|v| v.abs() < 1e-6));
        m.place(1, c, &vec![0.9; 50 * CH]);
        assert_eq!(m.late, 1);
    }

    #[test]
    fn detecta_app_que_repete_outro() {
        let mut env = HashMap::new();
        // música com volume que varia
        let musica: Vec<f32> = (0..300).map(|i| 0.05 + 0.04 * ((i as f32) * 0.37).sin().abs() + if i % 23 < 4 { 0.08 } else { 0.0 }).collect();
        // um app que repete a música 30 ms atrasada, mais baixo, e outro independente
        let repetidor: Vec<f32> = (0..300).map(|i| if i >= 3 { musica[i - 3] * 0.6 } else { 0.03 }).collect();
        let outro: Vec<f32> = (0..300).map(|i| 0.05 + 0.04 * ((i as f32) * 1.91 + 2.0).cos().abs()).collect();
        env.insert("spotify".to_string(), musica);
        env.insert("obs".to_string(), repetidor);
        env.insert("jogo".to_string(), outro);
        let r = repeats(&env, 0.8);
        assert!(r.get("obs").map_or(false, |v| v[0].0 == "spotify"));
        assert!(r.get("jogo").is_none());
        assert!(r.get("spotify").is_none(), "quem toca o original não é acusado");
    }
}
