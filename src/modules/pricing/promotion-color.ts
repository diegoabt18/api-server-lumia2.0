const HEX_COLOR = /^#[0-9a-f]{6}$/i

/** Color de promoción en HEX #rrggbb (minúsculas). Cualquier otro valor devuelve null. */
export function normalizePromotionColor(raw: unknown): string | null {
  if (typeof raw !== 'string') return null
  const value = raw.trim()
  return HEX_COLOR.test(value) ? value.toLowerCase() : null
}
