import type { OrderDomain } from '../../sales/domain/order.entity.js'
import type { OrderPaymentStatus } from '../../sales/domain/order.entity.js'

function formatMoney(amount: number, currency: string): string {
  try {
    return new Intl.NumberFormat('es-CO', { style: 'currency', currency }).format(amount)
  } catch {
    return `${amount} ${currency}`
  }
}

function formatDate(iso: string): string {
  try {
    return new Intl.DateTimeFormat('es-CO', {
      dateStyle: 'medium',
      timeStyle: 'short',
    }).format(new Date(iso))
  } catch {
    return iso
  }
}

const PAYMENT_LABELS: Record<OrderPaymentStatus, string> = {
  unpaid: 'Sin pagar',
  pending: 'Pago pendiente',
  in_process: 'En proceso',
  pending_manual: 'Pago manual pendiente',
  paid: 'Pagado',
  refunded: 'Reembolsado',
  failed: 'Pago fallido',
  expired: 'Expirado',
  deposit_pending: 'Anticipo pendiente',
  deposit_paid: 'Anticipo recibido',
  final_payment_pending: 'Saldo pendiente',
  payment_completed: 'Pago completado',
}

function paymentLabel(status?: OrderPaymentStatus): string {
  if (!status) return 'Sin pagar'
  return PAYMENT_LABELS[status] ?? status
}

function whatsAppLink(phone: string): string | null {
  const digits = phone.replace(/\D/g, '')
  if (digits.length < 10) return null
  const intl = digits.length === 10 && digits.startsWith('3') ? `57${digits}` : digits
  return `https://wa.me/${intl}`
}

export function buildPreOrderNotification(order: OrderDomain): {
  subject: string
  text: string
  html: string
} {
  const orderNumber = order.orderNumber ?? order.id
  const currency = order.currency ?? 'COP'
  const itemCount = order.items.reduce((sum, i) => sum + i.quantity, 0)
  const payment = paymentLabel(order.paymentStatus)
  const createdAt = formatDate(order.createdAt)
  const wa = whatsAppLink(order.phone)

  const subject = `🛍️ Nuevo pedido ${orderNumber} · ${formatMoney(order.total, currency)}`

  const text = [
    '🛍️ NUEVO PEDIDO — LumiAdali Store',
    '━━━━━━━━━━━━━━━━━━━━━━━━',
    '',
    `Pedido:     ${orderNumber}`,
    `Fecha:      ${createdAt}`,
    `Estado:     ${payment}`,
    `Artículos:  ${itemCount}`,
    '',
    '── Cliente ──',
    `Nombre:     ${order.customerName}`,
    order.email ? `Email:      ${order.email}` : null,
    `Teléfono:   ${order.phone}`,
    wa ? `WhatsApp:   ${wa}` : null,
    '',
    '── Envío ──',
    `Dirección:  ${order.address}`,
    `Ciudad:     ${order.city}`,
    order.reference ? `Referencia: ${order.reference}` : null,
    order.notes ? `Notas:      ${order.notes}` : null,
    '',
    '── Productos ──',
    ...order.items.map(
      (i) =>
        `  · ${i.name}${i.variantName ? ` (${i.variantName})` : ''} × ${i.quantity} = ${formatMoney(i.subtotal, currency)}`,
    ),
    '',
    '━━━━━━━━━━━━━━━━━━━━━━━━',
    `TOTAL:      ${formatMoney(order.total, currency)}`,
    '',
    'Revisa el panel admin para confirmar y contactar al cliente.',
  ]
    .filter(Boolean)
    .join('\n')

  const htmlItems = order.items
    .map(
      (i) => `
      <tr>
        <td style="padding:12px 16px;border-bottom:1px solid #ede9fe;color:#1e1b4b;font-size:14px;">
          <strong>${escapeHtml(i.name)}</strong>
          ${i.variantName ? `<br><span style="color:#64748b;font-size:12px;">${escapeHtml(i.variantName)}</span>` : ''}
        </td>
        <td style="padding:12px 16px;border-bottom:1px solid #ede9fe;color:#64748b;font-size:14px;text-align:center;width:60px;">${i.quantity}</td>
        <td style="padding:12px 16px;border-bottom:1px solid #ede9fe;color:#1e1b4b;font-size:14px;text-align:right;width:110px;white-space:nowrap;">${formatMoney(i.subtotal, currency)}</td>
      </tr>`,
    )
    .join('')

  const html = `<!DOCTYPE html>
<html lang="es">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>${escapeHtml(subject)}</title>
</head>
<body style="margin:0;padding:0;background:#f4f2fa;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;">
  <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="background:#f4f2fa;padding:24px 12px;">
    <tr>
      <td align="center">
        <table role="presentation" width="600" cellspacing="0" cellpadding="0" style="max-width:600px;width:100%;background:#ffffff;border-radius:16px;overflow:hidden;box-shadow:0 4px 24px rgba(109,40,217,0.10);">

          <!-- Header -->
          <tr>
            <td style="background:linear-gradient(135deg,#6d28d9 0%,#5b21b6 100%);padding:28px 32px;">
              <table role="presentation" width="100%" cellspacing="0" cellpadding="0">
                <tr>
                  <td>
                    <p style="margin:0 0 4px;font-size:13px;color:#ddd6fe;letter-spacing:0.5px;text-transform:uppercase;">LumiAdali Store</p>
                    <h1 style="margin:0;font-size:24px;color:#ffffff;font-weight:700;">🛍️ Nuevo pedido</h1>
                  </td>
                  <td align="right" valign="top">
                    <span style="display:inline-block;background:rgba(255,255,255,0.15);color:#ffffff;font-size:13px;font-weight:600;padding:6px 14px;border-radius:999px;">${escapeHtml(orderNumber)}</span>
                  </td>
                </tr>
              </table>
            </td>
          </tr>

          <!-- Resumen rápido -->
          <tr>
            <td style="padding:24px 32px 0;">
              <table role="presentation" width="100%" cellspacing="0" cellpadding="0">
                <tr>
                  <td width="33%" style="padding:12px;background:#f5f3ff;border-radius:10px;text-align:center;">
                    <p style="margin:0;font-size:11px;color:#64748b;text-transform:uppercase;letter-spacing:0.4px;">Total</p>
                    <p style="margin:4px 0 0;font-size:18px;font-weight:700;color:#6d28d9;">${formatMoney(order.total, currency)}</p>
                  </td>
                  <td width="4"></td>
                  <td width="33%" style="padding:12px;background:#f5f3ff;border-radius:10px;text-align:center;">
                    <p style="margin:0;font-size:11px;color:#64748b;text-transform:uppercase;letter-spacing:0.4px;">Artículos</p>
                    <p style="margin:4px 0 0;font-size:18px;font-weight:700;color:#1e1b4b;">${itemCount}</p>
                  </td>
                  <td width="4"></td>
                  <td width="33%" style="padding:12px;background:#f5f3ff;border-radius:10px;text-align:center;">
                    <p style="margin:0;font-size:11px;color:#64748b;text-transform:uppercase;letter-spacing:0.4px;">Pago</p>
                    <p style="margin:4px 0 0;font-size:13px;font-weight:600;color:#1e1b4b;">${escapeHtml(payment)}</p>
                  </td>
                </tr>
              </table>
              <p style="margin:12px 0 0;font-size:12px;color:#94a3b8;">Recibido el ${escapeHtml(createdAt)}</p>
            </td>
          </tr>

          <!-- Cliente -->
          <tr>
            <td style="padding:24px 32px 0;">
              <p style="margin:0 0 12px;font-size:12px;font-weight:700;color:#6d28d9;text-transform:uppercase;letter-spacing:0.6px;">👤 Cliente</p>
              <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="background:#fafafa;border-radius:10px;border:1px solid #ede9fe;">
                <tr>
                  <td style="padding:16px;">
                    <p style="margin:0 0 8px;font-size:15px;font-weight:600;color:#1e1b4b;">${escapeHtml(order.customerName)}</p>
                    ${order.email ? `<p style="margin:0 0 6px;font-size:13px;color:#475569;">✉️ <a href="mailto:${escapeHtml(order.email)}" style="color:#6d28d9;text-decoration:none;">${escapeHtml(order.email)}</a></p>` : ''}
                    <p style="margin:0;font-size:13px;color:#475569;">📱 ${escapeHtml(order.phone)}${wa ? ` · <a href="${wa}" style="color:#16a34a;text-decoration:none;font-weight:600;">WhatsApp →</a>` : ''}</p>
                  </td>
                </tr>
              </table>
            </td>
          </tr>

          <!-- Envío -->
          <tr>
            <td style="padding:20px 32px 0;">
              <p style="margin:0 0 12px;font-size:12px;font-weight:700;color:#6d28d9;text-transform:uppercase;letter-spacing:0.6px;">🚚 Envío</p>
              <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="background:#fafafa;border-radius:10px;border:1px solid #ede9fe;">
                <tr>
                  <td style="padding:16px;">
                    <p style="margin:0 0 6px;font-size:14px;color:#1e1b4b;">${escapeHtml(order.address)}</p>
                    <p style="margin:0;font-size:13px;color:#64748b;">${escapeHtml(order.city)}${order.reference ? ` · Ref: ${escapeHtml(order.reference)}` : ''}</p>
                    ${order.notes ? `<p style="margin:10px 0 0;font-size:13px;color:#475569;padding-top:10px;border-top:1px solid #ede9fe;"><em>Nota:</em> ${escapeHtml(order.notes)}</p>` : ''}
                  </td>
                </tr>
              </table>
            </td>
          </tr>

          <!-- Productos -->
          <tr>
            <td style="padding:20px 32px 0;">
              <p style="margin:0 0 12px;font-size:12px;font-weight:700;color:#6d28d9;text-transform:uppercase;letter-spacing:0.6px;">📦 Productos</p>
              <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="border-radius:10px;overflow:hidden;border:1px solid #ede9fe;">
                <thead>
                  <tr style="background:#f5f3ff;">
                    <th style="padding:10px 16px;text-align:left;font-size:11px;color:#64748b;text-transform:uppercase;letter-spacing:0.4px;">Producto</th>
                    <th style="padding:10px 16px;text-align:center;font-size:11px;color:#64748b;text-transform:uppercase;letter-spacing:0.4px;">Cant.</th>
                    <th style="padding:10px 16px;text-align:right;font-size:11px;color:#64748b;text-transform:uppercase;letter-spacing:0.4px;">Subtotal</th>
                  </tr>
                </thead>
                <tbody>${htmlItems}</tbody>
                <tfoot>
                  <tr style="background:#6d28d9;">
                    <td colspan="2" style="padding:14px 16px;font-size:14px;font-weight:600;color:#ffffff;">Total del pedido</td>
                    <td style="padding:14px 16px;font-size:16px;font-weight:700;color:#ffffff;text-align:right;">${formatMoney(order.total, currency)}</td>
                  </tr>
                </tfoot>
              </table>
            </td>
          </tr>

          <!-- Footer -->
          <tr>
            <td style="padding:28px 32px;text-align:center;">
              <p style="margin:0 0 8px;font-size:13px;color:#64748b;">Confirma el pedido y contacta al cliente desde el panel admin o WhatsApp.</p>
              <p style="margin:0;font-size:11px;color:#94a3b8;">LumiAdali Store · Notificación automática de pre-venta</p>
            </td>
          </tr>

        </table>
      </td>
    </tr>
  </table>
</body>
</html>`

  return { subject, text, html }
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}
