// src/aiBridge.js
import { ROJO, PERM, esStaff, txt, embedBase, campo } from "./util.js";

async function llamarVantsAi(env, ruta, body, { discordId, staff = false }) {
  const binding = env.VANTS_INT_SERVICE;
  const secret = String(env.VANTS_INTERNAL_SECRET || "").trim();
  if (!binding || !secret) {
    return { ok: false, status: 503, data: { error: "vants_ai_no_enlazado" } };
  }

  const req = new Request(`https://int.vants.cc${ruta}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Vants-Internal": secret,
      "X-Vants-Discord-Id": String(discordId || ""),
      "X-Vants-Staff": staff ? "1" : "0",
    },
    body: JSON.stringify(body || {}),
  });

  const res = await binding.fetch(req);
  const data = await res.json().catch(() => null);
  return { ok: res.ok, status: res.status, data };
}

export async function comandoScout(env, body) {
  const discordId = String(body?.member?.user?.id ?? body?.user?.id ?? "");
  const nick = String((body?.data?.options ?? []).find((o) => o.name === "nick")?.value ?? "").trim();
  const staff = await esStaff(env, body, PERM.MANAGE_GUILD);

  const r = await llamarVantsAi(env, "/ai/scout/jugador", nick ? { nick } : {}, { discordId, staff });
  if (!r.ok || !r.data?.reporte) {
    const err = r.data?.error || `HTTP ${r.status}`;
    if (err === "jugador_no_encontrado") {
      return { flags: 64, content: "❌ No encontré ese perfil en VANTS. Vincula tu cuenta en https://vants.cc/perfil/cuentas o indica `nick:`." };
    }
    if (err === "limite_diario_ai") {
      return { flags: 64, content: "⏳ Alcanzaste tu límite diario de análisis IA. Mejora a **VANTS PRO** en https://vants.cc/membresias para ampliar tu cuota." };
    }
    return { flags: 64, content: `❌ Error en VANTS Scout AI: \`${txt(err, 100)}\`` };
  }

  const rep = r.data.reporte;
  const e = embedBase(`🎯 Scouting IA · ${txt(r.data.jugador?.nick, 40)}`, `**Recomendación:** ${txt(rep.recomendacion_fichaje, 300)}`);
  campo(e, "📊 Score", `**${rep.performance_score}/100**`, true);
  campo(e, "🏅 Tier", txt(rep.tier_sugerido, 40), true);
  if (rep.rol_ideal) campo(e, "🎮 Rol ideal", txt(rep.rol_ideal, 40), true);
  if (Array.isArray(rep.fortalezas) && rep.fortalezas.length) {
    campo(e, "✅ Fortalezas", rep.fortalezas.map((x) => `• ${txt(x, 120)}`).join("\n").slice(0, 900));
  }
  if (Array.isArray(rep.areas_mejora) && rep.areas_mejora.length) {
    campo(e, "🔧 A mejorar", rep.areas_mejora.map((x) => `• ${txt(x, 120)}`).join("\n").slice(0, 900));
  }
  e.footer = { text: `VANTS Core AI · Restantes hoy: ${r.data.cuota?.restantes ?? "—"}` };
  return { embeds: [e] };
}

export async function comandoIaCore(env, body, pregunta) {
  const discordId = String(body?.member?.user?.id ?? body?.user?.id ?? "");
  const staff = await esStaff(env, body, PERM.MANAGE_GUILD);

  const r = await llamarVantsAi(env, "/ai/dispatch", {
    prompt: pregunta,
    user_role: staff ? "owner" : "player",
  }, { discordId, staff });

  if (!r.ok || !r.data?.response) return null;

  const e = {
    title: `🤖 VANTS Core AI · ${txt(r.data.routing?.target_agent, 20)}`,
    description: txt(r.data.response, 1900),
    color: ROJO,
    footer: { text: r.data.requiere_aprobacion ? `Pendiente de aprobación (#${r.data.task_id.slice(0, 8)})` : "VANTS Core AI · vants.cc" },
  };
  return { flags: 64, embeds: [e] };
}

export async function botonAi(env, body) {
  if (!await esStaff(env, body, PERM.MANAGE_GUILD)) {
    return { tipo: 4, data: { flags: 64, content: "🚫 Solo el staff de VANTS puede aprobar o rechazar borradores de IA." } };
  }

  const [, accion, taskId] = String(body?.data?.custom_id || "").split(":");
  if (!["approve", "reject"].includes(accion) || !/^[0-9a-f-]{36}$/i.test(taskId || "")) {
    return { tipo: 4, data: { flags: 64, content: "❌ Botón de IA inválido." } };
  }

  const discordId = String(body?.member?.user?.id ?? body?.user?.id ?? "");
  return {
    tipo: 6,
    etiqueta: accion === "approve" ? "⏳ Aprobando y ejecutando acción…" : "⏳ Rechazando borrador…",
    trabajo: async () => {
      const r = await llamarVantsAi(env, `/ai/tasks/${taskId}/${accion}`, {}, { discordId, staff: true });
      if (!r.ok) {
        return { flags: 64, content: `❌ No se pudo actualizar la tarea: \`${txt(r.data?.error || r.status, 120)}\`` };
      }
      const ok = accion === "approve";
      return {
        embeds: [{
          title: ok ? "✅ Borrador IA Aprobado" : "🗑️ Borrador IA Rechazado",
          description: ok
            ? `Tarea \`${taskId.slice(0, 8)}\` aprobada por <@${discordId}>.${r.data?.ejecucion?.ejecutado ? " Publicado automáticamente en Discord." : ""}`
            : `Tarea \`${taskId.slice(0, 8)}\` descartada por <@${discordId}>.`,
          color: ok ? 5763719 : 10070709,
        }],
      };
    },
  };
}
