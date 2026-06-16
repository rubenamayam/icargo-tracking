const Redis = require('ioredis');
const fetch = require('node-fetch');

const redis = new Redis("rediss://default:gQAAAAAAAgxlAAIgcDFmM2RjMjM0NzllMmI0ODkwOWQ2YmI4NjZlMDk3MDVlYQ@select-ibex-134245.upstash.io:6379");

const KEY = 'icargo:guias';
const DESTINOS = { FLO: 'Hacienda Cañaveral', BUC: 'Mirador del Cacique' };
const ALERTAS = ['retenida','reprogramado','demora','retenido','reajuste'];

async function sendWhatsApp(message) {
  const sid = process.env.TWILIO_ACCOUNT_SID;
  const token = process.env.TWILIO_AUTH_TOKEN;
  const from = process.env.TWILIO_WHATSAPP_FROM;
  const to = process.env.TWILIO_WHATSAPP_TO;
  const url = `https://api.twilio.com/2010-04-01/Accounts/${sid}/Messages.json`;
  const body = new URLSearchParams({ From: from, To: to, Body: message });
  const resp = await fetch(url, {
    method: 'POST',
    headers: {
      'Authorization': 'Basic ' + Buffer.from(`${sid}:${token}`).toString('base64'),
      'Content-Type': 'application/x-www-form-urlencoded'
    },
    body
  });
  return resp.json();
}

function diasEnTransito(g) {
  const inicio = g.fechaEnvio ? new Date(g.fechaEnvio) : new Date(g.addedAt);
  return Math.floor((Date.now() - inicio.getTime()) / 86400000);
}

function esEntregada(g) {
  if(!g.items||!g.items.length) return false;
  const t = (g.items[0]._vstLastDescription||'').toLowerCase();
  return t.includes('entregada') || g.lastStatusId === 999;
}

function getDestino(code) {
  return DESTINOS[code.substring(0,3).toUpperCase()] || 'Destino desconocido';
}

module.exports = async (req, res) => {
  const authHeader = req.headers['authorization'];
  if(authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
    res.status(401).json({ error: 'No autorizado' }); return;
  }

  const raw = await redis.get(KEY);
  const guias = raw ? JSON.parse(raw) : [];
  const activas = guias.filter(g => !esEntregada(g) && !g.archived);

  let notificaciones = 0;
  let resumen = [];

  for (const guia of activas) {
    try {
      const filter = `Vst_Trncode = '${guia.code}' AND Vst_Public = 'true'`;
      const url = `https://icargo.misiil.com/api/VwGetTransactionsStatusReport/${encodeURIComponent(filter)}/Vst_RealDate%20desc/0/10000/0`;
      const r = await fetch(url, { headers: { 'Accept': 'application/json' } });
      const data = await r.json();

      if(!data.items||!data.items.length) continue;

      const nuevoEstado = data.items[0]._vstLastDetail;
      const estadoAnterior = guia.lastStatus;
      const dias = diasEnTransito(guia);
      const dest = getDestino(guia.code);
      const textoAlerta = ((data.items[0]._vstDescription||'')+(data.items[0]._vstDetail||'')).toLowerCase();
      const tieneAlerta = ALERTAS.some(a => textoAlerta.includes(a));

      guia.lastStatus = nuevoEstado;
      guia.lastStatusId = data.items[0]._vstTypeStausId;
      guia.lastCheck = new Date().toISOString();
      guia.items = data.items;

      if(true) {
        const emoji = tieneAlerta ? '⚠️' : dias > 8 ? '🔴' : '✅';
        const msg = `${emoji} *El Casillero de USA*\n\n📦 Guía: ${guia.code}\n📍 Destino: ${dest}\n\n🆕 *${nuevoEstado}*\n⏱ ${dias} días en tránsito${tieneAlerta ? '\n\n⚠️ *Posible demora — revisa con iCargo*' : ''}`;
        await sendWhatsApp(msg);
        notificaciones++;
        resumen.push(`${guia.code}: ${estadoAnterior} → ${nuevoEstado}`);
      }
    } catch(e) {
      console.error(`Error procesando ${guia.code}:`, e.message);
    }
  }

  await redis.set(KEY, JSON.stringify(guias));

  res.status(200).json({
    ok: true,
    revisadas: activas.length,
    notificaciones,
    cambios: resumen
  });
};
