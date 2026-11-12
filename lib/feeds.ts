import { parseFeed, type RawItem } from "./rss.js";
import { fetchWithTimeout, errMsg } from "./util.js";

export interface FeedDef {
  id: string;
  name: string;
  url: string;
  /** Bonus de relevancia por fiabilidad (fuentes oficiales = 3). */
  trust: number;
}

const googleNews = (query: string): string =>
  `https://news.google.com/rss/search?q=${encodeURIComponent(query)}&hl=en-US&gl=US&ceid=US:en`;

/**
 * Fuentes gratuitas. Reuters, Bloomberg y FT no ofrecen RSS completo gratuito
 * (Reuters lo retiró): para ellas se usan sus titulares a través de Google News RSS.
 * Cada fuente falla de forma independiente: si una cae, las demás siguen.
 * Puedes desactivar cualquiera con DISABLED_FEEDS=id1,id2
 */
export const FEEDS: FeedDef[] = [
  // Oficiales
  { id: "fed", name: "Reserva Federal", url: "https://www.federalreserve.gov/feeds/press_all.xml", trust: 3 },
  { id: "fed-monetary", name: "Reserva Federal (política monetaria)", url: "https://www.federalreserve.gov/feeds/press_monetary.xml", trust: 3 },
  { id: "bls", name: "BLS", url: "https://www.bls.gov/feed/bls_latest.rss", trust: 3 },
  { id: "bea", name: "BEA", url: "https://apps.bea.gov/rss/rss.xml", trust: 3 },
  // Prensa financiera
  { id: "cnbc-top", name: "CNBC", url: "https://www.cnbc.com/id/100003114/device/rss/rss.html", trust: 1 },
  { id: "cnbc-economy", name: "CNBC Economy", url: "https://www.cnbc.com/id/20910258/device/rss/rss.html", trust: 1 },
  { id: "cnbc-investing", name: "CNBC Investing", url: "https://www.cnbc.com/id/15839069/device/rss/rss.html", trust: 1 },
  { id: "cnbc-earnings", name: "CNBC Earnings", url: "https://www.cnbc.com/id/15839135/device/rss/rss.html", trust: 1 },
  { id: "cnbc-tech", name: "CNBC Technology", url: "https://www.cnbc.com/id/19854910/device/rss/rss.html", trust: 1 },
  { id: "marketwatch", name: "MarketWatch", url: "https://feeds.content.dowjones.io/public/rss/mw_topstories", trust: 1 },
  { id: "wsj", name: "WSJ Markets", url: "https://feeds.a.dj.com/rss/RSSMarketsMain.xml", trust: 2 },
  { id: "bloomberg", name: "Bloomberg", url: "https://feeds.bloomberg.com/markets/news.rss", trust: 2 },
  { id: "ft", name: "Financial Times", url: "https://www.ft.com/markets?format=rss", trust: 2 },
  // Reuters vía Google News (solo titulares)
  {
    id: "reuters",
    name: "Reuters",
    url: googleNews(
      'site:reuters.com (Fed OR Nasdaq OR "S&P 500" OR inflation OR Treasury OR Nvidia OR tariffs OR "Wall Street") when:1d'
    ),
    trust: 2,
  },
];

export interface FeedItemRaw extends RawItem {
  feedId: string;
  feedName: string;
  trust: number;
}

export interface FeedHealth {
  ok: boolean;
  count: number;
  error?: string;
}

export async function fetchAllFeeds(
  f: typeof fetch,
  disabled: string[] = []
): Promise<{ items: FeedItemRaw[]; health: Record<string, FeedHealth> }> {
  const active = FEEDS.filter((feed) => !disabled.includes(feed.id.toLowerCase()));
  const health: Record<string, FeedHealth> = {};

  const results = await Promise.all(
    active.map(async (feed): Promise<FeedItemRaw[]> => {
      try {
        const res = await fetchWithTimeout(
          f,
          feed.url,
          {
            headers: {
              "User-Agent": "NasdaqSP500NewsBot/1.0 (lector RSS)",
              Accept: "application/rss+xml, application/atom+xml, application/xml, text/xml, */*",
            },
          },
          8_000
        );
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const xml = await res.text();
        const parsed = parseFeed(xml);
        health[feed.id] = { ok: true, count: parsed.length };
        return parsed.map((it) => ({
          ...it,
          feedId: feed.id,
          feedName: it.source ?? feed.name,
          trust: feed.trust,
        }));
      } catch (e) {
        health[feed.id] = { ok: false, count: 0, error: errMsg(e).slice(0, 120) };
        return [];
      }
    })
  );

  return { items: results.flat(), health };
}
