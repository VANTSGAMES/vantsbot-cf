-- ============================================================================
-- vantsbot · migración 03 — roles de staff del bot (/vants rol)
-- Quién es staff para el BOT (ve y usa los comandos de administración),
-- independiente de los permisos reales de Discord del rol.
-- Idempotente. Aplicar con scripts/d1_apply_schema.py o:
--   npx wrangler d1 execute vants-db --remote --file=migraciones/03-roles-admin.sql
-- ============================================================================

CREATE TABLE IF NOT EXISTS roles_admin (
  guild_id  TEXT NOT NULL,
  role_id   TEXT NOT NULL,
  creado_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (guild_id, role_id)
);
