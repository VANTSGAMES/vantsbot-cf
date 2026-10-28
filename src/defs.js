// ============================================
// vantsbot — definiciones de los 20 comandos (formato REST de Discord)
// Espejo 1:1 del árbol de app_commands de bot/main.py.
// Se registran a nivel SERVIDOR (guild) para que aparezcan al instante
// y para que el PUT reemplace el set completo de comandos viejos.
// ============================================

const OPT_USUARIO = {
  name: 'usuario',
  description: 'Jugador a consultar (opcional, por defecto tú)',
  type: 6, // USER
  required: false,
};

// Permisos que debe tener un miembro para VER cada comando de staff.
// Discord OCULTA el comando a quien no los tenga (desaparece del menú /),
// y los roles de staff añadidos con /vants rol agregan reciben un override
// de la API de permisos para verlos también (ver staff.js).
//   KICK=2 · BAN=4 · CANALES=16 · SERVIDOR=32 · MENSAJES=8192 · TIMEOUT=1<<40
const PERM_KICK = '2';
const PERM_BAN = '4';
const PERM_CANALES = '16';
const PERM_SERVIDOR = '32';
const PERM_MENSAJES = '8192';
const PERM_TIMEOUT = '1099511627776'; // 2^40 MODERATE_MEMBERS

export const COMANDOS = [
  {
    name: 'ayuda',
    description: 'Lista de comandos de VANTS',
  },
  {
    name: 'perfil',
    description: 'Tu perfil competitivo VANTS (o el de otro jugador)',
    options: [OPT_USUARIO],
  },
  {
    name: 'ranking',
    description: 'Top 10 de la temporada ranked',
    options: [
      {
        name: 'pagina',
        description: 'Página del top (10 jugadores por página)',
        type: 4, // INTEGER
        required: false,
        min_value: 1,
        max_value: 50,
      },
    ],
  },
  {
    name: 'torneos',
    description: 'Torneos abiertos y próximos',
  },
  {
    name: 'eventos',
    description: 'Próximos eventos de la comunidad',
  },
  {
    name: 'calendario',
    description: 'Lo que viene en los próximos 7 días',
  },
  {
    name: 'planes',
    description: 'Membresías PRO, CREATOR y SOCIO de VANTS',
  },
  {
    name: 'reglas',
    description: 'Código de conducta de VANTS',
  },
  {
    name: 'soporte',
    description: 'Cómo pedir ayuda al staff',
    options: [
      {
        name: 'pregunta',
        description: 'Pregunta directa para el agente de soporte IA de VANTS (opcional)',
        type: 3, // STRING
        required: false,
        max_length: 2000,
      },
    ],
  },
  {
    name: 'ia',
    description: 'Pregunta a la IA de OpenAI de VANTS (Sol, Astra, Terra, Luna...)',
    options: [
      {
        name: 'pregunta',
        description: 'Tu pregunta para la IA',
        type: 3, // STRING
        required: true,
        max_length: 1000,
      },
      {
        name: 'modelo',
        description: 'Cerebro a usar (opcional, por defecto el rápido)',
        type: 3, // STRING
        required: false,
        choices: [
          { name: 'nano · rápido', value: 'nano' },
          { name: 'mini · equilibrado', value: 'mini' },
          { name: 'sol · GPT-6', value: 'sol' },
          { name: 'astra · GPT-6', value: 'astra' },
          { name: 'terra · GPT-6.1', value: 'terra' },
          { name: 'luna · GPT-5.6', value: 'luna' },
        ],
      },
    ],
  },
  {
    name: 'fabrica',
    description: 'Fábrica de software VANTS: Spec → Builder → Sol/Astra → Approver · pequeño → main, grande → PR',
    default_member_permissions: PERM_SERVIDOR,
    options: [
      {
        name: 'nueva',
        description: 'Arranca una corrida de la fábrica con una idea',
        type: 1, // SUBCOMMAND
        options: [
          {
            name: 'idea',
            description: 'Qué hay que construir o arreglar',
            type: 3, // STRING
            required: true,
            max_length: 1000,
          },
        ],
      },
      {
        name: 'estado',
        description: 'Estado de una corrida (máquina de estados)',
        type: 1,
        options: [
          {
            name: 'id',
            description: 'Número de corrida (ver /fabrica lista)',
            type: 4, // INTEGER
            required: true,
          },
        ],
      },
      {
        name: 'lista',
        description: 'Últimas corridas de la fábrica',
        type: 1,
      },
      {
        name: 'cancelar',
        description: 'Cancela una corrida activa',
        type: 1,
        options: [
          {
            name: 'id',
            description: 'Número de corrida a cancelar',
            type: 4,
            required: true,
          },
        ],
      },
    ],
  },
  {
    name: 'agente',
    description: 'Control del Agente VANTS (web, launcher, BD, CI)',
    default_member_permissions: PERM_SERVIDOR,
    options: [
      { name: 'estado', description: 'Último ciclo del agente + incidentes abiertos', type: 1 },
      { name: 'informe', description: 'Diagnóstico completo del agente', type: 1 },
      { name: 'incidentes', description: 'Lista los incidentes abiertos', type: 1 },
      {
        name: 'resolver',
        description: 'Marca un incidente como resuelto',
        type: 1,
        options: [{ name: 'id_incidente', description: 'Número del incidente (ver /agente incidentes)', type: 4, required: true }],
      },
      {
        name: 'comando',
        description: 'Orden libre al agente (ej: despliega la web)',
        type: 1,
        options: [{ name: 'texto', description: 'Lo que quieres que haga el agente', type: 3, required: true, max_length: 500 }],
      },
    ],
  },
  {
    name: 'vincular',
    description: 'Vincula una cuenta externa a tu perfil VANTS',
    options: [
      {
        name: 'riot',
        description: 'Vincula tu cuenta de Riot (Valorant)',
        type: 1, // SUBCOMMAND
        options: [
          {
            name: 'nombre',
            description: 'Tu Riot ID completo, por ejemplo: Nombre#TAG',
            type: 3, // STRING
            required: true,
          },
        ],
      },
    ],
  },
  {
    name: 'vants',
    description: 'Administración de VANTS (staff)',
    default_member_permissions: PERM_SERVIDOR,
    options: [
      {
        name: 'canal',
        description: 'Elegir el canal de cada tipo de notificación',
        type: 1, // SUBCOMMAND
        options: [
          {
            name: 'categoria',
            description: 'Tipo de notificación',
            type: 3, // STRING
            required: true,
            choices: ['anuncios', 'registros', 'ranked', 'staff', 'logs', 'directos', 'resultados', 'agenda', 'clips'].map((c) => ({
              name: c,
              value: c,
            })),
          },
          {
            name: 'canal',
            description: 'Canal de texto donde llegarán esos avisos (vacío = este)',
            type: 7, // CHANNEL
            required: false,
            channel_types: [0],
          },
        ],
      },
      {
        name: 'estado',
        description: 'Ver canales configurados y entregas recientes',
        type: 1, // SUBCOMMAND
      },
      {
        name: 'rol',
        description: 'Roles de staff del bot (quién puede administrar)',
        type: 2, // SUBCOMMAND_GROUP
        options: [
          {
            name: 'agregar',
            description: 'Dar acceso de staff a un rol (ve y usa los comandos de administración)',
            type: 1,
            options: [
              { name: 'rol', description: 'Rol de staff (ej: Moderador, Admin)', type: 8, required: true },
            ],
          },
          {
            name: 'quitar',
            description: 'Quitarle el acceso de staff a un rol',
            type: 1,
            options: [
              { name: 'rol', description: 'Rol a quitar del staff', type: 8, required: true },
            ],
          },
          {
            name: 'lista',
            description: 'Ver los roles de staff configurados',
            type: 1,
          },
        ],
      },
    ],
  },
  {
    name: 'warn',
    description: 'Advertir a un usuario',
    default_member_permissions: PERM_TIMEOUT,
    options: [
      { name: 'usuario', description: 'Usuario a advertir', type: 6, required: true },
      { name: 'razon', description: 'Razón de la advertencia', type: 3, required: true },
    ],
  },
  {
    name: 'kick',
    description: 'Expulsar a un usuario del servidor',
    default_member_permissions: PERM_KICK,
    options: [
      { name: 'usuario', description: 'Usuario a expulsar', type: 6, required: true },
      { name: 'razon', description: 'Razón', type: 3, required: true },
    ],
  },
  {
    name: 'ban',
    description: 'Banear a un usuario',
    default_member_permissions: PERM_BAN,
    options: [
      { name: 'usuario', description: 'Usuario a banear', type: 6, required: true },
      { name: 'razon', description: 'Razón', type: 3, required: true },
      {
        name: 'borrar_dias',
        description: 'Días de mensajes a borrar (0-7)',
        type: 4,
        required: false,
        min_value: 0,
        max_value: 7,
      },
    ],
  },
  {
    name: 'mute',
    description: 'Silenciar a un usuario (timeout)',
    default_member_permissions: PERM_TIMEOUT,
    options: [
      { name: 'usuario', description: 'Usuario a silenciar', type: 6, required: true },
      {
        name: 'minutos',
        description: 'Minutos de silencio (máx 40320 = 28 días)',
        type: 4,
        required: true,
        min_value: 1,
        max_value: 40320,
      },
      { name: 'razon', description: 'Razón', type: 3, required: true },
    ],
  },
  {
    name: 'unmute',
    description: 'Quitar el silencio a un usuario',
    default_member_permissions: PERM_TIMEOUT,
    options: [
      { name: 'usuario', description: 'Usuario a des-silenciar', type: 6, required: true },
    ],
  },
  {
    name: 'clear',
    description: 'Borrar mensajes del canal (máx 100)',
    default_member_permissions: PERM_MENSAJES,
    options: [
      {
        name: 'cantidad',
        description: 'Número de mensajes a borrar',
        type: 4,
        required: true,
        min_value: 1,
        max_value: 100,
      },
    ],
  },
  {
    name: 'lock',
    description: 'Bloquear el canal actual (nadie escribe)',
    default_member_permissions: PERM_CANALES,
  },
  {
    name: 'unlock',
    description: 'Desbloquear el canal actual',
    default_member_permissions: PERM_CANALES,
  },
  {
    name: 'informe',
    description: 'Informe semanal de VANTS',
    default_member_permissions: PERM_SERVIDOR,
  },
];

export const NOMBRES_COMANDOS = COMANDOS.map((c) => c.name);
