/** Canonical form for every email write and lookup (SQLite NOCASE is ASCII-only). */
export function normEmail(s: string): string {
  return s.trim().normalize("NFC").toLowerCase();
}
