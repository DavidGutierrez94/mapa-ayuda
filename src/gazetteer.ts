import data from "../data/municipios.json";

export interface Muni {
  code: string;
  name: string;
  dept: string;
  lat: number;
  lon: number;
}

const MUNIS: Muni[] = data.municipios;

/** Full list for the frontend municipality picker. */
export const allMunis = (): Pick<Muni, "code" | "name" | "dept">[] =>
  MUNIS.map(({ code, name, dept }) => ({ code, name, dept }));

const norm = (s: string) =>
  s.toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "").trim();

// Pre-normalized names, longest first so "santa rosa de cabal" wins over partials.
const INDEXED = MUNIS.map((m) => ({ m, n: norm(m.name) })).sort(
  (a, b) => b.n.length - a.n.length,
);

/** Find a municipality mentioned anywhere in free text. */
export function findInText(text: string | null | undefined): Muni | null {
  if (!text) return null;
  const t = norm(text);
  return INDEXED.find(({ n }) => t.includes(n))?.m ?? null;
}

export function byName(name: string | null | undefined): Muni | null {
  if (!name) return null;
  const n = norm(name);
  return INDEXED.find((e) => e.n === n)?.m ?? findInText(name);
}

export function byCode(code: string | null | undefined): Muni | null {
  if (!code) return null;
  return MUNIS.find((m) => m.code === code) ?? null;
}
