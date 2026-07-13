/**
 * Tolerant JSON.parse shared by the read-side projections (read-api, report, blast,
 * fleet). Two shapes, one implementation:
 *   - safeParse(s)            → T | null   (null on empty / parse error)
 *   - safeParse(s, fallback)  → T          (fallback on empty / parse error)
 * These read the untrusted, re-derivable risk layer, so a corrupt/tampered value
 * must degrade, never throw. reconcile.ts keeps its own Record-typed variant.
 */
export function safeParse<T>(s: string | null): T | null;
export function safeParse<T>(s: string | null, fallback: T): T;
export function safeParse<T>(s: string | null, fallback?: T): T | null {
  if (!s) return fallback ?? null;
  try {
    return JSON.parse(s) as T;
  } catch {
    return fallback ?? null;
  }
}
