/**
 * Libro de pagos de un pedido (G3). Funciones puras.
 *
 * Fuente de verdad: los pagos aprobados (`approved`) de la colección de pagos. Los importes
 * pagados por línea y del pedido se RECALCULAN a partir de esos pagos; nunca se acumulan en
 * contadores incrementales. Así no hay deriva si se repite un registro o se corrige algo.
 *
 * Asignación de un pago a las líneas, en orden de línea:
 *   1. Primero cubre el pago inicial exigido de cada línea (100 % en stock, anticipo en por pedido).
 *   2. Lo que sobre cubre los saldos pendientes, también en orden de línea.
 */

export interface LedgerLine {
  /** Posición de la línea dentro del pedido. */
  index: number
  lineTotal: number
  initialPaymentRequired: number
}

export interface LineAllocation {
  index: number
  paidAmount: number
  balanceDue: number
}

export type OrderLedgerPaymentStatus = 'unpaid' | 'partially_paid' | 'paid'

/**
 * Importe exacto que debe registrarse a continuación:
 *  - mientras el anticipo esté pendiente, el importe restante del anticipo;
 *  - después, el saldo completo para confirmar el pedido.
 */
export function nextRequiredPayment(input: { balanceDue: number; initialRemaining: number }): number {
  return round2(input.initialRemaining > 0 ? input.initialRemaining : input.balanceDue)
}

const round2 = (n: number) => Math.round(n * 100) / 100

/** Reparte el importe pagado entre las líneas según la regla de asignación. */
export function allocatePaidAmount(lines: LedgerLine[], paidAmount: number): LineAllocation[] {
  let remaining = round2(Math.max(0, paidAmount))
  const paid = lines.map(() => 0)

  lines.forEach((line, i) => {
    const needed = round2(Math.max(0, Math.min(line.initialPaymentRequired, line.lineTotal)))
    const take = round2(Math.min(remaining, needed))
    paid[i] = take
    remaining = round2(remaining - take)
  })

  lines.forEach((line, i) => {
    const open = round2(line.lineTotal - paid[i]!)
    const take = round2(Math.min(remaining, Math.max(0, open)))
    paid[i] = round2(paid[i]! + take)
    remaining = round2(remaining - take)
  })

  return lines.map((line, i) => ({
    index: line.index,
    paidAmount: paid[i]!,
    balanceDue: round2(line.lineTotal - paid[i]!),
  }))
}

export interface OrderPaymentState {
  paidAmount: number
  balanceDue: number
  paymentStatus: OrderLedgerPaymentStatus
  isFullyPaid: boolean
}

/**
 * Estado de pago del pedido a partir de lo pagado. `paid` solo cuando no queda saldo: pagar el
 * anticipo nunca marca el pedido como pagado.
 */
export function computeOrderPaymentState(input: {
  total: number
  initialPaymentRequired: number
  paidAmount: number
}): OrderPaymentState {
  const paidAmount = round2(Math.max(0, input.paidAmount))
  const balanceDue = round2(Math.max(0, input.total - paidAmount))
  const isFullyPaid = input.total > 0 && balanceDue === 0

  let paymentStatus: OrderLedgerPaymentStatus
  if (isFullyPaid) paymentStatus = 'paid'
  else if (paidAmount === 0) paymentStatus = 'unpaid'
  // Con el anticipo exacto obligatorio, cualquier pago previo ya cubre el anticipo: el pedido queda en pago parcial.
  else paymentStatus = 'partially_paid'

  return { paidAmount, balanceDue, paymentStatus, isFullyPaid }
}

/** Pago inicial exigido de un pedido: suma de los pagos iniciales de sus líneas. */
export function sumInitialRequired(lines: LedgerLine[]): number {
  return round2(lines.reduce((sum, l) => sum + l.initialPaymentRequired, 0))
}
