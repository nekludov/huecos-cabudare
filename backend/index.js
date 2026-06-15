require('dotenv').config();
const express = require('express');
const cors = require('cors');
const { createClient } = require('@supabase/supabase-js');
const Anthropic = require('@anthropic-ai/sdk');

const app = express();

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

app.use(cors());
app.use(express.json({ limit: '8mb' }));

// ─── GET /reportes ─────────────────────────────────
app.get('/reportes', async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('reportes')
      .select('*')
      .order('created_at', { ascending: false });
    if (error) throw error;
    res.json({ ok: true, reportes: data });
  } catch (err) {
    console.error('GET /reportes:', err.message);
    res.status(500).json({ ok: false, error: 'Error al cargar reportes' });
  }
});

// ─── POST /reportes ────────────────────────────────
app.post('/reportes', async (req, res) => {
  try {
    const { nombre, gravedad, descripcion, lat, lng, fecha, foto, id } = req.body;

    if (!lat || !lng || !['pequeño', 'mediano', 'grande'].includes(gravedad)) {
      return res.status(400).json({ ok: false, error: 'Datos inválidos' });
    }

    // Moderación con Claude Haiku
    const mod = await moderar(descripcion, foto);
    if (!mod.aprobado) {
      return res.json({ ok: false, bloqueado: true, razon: mod.razon });
    }

    // Subir foto a Supabase Storage
    let foto_url = '';
    if (foto && foto.startsWith('data:image')) {
      foto_url = await uploadFoto(foto);
    }

    const { data, error } = await supabase
      .from('reportes')
      .insert({
        id: id || Date.now(),
        nombre: (nombre || 'Anónimo').slice(0, 60),
        gravedad,
        descripcion: (descripcion || '').slice(0, 500),
        lat: parseFloat(lat),
        lng: parseFloat(lng),
        fecha: fecha || new Date().toLocaleString('es-VE', { timeZone: 'America/Caracas' }),
        foto: foto_url,
        estado: 'activo'
      })
      .select()
      .single();

    if (error) throw error;
    res.json({ ok: true, reporte: data, foto: foto_url });
  } catch (err) {
    console.error('POST /reportes:', err.message);
    res.status(500).json({ ok: false, error: 'Error al guardar reporte' });
  }
});

// ─── PATCH /reportes/:id/estado ────────────────────
app.patch('/reportes/:id/estado', async (req, res) => {
  try {
    const { estado, adminKey } = req.body;

    if (!['activo', 'pendiente', 'arreglado'].includes(estado)) {
      return res.status(400).json({ ok: false, error: 'Estado inválido' });
    }

    // Solo admin puede marcar como arreglado o revertir a activo
    const requiereAdmin = ['arreglado', 'activo'].includes(estado);
    if (requiereAdmin && adminKey !== process.env.ADMIN_PASSWORD) {
      return res.status(403).json({ ok: false, error: 'Sin autorización' });
    }

    const { data, error } = await supabase
      .from('reportes')
      .update({ estado })
      .eq('id', req.params.id)
      .select()
      .single();

    if (error) throw error;
    res.json({ ok: true, reporte: data });
  } catch (err) {
    console.error('PATCH /reportes/:id/estado:', err.message);
    res.status(500).json({ ok: false, error: 'Error al actualizar estado' });
  }
});

// ─── POST /reportes/:id/voto ───────────────────────
// Ciudadano confirma que el hueco fue tapado (se necesitan 3 votos para pasar a "pendiente")
app.post('/reportes/:id/voto', async (req, res) => {
  try {
    const { data: actual, error: errGet } = await supabase
      .from('reportes')
      .select('estado, votos_arreglo')
      .eq('id', req.params.id)
      .single();

    if (errGet) throw errGet;
    if (actual.estado !== 'activo') {
      return res.json({ ok: false, error: 'El reporte ya no está activo' });
    }

    const votos = (actual.votos_arreglo || 0) + 1;
    const estado = votos >= 3 ? 'pendiente' : 'activo';

    const { data, error } = await supabase
      .from('reportes')
      .update({ votos_arreglo: votos, estado })
      .eq('id', req.params.id)
      .select()
      .single();

    if (error) throw error;
    res.json({ ok: true, votos, estado });
  } catch (err) {
    console.error('POST /voto:', err.message);
    res.status(500).json({ ok: false });
  }
});

// ─── GET /health ───────────────────────────────────
app.get('/health', (req, res) => res.json({ ok: true, ts: Date.now() }));

// ─── HELPERS ───────────────────────────────────────

async function moderar(texto, foto) {
  try {
    const content = [];

    // Incluir foto si viene con el reporte
    if (foto && foto.startsWith('data:image')) {
      const match = foto.match(/^data:(image\/\w+);base64,(.+)$/);
      if (match) {
        content.push({
          type: 'image',
          source: { type: 'base64', media_type: match[1], data: match[2] }
        });
      }
    }

    content.push({
      type: 'text',
      text: `Eres moderador de HuecosMapa, una app ciudadana venezolana para reportar baches y huecos en calles.

Descripción del reporte: "${(texto || '').slice(0, 300)}"
${foto ? 'Hay una foto adjunta.' : 'Sin foto.'}

RECHAZAR si contiene: groserías o insultos graves, contenido sexual o desnudos, spam o publicidad, amenazas violentas, o contenido totalmente ajeno a vías públicas y baches.
APROBAR si: parece un reporte legítimo de hueco, bache o daño vial. La crítica al gobierno o alcaldía está perfectamente bien. En caso de duda, APROBAR.

Responde ÚNICAMENTE con JSON válido, sin ningún texto adicional antes ni después:
{"aprobado": true, "razon": ""} o {"aprobado": false, "razon": "descripción breve"}`
    });

    const response = await anthropic.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 100,
      messages: [{ role: 'user', content }]
    });

    const text = response.content[0].text;
    const match = text.match(/\{[\s\S]*?\}/);
    if (match) return JSON.parse(match[0]);
    return { aprobado: true, razon: '' };
  } catch (err) {
    console.error('Error moderación:', err.message);
    return { aprobado: true, razon: '' }; // Aprobar en caso de error para no bloquear usuarios
  }
}

async function uploadFoto(base64) {
  try {
    const match = base64.match(/^data:(image\/(\w+));base64,(.+)$/);
    if (!match) return '';

    const [, mimeType, ext, data] = match;
    const filename = `${Date.now()}.${ext === 'jpeg' ? 'jpg' : ext}`;
    const buffer = Buffer.from(data, 'base64');

    const { error } = await supabase.storage
      .from('fotos-huecos')
      .upload(filename, buffer, { contentType: mimeType });

    if (error) throw error;

    return supabase.storage.from('fotos-huecos').getPublicUrl(filename).data.publicUrl;
  } catch (err) {
    console.error('Error subiendo foto:', err.message);
    return ''; // Continuar sin foto si falla el upload
  }
}

if (require.main === module) {
  const PORT = process.env.PORT || 3000;
  app.listen(PORT, () => console.log(`HuecosMapa API corriendo en puerto ${PORT}`));
}

module.exports = app;
