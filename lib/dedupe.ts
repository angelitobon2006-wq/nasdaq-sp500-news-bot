const STOPWORDS = new Set(
  "the a an and or of to in on for at by with as is are was were be been it its this that from after before over amid says say said new us u.s its has have had will may could would than into about up down more less".split(
    " "
  )
);

/** Quita el sufijo " - Reuters" que añade Google News. */
function stripSuffix(title: string): string {
  const i = title.lastIndexOf(" - ");
  if (i > 20 && title.length - i < 40) return title.slice(0, i);
  return title;
}

export function titleTokens(title: string): string[] {
  const clean = stripSuffix(title)
    .toLowerCase()
    .replace(/[^a-z0-9%$. ]+/g, " ");
  const tokens = clean
    .split(/\s+/)
    .map((t) => t.replace(/^\.+|\.+$/g, ""))
    .filter((t) => t.length >= 3 && !STOPWORDS.has(t));
  return [...new Set(tokens)].sort();
}

/** Clave guardada en la base de datos para comparar titulares parecidos. */
export function titleKey(title: string): string {
  return titleTokens(title).join(" ");
}

export function jaccard(a: string[], b: string[]): number {
  if (a.length === 0 || b.length === 0) return 0;
  const setB = new Set(b);
  let inter = 0;
  for (const t of a) if (setB.has(t)) inter++;
  return inter / (a.length + b.length - inter);
}

/** ¿Es (casi) el mismo titular que alguno de los ya vistos? */
export function isNearDuplicate(
  tokens: string[],
  seen: string[][],
  threshold = 0.7
): boolean {
  if (tokens.length < 4) return false;
  return seen.some((s) => jaccard(tokens, s) >= threshold);
}
