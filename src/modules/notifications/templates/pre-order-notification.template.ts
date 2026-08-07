import type { OrderDomain } from '../../sales/domain/order.entity.js'

function formatMoney(amount: number, currency: string): string {
  try {
    return new Intl.NumberFormat('es-CO', { style: 'currency', currency }).format(amount)
  } catch {
    return `${amount} ${currency}`
  }
}

export function buildPreOrderNotification(order: OrderDomain): {
  subject: string
  text: string
  html: string
} {
  const orderNumber = order.orderNumber ?? order.id
  const currency = order.currency ?? 'COP'
  const itemsLines = order.items
    .map(
      (i) =>
        `- ${i.name}${i.variantName ? ` (${i.variantName})` : ''} x${i.quantity} = ${formatMoney(i.subtotal, currency)}`,
    )
    .join('\n')

  const subject = `[Lumia] Nueva pre-venta ${orderNumber}`

  const text = [
    'Nueva pre-venta registrada en el checkout.',
    '',
    `Pedido: ${orderNumber}`,
    `Cliente: ${order.customerName}`,
    order.email ? `Email cliente: ${order.email}` : null,
    `Teléfono: ${order.phone}`,
    `Dirección: ${order.address}, ${order.city}`,
    order.reference ? `Referencia: ${order.reference}` : null,
    order.notes ? `Notas: ${order.notes}` : null,
    '',
    'Productos:',
    itemsLines,
    '',
    `Total: ${formatMoney(order.total, currency)}`,
    `Estado pago: ${order.paymentStatus ?? 'unpaid'}`,
  ]
    .filter(Boolean)
    .join('\n')

  const htmlItems = order.items
    .map(
      (i) =>
        `<tr><td>${escapeHtml(i.name)}${i.variantName ? ` <small>(${escapeHtml(i.variantName)})</small>` : ''}</td><td>${i.quantity}</td><td>${formatMoney(i.subtotal, currency)}</td></tr>`,
    )
    .join('')

  const html = `<!DOCTYPE html><html><body style="font-family:sans-serif;line-height:1.5">
<h2>Nueva pre-venta</h2>
<p><strong>Pedido:</strong> ${escapeHtml(orderNumber)}</p>
<p><strong>Cliente:</strong> ${escapeHtml(order.customerName)}</p>
${order.email ? `<p><strong>Email:</strong> ${escapeHtml(order.email)}</p>` : ''}
<p><strong>Teléfono:</strong> ${escapeHtml(order.phone)}</p>
<p><strong>Envío:</strong> ${escapeHtml(order.address)}, ${escapeHtml(order.city)}</p>
${order.reference ? `<p><strong>Referencia:</strong> ${escapeHtml(order.reference)}</p>` : ''}
${order.notes ? `<p><strong>Notas:</strong> ${escapeHtml(order.notes)}</p>` : ''}
<table border="1" cellpadding="6" cellspacing="0"><thead><tr><th>Producto</th><th>Cant.</th><th>Subtotal</th></tr></thead><tbody>${htmlItems}</tbody></table>
<p><strong>Total:</strong> ${formatMoney(order.total, currency)}</p>
<p><strong>Estado pago:</strong> ${escapeHtml(order.paymentStatus ?? 'unpaid')}</p>
</body></html>`

  return { subject, text, html }
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}
