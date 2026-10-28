-- ============================================
-- Migración 02 · Tamaño de la corrida (regla del dueño)
--   PEQUENO → ⚡ merge directo a main automático ("directamente se sube")
--   GRANDE  → 🔀 Pull Request y lo aprueba el dueño ("apruebo yo")
-- El Approver clasifica el tamaño al dar su veredicto; sin clasificación
-- la corrida escala al humano (puerta completa), nunca se auto-aprueba.
--
-- Aplicar: npx wrangler d1 execute vants-db --remote --file=migraciones/02-tamano.sql
-- ============================================

ALTER TABLE fabrica_corridas ADD COLUMN tamano TEXT;
