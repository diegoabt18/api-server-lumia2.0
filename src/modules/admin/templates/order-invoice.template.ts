import type { OrderEntity } from '../../sales/domain/order.entity.js'

function formatCurrency(n: number, currency: string): string {
  if (!Number.isFinite(n)) return '$0'
  const symbol = currency === 'COP' ? '$' : currency || '$'
  return `${symbol} ${Math.round(n).toLocaleString('es-CO')}`
}

function formatDate(iso: string | Date | null | undefined): string {
  if (!iso) return '—'
  try {
    const d = iso instanceof Date ? iso : new Date(iso)
    return Number.isNaN(d.getTime())
      ? String(iso)
      : d.toLocaleDateString('es-CO', { year: 'numeric', month: 'long', day: 'numeric', hour: '2-digit', minute: '2-digit' })
  } catch {
    return String(iso)
  }
}

function statusLabel(status: string): string {
  const labels: Record<string, string> = {
    pending: 'Pendiente',
    paid: 'Pagado',
    shipped: 'Enviado',
    delivered: 'Entregado',
    cancelled: 'Cancelado',
    expired: 'Expirado',
    unpaid: 'No pagado',
    in_process: 'En proceso',
    pending_manual: 'Pago manual pendiente',
    refunded: 'Reembolsado',
    failed: 'Fallido',
    deposit_pending: 'Anticipo pendiente',
    final_payment_pending: 'Saldo pendiente',
    payment_completed: 'Pagado',
  }
  return labels[status] || status
}

function getOptionsText(item: {
  selectionLabel?: string | null
  selectedOptions?: Array<{ label: string; value: string }> | null
}): string {
  if (item.selectedOptions?.length) {
    return item.selectedOptions.map((o) => `${o.label}: ${o.value}`).join(', ')
  }
  if (item.selectionLabel) return item.selectionLabel
  return ''
}

export function renderOrderInvoiceHtml(order: OrderEntity, id: string): string {
  const currency = order.currency || 'COP'
  const orderNumber = order.orderNumber || `#${id.slice(0, 8)}`
  const itemRows = (order.items || [])
    .map((item, i) => {
      const opts = getOptionsText(item)
      return `
      <tr>
        <td class="item-num">${i + 1}</td>
        <td class="item-name">
          <strong>${item.name}</strong>
          ${opts ? `<br><span class="item-opts">${opts}</span>` : ''}
          ${item.variantSku ? `<br><span class="item-sku">SKU: ${item.variantSku}</span>` : ''}
        </td>
        <td class="item-qty">${item.quantity}</td>
        <td class="item-price">${formatCurrency(item.unitPrice, currency)}</td>
        <td class="item-total">${formatCurrency(item.subtotal, currency)}</td>
      </tr>`
    })
    .join('\n')

  const shippingLine =
    order.shippingCost && order.shippingCost > 0
      ? `<tr><td colspan="4" class="summary-label">Envío</td><td class="summary-value">${formatCurrency(order.shippingCost, currency)}</td></tr>`
      : ''

  const discountLine =
    order.discountAmount && order.discountAmount > 0
      ? `<tr><td colspan="4" class="summary-label">Descuento</td><td class="summary-value discount">-${formatCurrency(order.discountAmount, currency)}</td></tr>`
      : ''

  const badgeClass =
    order.status === 'paid' || order.status === 'delivered'
      ? 'badge-paid'
      : order.status === 'cancelled'
        ? 'badge-cancelled'
        : 'badge-default'

  return `<!DOCTYPE html>
<html lang="es">
<head>
<meta charset="UTF-8">
<title>Factura ${orderNumber}</title>
<style>
  body { font-family: system-ui, sans-serif; color: #1a1a2e; background: #f5f5f5; padding: 40px 20px; }
  .invoice { max-width: 800px; margin: 0 auto; background: #fff; border-radius: 16px; box-shadow: 0 4px 24px rgba(0,0,0,0.08); overflow: hidden; }
  .invoice-header { background: #1a1a2e; color: #fff; padding: 32px 40px; display: flex; justify-content: space-between; }
  .invoice-body { padding: 32px 40px; }
  .info-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 24px; margin-bottom: 32px; }
  .info-block h3 { font-size: 11px; text-transform: uppercase; color: #9ca3af; margin-bottom: 8px; }
  table.items { width: 100%; border-collapse: collapse; }
  table.items th, table.items td { padding: 8px 4px; border-bottom: 1px solid #f3f4f6; font-size: 14px; }
  .summary { margin-top: 20px; margin-left: auto; width: 320px; }
  .badge { padding: 4px 14px; border-radius: 20px; font-size: 12px; font-weight: 600; }
  .badge-paid { background: #10b981; }
  .badge-cancelled { background: #ef4444; }
  .badge-default { background: #6b7280; }
  @media print { body { background: #fff; padding: 0; } .no-print { display: none; } }
</style>
</head>
<body>
  <div class="no-print" style="text-align:center;padding:16px"><button onclick="window.print()">Imprimir / PDF</button></div>
  <div class="invoice">
    <div class="invoice-header">
      <div><h1>Lumia</h1><p>Factura de venta</p></div>
      <div style="text-align:right"><span class="badge ${badgeClass}">${statusLabel(order.status)}</span><p><strong>${orderNumber}</strong></p></div>
    </div>
    <div class="invoice-body">
      <div class="info-grid">
        <div class="info-block"><h3>Cliente</h3><p><strong>${order.customerName}</strong></p>${order.email ? `<p>${order.email}</p>` : ''}${order.phone ? `<p>Tel: ${order.phone}</p>` : ''}</div>
        <div class="info-block"><h3>Envío</h3><p>${order.address}</p><p>${order.city}</p>${order.reference ? `<p>Ref: ${order.reference}</p>` : ''}</div>
        <div class="info-block"><h3>Fecha</h3><p>${formatDate(order.createdAt)}</p></div>
        <div class="info-block"><h3>Pago</h3><p>${order.paymentMethod ? statusLabel(order.paymentMethod) : '—'}</p></div>
      </div>
      <table class="items"><thead><tr><th>#</th><th>Producto</th><th>Cant</th><th>Precio</th><th>Total</th></tr></thead><tbody>${itemRows}</tbody></table>
      <div class="summary"><table>
        <tr><td colspan="4" style="text-align:right">Subtotal</td><td style="text-align:right">${formatCurrency(order.subtotal ?? 0, currency)}</td></tr>
        ${shippingLine}${discountLine}
        <tr><td colspan="4" style="text-align:right;font-weight:700">Total</td><td style="text-align:right;font-weight:700">${formatCurrency(order.total, currency)}</td></tr>
      </table></div>
      ${order.notes ? `<p style="margin-top:20px"><strong>Notas:</strong> ${order.notes}</p>` : ''}
      <p style="margin-top:12px;font-size:13px;color:#6b7280"><strong>Estado pago:</strong> ${statusLabel(order.paymentStatus || '—')}</p>
    </div>
  </div>
</body>
</html>`
}
