import { createHmac, timingSafeEqual } from 'node:crypto'

/**
 * Cliente REST mínimo de Mercado Pago (Checkout Pro). No depende de la SDK.
 * Los tokens nunca se registran en logs.
 */
const MP_API_BASE = 'https://api.mercadopago.com'

export type MercadoPagoStatus =
  | 'created'
  | 'pending'
  | 'in_process'
  | 'approved'
  | 'rejected'
  | 'cancelled'
  | 'refunded'
  | 'charged_back'
  | 'in_mediation'

export interface MercadoPagoPreferenceInput {
  orderId: string
  orderNumber: string
  amount: number
  currency: string
  description: string
  externalReference: string
  payerEmail?: string
  backUrls: { success: string; failure: string; pending: string }
  notificationUrl?: string
}

export interface MercadoPagoPreference {
  providerPreferenceId: string
  initPoint?: string
  sandboxInitPoint?: string
}

export interface MercadoPagoPaymentVerification {
  providerPaymentId: string
  status: MercadoPagoStatus
  statusDetail?: string
  externalReference?: string
  transactionAmount?: number
  paymentMethodId?: string
  paymentTypeId?: string
}

export interface MercadoPagoClient {
  createPreference(input: MercadoPagoPreferenceInput): Promise<MercadoPagoPreference>
  getPayment(providerPaymentId: string): Promise<MercadoPagoPaymentVerification>
  cancelPreference(providerPreferenceId: string): Promise<void>
}

export class MercadoPagoApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message)
    this.name = 'MercadoPagoApiError'
  }
}

type FetchLike = (input: string, init?: RequestInit) => Promise<Response>

const KNOWN_STATUSES = new Set<MercadoPagoStatus>([
  'created',
  'pending',
  'in_process',
  'approved',
  'rejected',
  'cancelled',
  'refunded',
  'charged_back',
  'in_mediation',
])

export function createMercadoPagoClient(
  options: { accessToken: string; fetchImpl?: FetchLike; apiBase?: string },
): MercadoPagoClient {
  const fetchImpl = options.fetchImpl ?? ((input, init) => fetch(input, init))
  const base = options.apiBase ?? MP_API_BASE

  async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
    const response = await fetchImpl(`${base}${path}`, {
      ...init,
      headers: {
        Authorization: `Bearer ${options.accessToken}`,
        'Content-Type': 'application/json',
        Accept: 'application/json',
        ...(init.headers ?? {}),
      },
    })
    if (!response.ok) {
      // Solo el código HTTP; el cuerpo puede contener datos sensibles.
      throw new MercadoPagoApiError(response.status, `Mercado Pago respondió ${response.status} en ${path}`)
    }
    return (await response.json()) as T
  }

  return {
    async createPreference(input) {
      const body = {
        items: [
          {
            id: input.orderId,
            title: input.description,
            quantity: 1,
            unit_price: input.amount,
            currency_id: input.currency,
          },
        ],
        payer: input.payerEmail ? { email: input.payerEmail } : {},
        external_reference: input.externalReference,
        back_urls: input.backUrls,
        auto_return: 'approved',
        ...(input.notificationUrl ? { notification_url: input.notificationUrl } : {}),
      }
      const res = await request<{ id: string; init_point?: string; sandbox_init_point?: string }>(
        '/checkout/preferences',
        { method: 'POST', body: JSON.stringify(body) },
      )
      return {
        providerPreferenceId: res.id,
        initPoint: res.init_point,
        sandboxInitPoint: res.sandbox_init_point,
      }
    },

    async getPayment(providerPaymentId) {
      const res = await request<{
        id: number | string
        status: string
        status_detail?: string
        external_reference?: string
        transaction_amount?: number
        payment_method_id?: string
        payment_type_id?: string
      }>(`/v1/payments/${encodeURIComponent(providerPaymentId)}`)
      const status = KNOWN_STATUSES.has(res.status as MercadoPagoStatus)
        ? (res.status as MercadoPagoStatus)
        : 'pending'
      return {
        providerPaymentId: String(res.id),
        status,
        statusDetail: res.status_detail,
        externalReference: res.external_reference,
        transactionAmount: res.transaction_amount,
        paymentMethodId: res.payment_method_id,
        paymentTypeId: res.payment_type_id,
      }
    },

    async cancelPreference(providerPreferenceId) {
      try {
        await request(`/checkout/preferences/${encodeURIComponent(providerPreferenceId)}`, {
          method: 'PUT',
          body: JSON.stringify({}),
        })
      } catch {
        // La preferencia puede haber expirado o ya no existir: no bloquea el nuevo intento.
      }
    },
  }
}

/** Extrae el id del pago de una notificación de Mercado Pago. */
export function parseMercadoPagoWebhook(payload: unknown): { type: string; paymentId: string } | null {
  if (!payload || typeof payload !== 'object') return null
  const p = payload as { type?: unknown; action?: unknown; data?: { id?: unknown } }
  const type = typeof p.type === 'string' ? p.type : null
  const id = p.data?.id != null ? String(p.data.id) : ''
  if (!type || !id) return null
  return { type, paymentId: id }
}

/**
 * Verifica la firma `x-signature` de Mercado Pago (manifest id/request-id/ts, HMAC-SHA256).
 * Devuelve false si falta alguna pieza o la firma no coincide.
 */
export function verifyMercadoPagoSignature(input: {
  secret: string
  signatureHeader: string | undefined
  requestId: string | undefined
  dataId: string
}): boolean {
  if (!input.signatureHeader || !input.requestId) return false
  const parts = Object.fromEntries(
    input.signatureHeader.split(',').map((segment) => {
      const [key, ...rest] = segment.trim().split('=')
      return [key, rest.join('=')]
    }),
  ) as Record<string, string | undefined>
  const ts = parts.ts
  const received = parts.v1
  if (!ts || !received) return false
  const manifest = `id:${input.dataId.toLowerCase()};request-id:${input.requestId};ts:${ts};`
  const expected = createHmac('sha256', input.secret).update(manifest).digest('hex')
  const a = Buffer.from(expected)
  const b = Buffer.from(received)
  return a.length === b.length && timingSafeEqual(a, b)
}
