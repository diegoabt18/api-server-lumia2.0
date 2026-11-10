import { depositPolicySchema, type DepositPolicy } from '../../catalog/domain/deposit-policy.js'
import type { FulfillmentMode } from './order.entity.js'

/**
 * Cálculo financiero de un pedido (G2). Función pura: no toca base de datos.
 *
 * Regla comercial:
 *  - `stock`: se cobra el 100 % del importe de la línea. No genera saldo por fabricación.
 *  - `made_to_order`: se cobra solo el anticipo de la política fotografiada; el saldo es
 *    total de línea − anticipo.
 *
 * Los importes son calculados por Server a partir de precios de catálogo. Ningún importe
 * recibido del cliente entra en este cálculo.
 */

/**
 * Configuración incompleta del catálogo (política o costo ausente). No es un error del cliente:
 * el detalle va al log del servidor y el cliente recibe un mensaje general (ver OrderService).
 */
export type PricingConfigReason =
  | 'missing_policy'
  | 'invalid_policy'
  | 'missing_material_cost'
  | 'deposit_exceeds_line'

export class PricingConfigError extends Error {
  constructor(
    public readonly reason: PricingConfigReason,
    public readonly label: string,
    public readonly sku: string | undefined,
    detail: string,
  ) {
    super(`[${reason}] "${label}"${sku ? ` (SKU ${sku})` : ''}: ${detail}`)
    this.name = 'PricingConfigError'
  }
}

export interface PricedOrderLine {
  /** Nombre legible para mensajes de error. */
  label: string
  /** SKU de la variante (para diagnóstico en logs). */
  sku?: string
  quantity: number
  /** Importe total de la línea (precio unitario × cantidad), calculado por Server. */
  lineTotal: number
  /** Modalidad fotografiada. Ausente = stock (SKU sin registro de inventario). */
  fulfillmentMode?: FulfillmentMode
  /** Política fotografiada. Solo se usa en `made_to_order`. */
  depositPolicy?: DepositPolicy | null
  /**
   * Costo de materiales de la línea. Requerido solo para la política `materials`.
   * Si no hay una fuente confiable, dejarlo ausente bloquea el cálculo con un error explicativo.
   */
  materialCost?: number | null
}

export interface LineFinancials {
  lineTotal: number
  initialPaymentRequired: number
  balanceDue: number
}

export interface OrderFinancials {
  total: number
  initialPaymentRequired: number
  balanceDue: number
  lines: LineFinancials[]
}

const round2 = (n: number) => Math.round(n * 100) / 100

/** Importe de anticipo de una línea `made_to_order`. Lanza error si la configuración no es válida. */
export function calculateLineDeposit(line: PricedOrderLine): number {
  const policy = line.depositPolicy
  if (!policy) {
    throw new PricingConfigError(
      'missing_policy',
      line.label,
      line.sku,
      'se fabrica por pedido y no tiene una política de anticipo configurada. Configúrala antes de vender.',
    )
  }

  const parsed = depositPolicySchema.safeParse(policy)
  if (!parsed.success) {
    throw new PricingConfigError(
      'invalid_policy',
      line.label,
      line.sku,
      `la política de anticipo no es válida: ${parsed.error.issues[0]?.message ?? 'revisa su configuración'}.`,
    )
  }
  const valid = parsed.data

  let deposit: number
  switch (valid.type) {
    case 'fixed':
    case 'custom_authorized':
      // Importes por unidad: el anticipo crece con la cantidad vendida.
      deposit = valid.value * line.quantity
      break
    case 'percent':
      deposit = (line.lineTotal * valid.value) / 100
      break
    case 'materials': {
      if (line.materialCost == null || !Number.isFinite(line.materialCost) || line.materialCost < 0) {
        throw new PricingConfigError(
          'missing_material_cost',
          line.label,
          line.sku,
          'usa anticipo por materiales, pero no hay un costo de materiales confiable para calcularlo.',
        )
      }
      deposit = (line.materialCost * valid.value) / 100
      break
    }
  }

  deposit = round2(deposit)
  if (deposit > line.lineTotal) {
    throw new PricingConfigError(
      'deposit_exceeds_line',
      line.label,
      line.sku,
      `el anticipo (${deposit}) supera el total de la línea (${line.lineTotal}).`,
    )
  }
  return deposit
}

/** Calcula pago inicial y saldo por línea y del pedido completo. */
export function calculateOrderFinancials(lines: PricedOrderLine[]): OrderFinancials {
  const computed: LineFinancials[] = lines.map((line) => {
    const lineTotal = round2(line.lineTotal)
    if (line.fulfillmentMode === 'made_to_order') {
      const initialPaymentRequired = calculateLineDeposit(line)
      return {
        lineTotal,
        initialPaymentRequired,
        balanceDue: round2(lineTotal - initialPaymentRequired),
      }
    }
    return { lineTotal, initialPaymentRequired: lineTotal, balanceDue: 0 }
  })

  const total = round2(computed.reduce((sum, l) => sum + l.lineTotal, 0))
  const initialPaymentRequired = round2(computed.reduce((sum, l) => sum + l.initialPaymentRequired, 0))
  const balanceDue = round2(computed.reduce((sum, l) => sum + l.balanceDue, 0))

  return { total, initialPaymentRequired, balanceDue, lines: computed }
}
