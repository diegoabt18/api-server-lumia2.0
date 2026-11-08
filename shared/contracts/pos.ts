/** Contrato del POS: solicitud y resultado de venta presencial. */

export type PosPaymentMethodId = 'cash' | 'bank_transfer'
export type PosPaymentState = 'pending_manual' | 'paid'

export interface PosPaymentMethodContract {
  methodId: string
  displayName: string
  description: string
  supportsPaid: boolean
}

export interface PosCustomerContract {
  id: string
  name: string
  email: string | null
  phone: string | null
  /** 'account' = cuenta web; 'counter' = cliente de mostrador. */
  source: 'account' | 'counter'
}

export interface PosSaleRequestContract {
  customer:
    | { mode: 'walk_in'; name?: string; phone?: string; email?: string | null }
    | { mode: 'existing'; userId?: string | null; posCustomerId?: string | null }
  items: Array<{ sku: string; quantity: number }>
  payment: {
    method: PosPaymentMethodId
    state: PosPaymentState
    cashReceived?: number
    changeGiven?: number
    transferReference?: string
  }
  discountAmount?: number
  notes?: string
}
