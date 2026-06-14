-- ─── SETUP SUPABASE ────────────────────────────────────────────────────────
-- Ejecuta este script en: Supabase Dashboard → SQL Editor → New query

-- Tabla principal de reportes
CREATE TABLE IF NOT EXISTS reportes (
  id          BIGINT PRIMARY KEY,           -- Date.now() del cliente
  nombre      TEXT    NOT NULL DEFAULT 'Anónimo',
  gravedad    TEXT    NOT NULL CHECK (gravedad IN ('pequeño', 'mediano', 'grande')),
  descripcion TEXT    NOT NULL DEFAULT '',
  lat         DOUBLE PRECISION NOT NULL,
  lng         DOUBLE PRECISION NOT NULL,
  fecha       TEXT    NOT NULL,
  foto        TEXT    NOT NULL DEFAULT '',  -- URL pública en Supabase Storage
  estado      TEXT    NOT NULL DEFAULT 'activo'
                CHECK (estado IN ('activo', 'pendiente', 'arreglado')),
  created_at  TIMESTAMPTZ DEFAULT NOW()
);

-- Índice para la vista de lista (ordenada por reciente)
CREATE INDEX IF NOT EXISTS idx_reportes_created_at ON reportes(created_at DESC);

-- Row Level Security
ALTER TABLE reportes ENABLE ROW LEVEL SECURITY;

-- Cualquiera puede leer (el mapa es público)
CREATE POLICY "Lectura pública" ON reportes
  FOR SELECT USING (true);

-- Escritura y actualización solo via service key del backend
-- (el service key bypassa RLS, así que estas policies son para la anon key si algún día se usa)
CREATE POLICY "Escritura via service key" ON reportes
  FOR INSERT WITH CHECK (true);

CREATE POLICY "Actualización via service key" ON reportes
  FOR UPDATE USING (true);


-- ─── BUCKET DE FOTOS ────────────────────────────────────────────────────────
-- Esto NO se puede crear con SQL — hazlo manualmente:
--
-- 1. Ve a Storage en el dashboard de Supabase
-- 2. Crea un bucket llamado exactamente: fotos-huecos
-- 3. Marca la opción "Public bucket" (para que las fotos sean accesibles sin auth)
-- 4. En "Allowed MIME types" puedes poner: image/jpeg, image/png, image/webp
-- 5. En "Max upload size" pon 5 MB (las fotos ya se comprimen en el frontend)
