/**
 * IVA incluido en un importe con precio final. Supuesto a validar por el contador: los precios
 * del catálogo incluyen IVA. Sin tasa configurada no se calcula impuesto (devuelve null).
 */
export function includedTaxAmount(amount: number, rate: number | null | undefined): number | null {
  if (rate === null || rate === undefined) return null
  const base = amount / (1 + rate / 100)
  return Math.round((amount - base) * 100) / 100
}
