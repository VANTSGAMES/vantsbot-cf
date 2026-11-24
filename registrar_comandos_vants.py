#!/usr/bin/env python3
# ============================================================================
# registrar_comandos_vants.py — registro de los 23 comandos del bot VANTS
# (App ID 1564805627979632730) a nivel SERVIDOR vía API v10, sin dependencias.
#
# Úsalo como alternativa al endpoint POST /setup del Worker (mismo resultado).
# Los comandos guild-scoped aparecen AL INSTANTE y el PUT reemplaza el set
# completo (borra los 13 comandos viejos del bot anterior).
#
# Configuración: crea un archivo .env junto a este script con:
#   DISCORD_TOKEN=MTU2NDgw...   (token del bot NUEVO)
#   DISCORD_GUILD_ID=1546641331927908472
#
# Uso:
#   python registrar_comandos_vants.py listar
#   python registrar_comandos_vants.py registrar
#   python registrar_comandos_vants.py borrar
# ============================================================================
import base64
import json
import os
import sys
import urllib.error
import urllib.request

API = "https://discord.com/api/v10"
GUILD_DEFECTO = "1546641331927908472"

COMANDOS = [
    {"name": "ayuda", "description": "Lista de comandos de VANTS"},
    {"name": "perfil", "description": "Tu perfil competitivo VANTS (o el de otro jugador)",
     "options": [{"name": "usuario", "description": "Jugador a consultar (opcional, por defecto tú)", "type": 6, "required": False}]},
    {"name": "ranking", "description": "Top 10 de la temporada ranked",
     "options": [{"name": "pagina", "description": "Página del top (10 jugadores por página)", "type": 4, "required": False, "min_value": 1, "max_value": 50}]},
    {"name": "torneos", "description": "Torneos abiertos y próximos"},
    {"name": "eventos", "description": "Próximos eventos de la comunidad"},
    {"name": "calendario", "description": "Lo que viene en los próximos 7 días"},
    {"name": "planes", "description": "Membresías PRO, CREATOR y SOCIO de VANTS"},
    {"name": "reglas", "description": "Código de conducta de VANTS"},
    {"name": "soporte", "description": "Cómo pedir ayuda al staff",
     "options": [{"name": "pregunta", "description": "Pregunta directa para el agente de soporte IA de VANTS (opcional)", "type": 3, "required": False, "max_length": 2000}]},
    {"name": "ia", "description": "Pregunta a la IA de OpenAI de VANTS (Sol, Astra, Terra, Luna...)",
     "options": [{"name": "pregunta", "description": "Tu pregunta para la IA", "type": 3, "required": True, "max_length": 1000},
                 {"name": "modelo", "description": "Cerebro a usar (opcional, por defecto el rápido)", "type": 3, "required": False,
                  "choices": [{"name": "nano · rápido", "value": "nano"},
                              {"name": "mini · equilibrado", "value": "mini"},
                              {"name": "sol · GPT-6", "value": "sol"},
                              {"name": "astra · GPT-6", "value": "astra"},
                              {"name": "terra · GPT-6.1", "value": "terra"},
                              {"name": "luna · GPT-5.6", "value": "luna"}]}]},
    {"name": "fabrica", "description": "Fábrica de software VANTS: Spec → Builder → Sol/Astra → Approver",
     "default_member_permissions": "32",
     "options": [
         {"name": "nueva", "description": "Arranca una corrida de la fábrica con una idea", "type": 1,
          "options": [{"name": "idea", "description": "Qué hay que construir o arreglar", "type": 3, "required": True, "max_length": 1000}]},
         {"name": "estado", "description": "Estado de una corrida (máquina de estados)", "type": 1,
          "options": [{"name": "id", "description": "Número de corrida (ver /fabrica lista)", "type": 4, "required": True}]},
         {"name": "lista", "description": "Últimas corridas de la fábrica", "type": 1},
         {"name": "cancelar", "description": "Cancela una corrida activa", "type": 1,
          "options": [{"name": "id", "description": "Número de corrida a cancelar", "type": 4, "required": True}]}]},
    {"name": "agente", "description": "Control del Agente VANTS (web, launcher, BD, CI)",
     "default_member_permissions": "32",
     "options": [
         {"name": "estado", "description": "Último ciclo del agente + incidentes abiertos", "type": 1},
         {"name": "informe", "description": "Diagnóstico completo del agente", "type": 1},
         {"name": "incidentes", "description": "Lista los incidentes abiertos", "type": 1},
         {"name": "resolver", "description": "Marca un incidente como resuelto", "type": 1,
          "options": [{"name": "id_incidente", "description": "Número del incidente (ver /agente incidentes)", "type": 4, "required": True}]},
         {"name": "comando", "description": "Orden libre al agente (ej: despliega la web)", "type": 1,
          "options": [{"name": "texto", "description": "Lo que quieres que haga el agente", "type": 3, "required": True, "max_length": 500}]}]},
    {"name": "vincular", "description": "Vincula una cuenta externa a tu perfil VANTS",
     "options": [{"name": "riot", "description": "Vincula tu cuenta de Riot (Valorant)", "type": 1,
                  "options": [{"name": "nombre", "description": "Tu Riot ID completo, por ejemplo: Nombre#TAG", "type": 3, "required": True}]}]},
    {"name": "vants", "description": "Administración de VANTS (staff)",
     "default_member_permissions": "32",
     "options": [
         {"name": "canal", "description": "Elegir el canal de cada tipo de notificación", "type": 1,
          "options": [
              {"name": "categoria", "description": "Tipo de notificación", "type": 3, "required": True,
               "choices": [{"name": c, "value": c} for c in ["anuncios", "registros", "ranked", "staff", "logs", "directos"]]},
              {"name": "canal", "description": "Canal de texto donde llegarán esos avisos (vacío = este)", "type": 7, "required": False, "channel_types": [0]}]},
         {"name": "estado", "description": "Ver canales configurados y entregas recientes", "type": 1},
         {"name": "rol", "description": "Roles de staff del bot (quién puede administrar)", "type": 2,
          "options": [
              {"name": "agregar", "description": "Dar acceso de staff a un rol (ve y usa los comandos de administración)", "type": 1,
               "options": [{"name": "rol", "description": "Rol de staff (ej: Moderador, Admin)", "type": 8, "required": True}]},
              {"name": "quitar", "description": "Quitarle el acceso de staff a un rol", "type": 1,
               "options": [{"name": "rol", "description": "Rol a quitar del staff", "type": 8, "required": True}]},
              {"name": "lista", "description": "Ver los roles de staff configurados", "type": 1}]}]},
    {"name": "warn", "description": "Advertir a un usuario", "default_member_permissions": "1099511627776",
     "options": [{"name": "usuario", "description": "Usuario a advertir", "type": 6, "required": True},
                 {"name": "razon", "description": "Razón de la advertencia", "type": 3, "required": True}]},
    {"name": "kick", "description": "Expulsar a un usuario del servidor", "default_member_permissions": "2",
     "options": [{"name": "usuario", "description": "Usuario a expulsar", "type": 6, "required": True},
                 {"name": "razon", "description": "Razón", "type": 3, "required": True}]},
    {"name": "ban", "description": "Banear a un usuario", "default_member_permissions": "4",
     "options": [{"name": "usuario", "description": "Usuario a banear", "type": 6, "required": True},
                 {"name": "razon", "description": "Razón", "type": 3, "required": True},
                 {"name": "borrar_dias", "description": "Días de mensajes a borrar (0-7)", "type": 4, "required": False, "min_value": 0, "max_value": 7}]},
    {"name": "mute", "description": "Silenciar a un usuario (timeout)", "default_member_permissions": "1099511627776",
     "options": [{"name": "usuario", "description": "Usuario a silenciar", "type": 6, "required": True},
                 {"name": "minutos", "description": "Minutos de silencio (máx 40320 = 28 días)", "type": 4, "required": True, "min_value": 1, "max_value": 40320},
                 {"name": "razon", "description": "Razón", "type": 3, "required": True}]},
    {"name": "unmute", "description": "Quitar el silencio a un usuario", "default_member_permissions": "1099511627776",
     "options": [{"name": "usuario", "description": "Usuario a des-silenciar", "type": 6, "required": True}]},
    {"name": "clear", "description": "Borrar mensajes del canal (máx 100)", "default_member_permissions": "8192",
     "options": [{"name": "cantidad", "description": "Número de mensajes a borrar", "type": 4, "required": True, "min_value": 1, "max_value": 100}]},
    {"name": "lock", "description": "Bloquear el canal actual (nadie escribe)", "default_member_permissions": "16"},
    {"name": "unlock", "description": "Desbloquear el canal actual", "default_member_permissions": "16"},
    {"name": "informe", "description": "Informe semanal de VANTS", "default_member_permissions": "32"},
]


def cargar_env():
    env = dict(os.environ)
    ruta = os.path.join(os.path.dirname(os.path.abspath(__file__)), ".env")
    if os.path.exists(ruta):
        with open(ruta, "r", encoding="utf-8") as fh:
            for linea in fh:
                linea = linea.strip()
                if linea and not linea.startswith("#") and "=" in linea:
                    k, _, v = linea.partition("=")
                    env.setdefault(k.strip(), v.strip().strip('"').strip("'"))
    return env


def app_id_de_token(token: str):
    try:
        seg = token.split(".")[0]
        pad = "=" * (-len(seg) % 4)
        app_id = base64.urlsafe_b64decode(seg + pad).decode("utf-8")
        return app_id if app_id.isdigit() else None
    except Exception:
        return None


def peticion(metodo: str, url: str, token: str, payload=None):
    datos = json.dumps(payload).encode("utf-8") if payload is not None else None
    req = urllib.request.Request(url, data=datos, method=metodo, headers={
        "Authorization": f"Bot {token}",
        "Content-Type": "application/json",
        "User-Agent": "VANTS-Bot (https://vants.cc, 1.0)",
    })
    try:
        with urllib.request.urlopen(req, timeout=20) as resp:
            cuerpo = resp.read().decode("utf-8", "replace")
            return resp.status, (json.loads(cuerpo) if cuerpo else None)
    except urllib.error.HTTPError as e:
        cuerpo = e.read().decode("utf-8", "replace")
        try:
            return e.code, json.loads(cuerpo)
        except Exception:
            return e.code, cuerpo


def main():
    accion = sys.argv[1] if len(sys.argv) > 1 else "listar"
    env = cargar_env()
    token = env.get("DISCORD_TOKEN") or env.get("DISCORD_BOT_TOKEN") or ""
    if not token:
        print("Falta DISCORD_TOKEN (defínelo en .env junto a este script)")
        sys.exit(1)
    app_id = app_id_de_token(token) or env.get("DISCORD_APP_ID") or ""
    guild_id = env.get("DISCORD_GUILD_ID") or GUILD_DEFECTO
    base_guild = f"{API}/applications/{app_id}/guilds/{guild_id}/commands"

    if accion == "listar":
        status, data = peticion("GET", base_guild, token)
        print(f"HTTP {status} · comandos en el servidor {guild_id}:")
        for c in data or []:
            print(f"  /{c['name']} (id {c['id']})")
        if not (data or []):
            print("  (ninguno)")

    elif accion == "registrar":
        status, data = peticion("PUT", base_guild, token, COMANDOS)
        if status in (200, 201):
            print(f"✅ HTTP {status} · {len(data)} comandos registrados en el servidor {guild_id}:")
            for c in data:
                print(f"  /{c['name']}")
        else:
            print(f"❌ HTTP {status}: {data}")
            sys.exit(2)

    elif accion == "borrar":
        status, data = peticion("PUT", base_guild, token, [])
        print(f"HTTP {status} · comandos de servidor borrados (set vacío)")

    else:
        print("Acciones: listar | registrar | borrar")
        sys.exit(1)


if __name__ == "__main__":
    main()
