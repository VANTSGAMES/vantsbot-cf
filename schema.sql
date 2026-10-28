-- ============================================================================
-- vantsbot · esquema D1 (SQLite) — base de datos de Cloudflare
-- Espejo de las tablas Postgres/Neon que usa el bot (mismos nombres y
-- columnas clave) para que la web pueda migrar después a la MISMA D1.
-- Idempotente: se puede ejecutar las veces que haga falta.
--   npx wrangler d1 execute vants-db --remote --file=schema.sql
-- ============================================================================

-- Temporadas ranked (activa = status 'active')
CREATE TABLE IF NOT EXISTS seasons (
  id            INTEGER PRIMARY KEY,
  season_number INTEGER,
  nombre        TEXT,
  status        TEXT NOT NULL DEFAULT 'active',
  started_at    TEXT
);
INSERT OR IGNORE INTO seasons (id, season_number, nombre, status)
VALUES (1, 1, 'Temporada 1', 'active');

-- Jugadores (discord_user_id = cuenta de Discord vinculada)
CREATE TABLE IF NOT EXISTS players (
  id              TEXT PRIMARY KEY,          -- id interno (uuid/texto)
  discord_user_id TEXT UNIQUE,
  auth_user_id    TEXT,                      -- usuario web autenticado
  display_name    TEXT,
  country         TEXT,
  avatar_url      TEXT,
  creado_at       TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS players_discord_idx
  ON players (discord_user_id);

-- Cuentas de juego vinculadas (riot, steam...)
CREATE TABLE IF NOT EXISTS user_game_accounts (
  user_id     TEXT NOT NULL,                 -- players.auth_user_id
  game        TEXT NOT NULL,
  handle      TEXT NOT NULL,                 -- ej: Nombre#TAG de Riot
  verified    INTEGER NOT NULL DEFAULT 0,
  verified_at TEXT,
  updated_at  TEXT,
  PRIMARY KEY (user_id, game)
);

-- Participaciones en torneos (conteo de /perfil)
CREATE TABLE IF NOT EXISTS tournament_entries (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  player_id  TEXT NOT NULL,
  torneo_id  TEXT,
  creado_at  TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS tentries_player_idx ON tournament_entries (player_id);

-- Ranking por temporada (Elo/mmr de VANTS RANKED)
CREATE TABLE IF NOT EXISTS leaderboard (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  season_id    INTEGER NOT NULL DEFAULT 1,
  player_id    TEXT NOT NULL,
  display_name TEXT,
  rank         TEXT,
  mmr          INTEGER NOT NULL DEFAULT 0,
  wins         INTEGER NOT NULL DEFAULT 0,
  losses       INTEGER NOT NULL DEFAULT 0,
  UNIQUE (season_id, player_id)
);
CREATE INDEX IF NOT EXISTS lb_season_mmr_idx ON leaderboard (season_id, mmr DESC);

-- Torneos (mismos estados que el bot python)
CREATE TABLE IF NOT EXISTS tournaments (
  id                   TEXT PRIMARY KEY,
  name                 TEXT NOT NULL,
  format               TEXT,
  prize                TEXT,
  status               TEXT NOT NULL DEFAULT 'upcoming',
  starts_at            TEXT,
  current_participants INTEGER NOT NULL DEFAULT 0,
  max_participants     INTEGER
);
CREATE INDEX IF NOT EXISTS torneos_estado_idx ON tournaments (status, starts_at);

-- Eventos de la comunidad
CREATE TABLE IF NOT EXISTS events (
  id          TEXT PRIMARY KEY,
  title       TEXT NOT NULL,
  event_type  TEXT,
  description TEXT,
  starts_at   TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS eventos_cuando_idx ON events (starts_at);

-- Canal de Discord por categoría de notificación (idéntico a migración 02)
CREATE TABLE IF NOT EXISTS discord_channels (
  category   TEXT PRIMARY KEY,
  channel_id TEXT NOT NULL
);

-- Cola de alertas (UNIQUE evita duplicados; espejo de migración 02)
CREATE TABLE IF NOT EXISTS bot_alerts (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  kind       TEXT NOT NULL,
  ref_id     TEXT NOT NULL,
  category   TEXT,
  payload    TEXT NOT NULL DEFAULT '{}',
  status     TEXT NOT NULL DEFAULT 'pending',
  attempts   INTEGER NOT NULL DEFAULT 0,
  sent_at    TEXT,
  channel_id TEXT,
  message_id TEXT,
  error      TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (kind, ref_id)
);

-- Historial de moderación (alimenta /informe)
CREATE TABLE IF NOT EXISTS mod_logs (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  guild_id    TEXT NOT NULL,
  moderador_id TEXT NOT NULL,
  objetivo_id TEXT,
  accion      TEXT NOT NULL,                 -- warn|kick|ban|mute|unmute|clear|lock|unlock
  razon       TEXT,
  canal_id    TEXT,
  creado_at   TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS mod_logs_cuando_idx ON mod_logs (creado_at DESC);

-- Interruptores del bot (panel admin)
CREATE TABLE IF NOT EXISTS bot_settings (
  key     TEXT PRIMARY KEY,
  enabled INTEGER NOT NULL DEFAULT 1
);
INSERT OR IGNORE INTO bot_settings (key, enabled) VALUES ('supervisor', 1);

-- Eventos de la app de Discord (compras/instalaciones; espejo migración 01)
CREATE TABLE IF NOT EXISTS web_events (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  event_id    TEXT UNIQUE NOT NULL,
  kind        TEXT NOT NULL,
  severity    TEXT NOT NULL DEFAULT 'info',
  page        TEXT,
  payload     TEXT NOT NULL DEFAULT '{}',
  processed   INTEGER NOT NULL DEFAULT 0,
  created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);

-- ============================================
-- Fábrica de software VANTS (/fabrica) — espejo migraciones/01-fabrica.sql
-- Máquina de estados: entrada → espec → build → revision → aprobacion
--   → (hecha | cancelada)  con bucle rojo Approver → Builder (máx 2 vueltas)
-- ============================================
CREATE TABLE IF NOT EXISTS fabrica_corridas (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  guild_id TEXT NOT NULL,
  canal_id TEXT,
  autor_id TEXT NOT NULL,
  idea TEXT NOT NULL,
  etapa TEXT NOT NULL DEFAULT 'entrada',
  vueltas INTEGER NOT NULL DEFAULT 0,
  sol_ok INTEGER NOT NULL DEFAULT 0,
  ui_ok INTEGER NOT NULL DEFAULT 0,
  veredicto TEXT,
  tamano TEXT,                                -- PEQUENO | GRANDE (regla del dueño, migración 02)
  decision_humano TEXT,
  estado TEXT NOT NULL DEFAULT 'activa',
  creado_en TEXT NOT NULL,
  actualizado_en TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS fabrica_pasos (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  corrida_id INTEGER NOT NULL,
  etapa TEXT NOT NULL,
  modo TEXT NOT NULL,
  modelo TEXT,
  contenido TEXT NOT NULL,
  creado_en TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_fabrica_corridas_estado ON fabrica_corridas (estado, actualizado_en);
CREATE INDEX IF NOT EXISTS idx_fabrica_pasos_corrida ON fabrica_pasos (corrida_id, etapa);

-- ============================================
-- Roles de staff del bot (/vants rol agregar|quitar|lista) — espejo
-- migraciones/03-roles-admin.sql. Los roles aquí listados ven y usan los
-- comandos de administración (override de la API de permisos de Discord)
-- aunque no tengan permisos reales en el servidor.
-- ============================================
CREATE TABLE IF NOT EXISTS roles_admin (
  guild_id  TEXT NOT NULL,
  role_id   TEXT NOT NULL,
  creado_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (guild_id, role_id)
);

-- ============================================
-- VANTS-BUS: cursor del consumidor de eventos (espejo migraciones/04-bus-estado.sql)
-- El cron del bot consume el bus de eventos del ecosistema cada minuto y aquí
-- guarda hasta qué id ya anunció, para reanudar sin repetir ni perder avisos.
-- ============================================
CREATE TABLE IF NOT EXISTS bus_estado (
  clave          TEXT PRIMARY KEY,
  valor          TEXT NOT NULL DEFAULT '',
  actualizado_at TEXT NOT NULL DEFAULT (datetime('now'))
);
