-- 04 · VANTS-BUS: cursor del consumidor de eventos (cron del bot, cada minuto)
-- El cursor guarda hasta qué id del bus ya se anunciaron los eventos, para
-- reanudar sin repetir ni perder avisos entre corridas del cron.
CREATE TABLE IF NOT EXISTS bus_estado (
  clave          TEXT PRIMARY KEY,
  valor          TEXT NOT NULL DEFAULT '',
  actualizado_at TEXT NOT NULL DEFAULT (datetime('now'))
);
