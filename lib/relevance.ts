/**
 * Filtro previo SIN coste: decide qué titulares merecen llegar a Claude.
 * Cuanto más alta la puntuación, más probable que mueva al Nasdaq o al S&P 500.
 */
interface Rule {
  re: RegExp;
  weight: number;
  tag: string;
}

const RULES: Rule[] = [
  // Reserva Federal y tipos
  { re: /\b(fomc|federal reserve|the fed\b|fed (chair|governor|officials?|minutes|decision|holds|cuts|hikes|signals)|powell|jerome powell|rate (cut|hike|decision)s?|interest rates?|basis points?|dot plot|jackson hole)\b/i, weight: 3, tag: "Fed/tipos" },
  // Inflación
  { re: /\b(cpi|consumer price index|pce|personal consumption expenditures|ppi|producer price|inflation|core inflation)\b/i, weight: 3, tag: "Inflación" },
  // Empleo
  { re: /\b(nfp|non-?farm|payrolls?|jobs report|unemployment|jobless claims|jolts|job openings|adp (employment|report))\b/i, weight: 3, tag: "Empleo" },
  // Actividad
  { re: /\b(pmi|ism (manufacturing|services|index)|gdp|gross domestic product|retail sales|consumer (confidence|sentiment)|durable goods)\b/i, weight: 2, tag: "Actividad" },
  // Dólar y bonos
  { re: /\b(dxy|dollar index|u\.?s\.? dollar|treasury yields?|10-year yield|2-year yield|treasuries|bond (yields?|market|auction)|yield curve)\b/i, weight: 2, tag: "Dólar/bonos" },
  // Índices
  { re: /\b(nasdaq|s&p ?500|s&p|wall street|dow jones|stock futures|stock market|equities|us stocks|index futures|volatility index|\bvix\b)\b/i, weight: 2, tag: "Índices" },
  // Inteligencia artificial y chips
  { re: /\b(artificial intelligence|generative ai|ai (chips?|boom|bubble|spending|capex|demand|stocks?|data ?centers?)|semiconductors?|chipmakers?|chips? stocks?|gpu|data ?centers?)\b|\bAI\b/, weight: 2, tag: "IA/chips" },
  // Megacaps
  { re: /\b(nvidia|microsoft|apple|amazon|alphabet|google|meta platforms|facebook|broadcom|tesla)\b/i, weight: 2, tag: "Megacaps" },
  // Resultados
  { re: /\b(earnings|quarterly results|guidance|revenue (beats?|misses?|forecast)|profit (warning|forecast)|eps)\b/i, weight: 1, tag: "Resultados" },
  // Geopolítica y materias primas con efecto macro
  { re: /\b(war|ceasefire|sanctions?|tariffs?|trade (war|deal|talks)|export controls?|taiwan|china|middle east|iran|israel|russia|ukraine|opec|oil prices?|crude|strait of hormuz|government shutdown|debt ceiling)\b/i, weight: 2, tag: "Geopolítica" },
];

const EXCLUDE = /\b(sponsored|advertorial|horoscope|coupon|promo code|best (credit cards?|savings accounts?|cd rates?)|mortgage rates today|giveaway|sweepstakes|lottery|recipe|celebrity)\b/i;

export interface Relevance {
  score: number;
  tags: string[];
}

/**
 * @param trust bonus por fuente fiable (oficial = 3). Solo se aplica si ya hay coincidencias,
 *              para que un comunicado oficial sin relación con el mercado no pase el filtro.
 */
export function scoreItem(title: string, summary: string, trust = 0): Relevance {
  if (EXCLUDE.test(title)) return { score: 0, tags: [] };

  let base = 0;
  const tags: string[] = [];
  for (const rule of RULES) {
    const inTitle = rule.re.test(title);
    const inSummary = !inTitle && rule.re.test(summary);
    if (inTitle) {
      base += rule.weight;
      tags.push(rule.tag);
    } else if (inSummary) {
      base += Math.floor(rule.weight / 2);
      if (rule.weight >= 2) tags.push(rule.tag);
    }
  }
  if (base === 0) return { score: 0, tags: [] };
  return { score: Math.min(14, base + trust), tags: [...new Set(tags)] };
}
