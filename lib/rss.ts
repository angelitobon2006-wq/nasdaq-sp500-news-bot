import { decodeEntities, stripHtml } from "./util.js";

export interface RawItem {
  title: string;
  link: string;
  summary: string;
  publishedAt: Date | null;
  source?: string;
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function tagText(block: string, name: string): string {
  const re = new RegExp(`<${escapeRe(name)}(?:\\s[^>]*)?>([\\s\\S]*?)</${escapeRe(name)}>`, "i");
  const m = block.match(re);
  return m ? m[1] : "";
}

function atomLink(block: string): string {
  const links = [...block.matchAll(/<link\b([^>]*)>/gi)].map((m) => m[1]);
  const alt =
    links.find((a) => /rel=["']alternate["']/i.test(a)) ??
    links.find((a) => !/rel=/i.test(a)) ??
    links[0];
  const href = alt?.match(/href=["']([^"']+)["']/i);
  return href ? decodeEntities(href[1]) : "";
}

function parseDate(value: string): Date | null {
  if (!value) return null;
  const d = new Date(stripHtml(value));
  return Number.isNaN(d.getTime()) ? null : d;
}

/** Lector sencillo de RSS 2.0 y Atom (sin dependencias). */
export function parseFeed(xml: string): RawItem[] {
  const isAtom = /<entry[\s>]/i.test(xml) && !/<item[\s>]/i.test(xml);
  const blocks = isAtom
    ? (xml.match(/<entry[\s>][\s\S]*?<\/entry>/gi) ?? [])
    : (xml.match(/<item[\s>][\s\S]*?<\/item>/gi) ?? []);

  const items: RawItem[] = [];
  for (const block of blocks) {
    const title = stripHtml(tagText(block, "title"));
    if (!title) continue;

    let link = isAtom ? atomLink(block) : stripHtml(tagText(block, "link"));
    if (!link) {
      const guid = stripHtml(tagText(block, "guid"));
      if (/^https?:\/\//i.test(guid)) link = guid;
    }
    if (!/^https?:\/\//i.test(link)) continue;

    const summary = stripHtml(
      tagText(block, isAtom ? "summary" : "description") ||
        tagText(block, "content:encoded") ||
        tagText(block, "content")
    );

    const published =
      parseDate(tagText(block, "pubDate")) ??
      parseDate(tagText(block, "dc:date")) ??
      parseDate(tagText(block, "published")) ??
      parseDate(tagText(block, "updated"));

    const sourceTag = stripHtml(tagText(block, "source"));

    items.push({
      title,
      link,
      summary,
      publishedAt: published,
      source: sourceTag || undefined,
    });
  }
  return items;
}
