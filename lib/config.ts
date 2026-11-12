type Env = Record<string, string | undefined>;

export function env(name: string, source: Env = process.env): string | undefined {
  const v = source[name];
  if (v === undefined) return undefined;
  const t = v.trim();
  return t === "" ? undefined : t;
}

export function requireEnv(name: string, source: Env = process.env): string {
  const v = env(name, source);
  if (!v) throw new Error(`Falta la variable de entorno ${name}`);
  return v;
}

function num(name: string, def: number, source: Env): number {
  const v = env(name, source);
  if (v === undefined) return def;
  const n = Number(v);
  return Number.isFinite(n) && n >= 0 ? n : def;
}

function bool(name: string, def: boolean, source: Env): boolean {
  const v = env(name, source);
  if (v === undefined) return def;
  return ["1", "true", "si", "sí", "yes"].includes(v.toLowerCase());
}

function hoursRange(name: string, def: [number, number], source: Env): [number, number] {
  const v = env(name, source);
  const m = v?.match(/^(\d{1,2})\s*-\s*(\d{1,2})$/);
  if (!m) return def;
  const a = Math.min(23, parseInt(m[1], 10));
  const b = Math.min(23, parseInt(m[2], 10));
  return [a, b];
}

export interface Settings {
  provider: "groq" | "anthropic";
  model: string;
  maxAnalysesPerDay: number;
  maxAnalysesPerRun: number;
  dailyTokenBudget: number;
  manualAnalysesPerDay: number;
  manualCooldownSeconds: number;
  summaryCooldownSeconds: number;
  minRelevance: number;
  maxItemAgeHours: number;
  maxInputChars: number;
  postLowImpact: boolean;
  summaryPostWhenEmpty: boolean;
  summaryStartHour: number;
  summaryEndHour: number;
  alertMinutesBefore: number;
  disabledFeeds: string[];
  guildId: string | undefined;
}

export function loadSettings(source: Env = process.env): Settings {
  const [startHour, endHour] = hoursRange("SUMMARY_ACTIVE_HOURS", [0, 23], source);
  return {
    provider: env("LLM_PROVIDER", source)?.toLowerCase() === "anthropic" ? "anthropic" : "groq",
    model:
      env("LLM_MODEL", source) ??
      (env("LLM_PROVIDER", source)?.toLowerCase() === "anthropic"
        ? env("ANTHROPIC_MODEL", source) ?? "claude-haiku-5-5"
        : "openai/gpt-oss-120b"),
    maxAnalysesPerDay: num("MAX_ANALYSES_PER_DAY", 40, source),
    maxAnalysesPerRun: num("MAX_ANALYSES_PER_RUN", 3, source),
    dailyTokenBudget: num("DAILY_TOKEN_BUDGET", 150_000, source),
    manualAnalysesPerDay: num("MANUAL_ANALYSES_PER_DAY", 15, source),
    manualCooldownSeconds: num("MANUAL_COOLDOWN_SECONDS", 120, source),
    summaryCooldownSeconds: num("SUMMARY_COOLDOWN_SECONDS", 600, source),
    minRelevance: num("MIN_RELEVANCE", 3, source),
    maxItemAgeHours: num("MAX_ITEM_AGE_HOURS", 6, source),
    maxInputChars: num("MAX_INPUT_CHARS", 1500, source),
    postLowImpact: bool("POST_LOW_IMPACT", true, source),
    summaryPostWhenEmpty: bool("SUMMARY_POST_WHEN_EMPTY", true, source),
    summaryStartHour: startHour,
    summaryEndHour: endHour,
    alertMinutesBefore: num("ALERT_MINUTES_BEFORE", 30, source),
    disabledFeeds: (env("DISABLED_FEEDS", source) ?? "")
      .split(",")
      .map((s) => s.trim().toLowerCase())
      .filter(Boolean),
    guildId: env("DISCORD_GUILD_ID", source),
  };
}
