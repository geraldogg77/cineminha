/**
 * Cineminha · gerador de credenciais TURN (Cloudflare Worker)
 *
 * O site é estático, então a chave TURN não pode ficar nele. Este Worker guarda a
 * chave como segredo e entrega ao navegador só credenciais temporárias.
 *
 * Segredos (Workers → seu worker → Settings → Variables and Secrets):
 *   TURN_KEY_ID         ID da chave TURN (painel Realtime/Calls → TURN)
 *   TURN_KEY_API_TOKEN  token da API dessa chave
 * Variável opcional:
 *   ALLOWED_ORIGINS     origens aceitas, separadas por vírgula
 *                       padrão: https://geraldogg77.github.io
 */

const TTL = 12 * 60 * 60;            // credenciais valem 12 horas
const DEFAULT_ORIGINS = 'https://geraldogg77.github.io';
const LOCAL = /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/;

export default {
  async fetch(request, env) {
    const origin = request.headers.get('Origin') || '';
    const allowed = (env.ALLOWED_ORIGINS || DEFAULT_ORIGINS).split(',').map(s => s.trim()).filter(Boolean);
    const ok = allowed.includes(origin) || LOCAL.test(origin);
    const cors = {
      'Access-Control-Allow-Origin': ok ? origin : allowed[0],
      'Access-Control-Allow-Methods': 'GET, OPTIONS',
      'Access-Control-Max-Age': '86400',
      'Vary': 'Origin'
    };
    if (request.method === 'OPTIONS') return new Response(null, {status: 204, headers: cors});
    if (request.method !== 'GET') return json({error: 'Use GET.'}, 405, cors);
    // Bloqueia uso a partir de outros sites. Não impede quem forja o cabeçalho,
    // mas evita que outros sites usem sua cota pelo navegador dos visitantes deles.
    if (!ok) return json({error: 'Origem não autorizada.'}, 403, cors);
    if (!env.TURN_KEY_ID || !env.TURN_KEY_API_TOKEN) return json({error: 'Segredos TURN_KEY_ID e TURN_KEY_API_TOKEN não configurados.'}, 500, cors);

    const r = await fetch(`https://rtc.live.cloudflare.com/v1/turn/keys/${env.TURN_KEY_ID}/credentials/generate-ice-servers`, {
      method: 'POST',
      headers: {Authorization: `Bearer ${env.TURN_KEY_API_TOKEN}`, 'Content-Type': 'application/json'},
      body: JSON.stringify({ttl: TTL})
    });
    if (!r.ok) return json({error: 'A Cloudflare recusou o pedido de credenciais (' + r.status + ').'}, 502, cors);

    const data = await r.json();
    // Os navegadores bloqueiam a porta 53; tirar essas URLs evita esperas inúteis.
    const iceServers = (data.iceServers || []).map(s => {
      const urls = (Array.isArray(s.urls) ? s.urls : [s.urls]).filter(u => !/:53(\?|$)/.test(u));
      return {...s, urls};
    }).filter(s => s.urls.length);

    return json({iceServers, ttl: TTL}, 200, {...cors, 'Cache-Control': 'no-store'});
  }
};

function json(body, status, headers) {
  return new Response(JSON.stringify(body), {status, headers: {...headers, 'Content-Type': 'application/json; charset=utf-8'}});
}
