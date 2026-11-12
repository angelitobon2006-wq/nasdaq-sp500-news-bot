export type Impact = "ALTO" | "MEDIO" | "BAJO";
export type Direction = "ALCISTA" | "BAJISTA" | "NEUTRAL" | "MIXTO";
export type MarketBias = Direction | "NO_AFECTA";
export type Confidence = "ALTA" | "MEDIA" | "BAJA";
export type MarketId = "NASDAQ" | "SP500";

export interface Scenario {
  que_favorece: string;
  factores: string[];
  confirmacion: string[];
}

/** Análisis de una noticia generado por Claude (ya validado). */
export interface Analysis {
  relevante: boolean;
  impacto: Impact;
  motivo_impacto: string;
  mercados: MarketId[];
  titular_es: string;
  que_ha_ocurrido: string;
  contexto: string;
  repercusion_nasdaq: string;
  repercusion_sp500: string;
  descontado: string;
  escenario_alcista: Scenario | null;
  escenario_bajista: Scenario | null;
  sesgo_nasdaq: MarketBias;
  sesgo_sp500: MarketBias;
  conclusion: Direction;
  confianza: Confidence;
}

/** Noticia normalizada, lista para guardar. */
export interface FeedItem {
  urlHash: string;
  url: string;
  title: string;
  titleKey: string;
  summary: string;
  source: string;
  publishedAt: string; // ISO
  score: number;
}

export type NewsStatus =
  | "skipped"
  | "processing"
  | "analyzed"
  | "published"
  | "archived"
  | "failed";

export interface NewsRow {
  id: string;
  url_hash: string;
  url: string;
  title: string;
  title_key: string;
  summary: string;
  source: string;
  published_at: string | null;
  relevance_score: number;
  status: NewsStatus;
  impact: Impact | null;
  analysis: Analysis | null;
  error: string | null;
  discord_message_id: string | null;
  created_at: string;
}

export interface EconomicEvent {
  id: string;
  title: string;
  category: string | null;
  event_time: string; // ISO
  country: string;
  impact: Impact;
  forecast: string | null;
  previous: string | null;
  actual: string | null;
  alert_sent: boolean;
}

export interface SummaryData {
  hay_noticias: boolean;
  resumen: string;
  noticias_importantes: Array<{ titular: string; impacto: Impact; por_que: string }>;
  factores_alcistas: string[];
  factores_bajistas: string[];
  sesgo_nasdaq: Direction;
  motivo_nasdaq: string;
  sesgo_sp500: Direction;
  motivo_sp500: string;
}

export interface JobRun {
  job: string;
  bucket: string;
  status: string;
  started_at: string;
  finished_at: string | null;
  stats: Record<string, unknown> | null;
  error: string | null;
}

export interface Embed {
  title?: string;
  description?: string;
  url?: string;
  color?: number;
  fields?: Array<{ name: string; value: string; inline?: boolean }>;
  footer?: { text: string };
  timestamp?: string;
}
