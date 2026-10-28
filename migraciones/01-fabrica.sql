-- ============================================
-- Migración 01 · Fábrica de software VANTS (/fabrica)
-- Máquina de estados: entrada → espec → build → revision → aprobacion
--   → (hecha | cancelada)  con bucle rojo Approver → Builder (máx 2 vueltas)
-- Aplicar: npx wrangler d1 execute vants-db --remote --file=migraciones/01-fabrica.sql
-- ============================================

CREATE TABLE IF NOT EXISTS fabrica_corridas (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  guild_id TEXT NOT NULL,
  canal_id TEXT,
  autor_id TEXT NOT NULL,
  idea TEXT NOT NULL,
  etapa TEXT NOT NULL DEFAULT 'entrada',      -- entrada|espec|build|revision|aprobacion
  vueltas INTEGER NOT NULL DEFAULT 0,         -- pasadas por el Builder (bucle rojo)
  sol_ok INTEGER NOT NULL DEFAULT 0,          -- 🛡️ Sol (Seguridad) hecho
  ui_ok INTEGER NOT NULL DEFAULT 0,           -- 🎨 Astra (UI) hecho
  veredicto TEXT,                             -- APROBADO | RECHAZADO (último del Approver)
  decision_humano TEXT,                       -- main_directo | via_pr | cerrada
  estado TEXT NOT NULL DEFAULT 'activa',      -- activa | hecha | cancelada
  creado_en TEXT NOT NULL,
  actualizado_en TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS fabrica_pasos (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  corrida_id INTEGER NOT NULL,
  etapa TEXT NOT NULL,                        -- espec|build|sol|ui|aprobacion
  modo TEXT NOT NULL,                         -- claude | openai | agent-service | plantilla
  modelo TEXT,
  contenido TEXT NOT NULL,
  creado_en TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_fabrica_corridas_estado ON fabrica_corridas (estado, actualizado_en);
CREATE INDEX IF NOT EXISTS idx_fabrica_pasos_corrida ON fabrica_pasos (corrida_id, etapa);
