/**
 * Registra los comandos /estado /resumen /analizar /calendario /sesgo
 * SOLO para la aplicación nueva de este proyecto, en tu servidor.
 *
 * Los comandos de Discord pertenecen a cada aplicación: este script usa el
 * token y el ID de la aplicación NUEVA, así que no toca los comandos de tu otro bot.
 *
 * Uso:  npm run register-commands
 */
const token = process.env.DISCORD_BOT_TOKEN;
const appId = process.env.DISCORD_APPLICATION_ID;
const guildId = process.env.DISCORD_GUILD_ID;

if (!token || !appId || !guildId) {
  console.error(
    "Faltan variables en .env: DISCORD_BOT_TOKEN, DISCORD_APPLICATION_ID y DISCORD_GUILD_ID"
  );
  process.exit(1);
}

const commands = [
  {
    name: "estado",
    description: "Estado del bot: ejecuciones, consumo de IA y fuentes",
    dm_permission: false,
  },
  {
    name: "resumen",
    description: "Último resumen horario de Nasdaq 100 y S&P 500",
    dm_permission: false,
    options: [
      {
        type: 5, // booleano
        name: "actualizar",
        description: "Generar uno nuevo ahora (consume IA y tiene espera)",
        required: false,
      },
    ],
  },
  {
    name: "analizar",
    description: "Analiza un titular o texto para Nasdaq 100 y S&P 500",
    dm_permission: false,
    options: [
      {
        type: 3, // texto
        name: "texto",
        description: "Titular o párrafo a analizar (mínimo 30 caracteres)",
        required: true,
        min_length: 30,
        max_length: 1500,
      },
    ],
  },
  {
    name: "calendario",
    description: "Próximos datos económicos de EE. UU. (hora de Madrid)",
    dm_permission: false,
    options: [
      {
        type: 4, // número entero
        name: "dias",
        description: "Días a mostrar (1 a 7, por defecto 3)",
        required: false,
        min_value: 1,
        max_value: 7,
      },
    ],
  },
  {
    name: "sesgo",
    description: "Sesgo fundamental reciente de Nasdaq 100 y S&P 500",
    dm_permission: false,
  },
];

const url = `https://discord.com/api/v10/applications/${appId}/guilds/${guildId}/commands`;
const res = await fetch(url, {
  method: "PUT", // reemplaza SOLO los comandos de esta aplicación en este servidor
  headers: {
    Authorization: `Bot ${token}`,
    "Content-Type": "application/json",
  },
  body: JSON.stringify(commands),
});

if (!res.ok) {
  console.error(`Discord respondió ${res.status}:`, (await res.text()).slice(0, 400));
  process.exit(1);
}

const done = (await res.json()) as Array<{ name: string }>;
console.log("Comandos registrados para la aplicación nueva:");
for (const c of done) console.log(`  /${c.name}`);
console.log("\nNo se ha tocado ningún comando de otras aplicaciones.");

export {};
