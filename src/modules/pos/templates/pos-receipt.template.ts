import type { OrderEntity } from '../../sales/domain/order.entity.js'

const STORE_NAME = 'LUMIA'
const STORE_TAGLINE = 'Velas artesanales'
const STORE_LEGAL_NOTE =
  'Comprobante interno de venta presencial. No es una factura electrónica fiscal.'

function escapeHtml(value: unknown): string {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

function formatCurrency(amount: number, currency: string): string {
  if (!Number.isFinite(amount)) return '$0'
  const value = Math.round(amount)
  const formatted = value.toLocaleString('es-CO')
  return currency === 'COP' || !currency ? `$ ${formatted}` : `${currency} ${formatted}`
}

function formatDate(date: Date | string | null | undefined): string {
  if (!date) return '—'
  const parsed = date instanceof Date ? date : new Date(date)
  if (Number.isNaN(parsed.getTime())) return '—'
  return parsed.toLocaleString('es-CO', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  })
}

function paymentMethodLabel(method: string | undefined): string {
  if (method === 'manual') return 'Pago en tienda'
  if (method === 'mercadopago') return 'Mercado Pago'
  return method || 'No especificado'
}

function paymentStatusLabel(status: string | undefined): string {
  const labels: Record<string, string> = {
    paid: 'PAGADO',
    pending_manual: 'PENDIENTE DE PAGO',
    unpaid: 'PENDIENTE DE PAGO',
    pending: 'PENDIENTE',
    refunded: 'REEMBOLSADO',
    failed: 'FALLIDO',
  }
  return labels[status ?? ''] ?? (status ?? '—')
}

function deliveryLabel(order: OrderEntity): string {
  return order.fulfillment === 'in_store' ? 'Entrega en tienda' : 'Envío a domicilio'
}

export function renderPosReceiptHtml(order: OrderEntity): string {
  const currency = order.currency ?? 'COP'
  const items = order.items ?? []
  const subtotal = order.subtotal ?? items.reduce((sum, item) => sum + item.subtotal, 0)
  const discount = order.discountAmount ?? 0
  const tax = order.tax ?? 0
  const total = order.total
  const paid = order.paymentStatus === 'paid'
  const receiptNumber = order.receiptNumber || order.orderNumber || '—'

  const itemRows = items
    .map(
      (item) => `
        <tr>
          <td class="qty">${item.quantity}</td>
          <td>
            <span class="name">${escapeHtml(item.name)}</span>
            ${item.variantName ? `<span class="variant">${escapeHtml(item.variantName)}</span>` : ''}
            ${item.variantSku ? `<span class="sku">${escapeHtml(item.variantSku)}</span>` : ''}
          </td>
          <td class="money">${formatCurrency(item.unitPrice, currency)}</td>
          <td class="money">${formatCurrency(item.subtotal, currency)}</td>
        </tr>`,
    )
    .join('')

  return `<!doctype html>
<html lang="es">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Comprobante ${escapeHtml(receiptNumber)}</title>
  <style>
    :root { color-scheme: light; }
    * { box-sizing: border-box; }
    body {
      margin: 0;
      padding: 16px;
      font-family: "Segoe UI", "Helvetica Neue", Arial, sans-serif;
      font-size: 12px;
      color: #171412;
      background: #f4f1ea;
    }
    .ticket {
      width: 80mm;
      max-width: 100%;
      margin: 0 auto;
      background: #fff;
      padding: 6mm 5mm;
      border-radius: 4px;
      box-shadow: 0 8px 24px rgba(23, 20, 18, 0.12);
    }
    header { text-align: center; border-bottom: 1px dashed #b9b0a3; padding-bottom: 10px; }
    .brand { font-size: 20px; letter-spacing: 0.28em; font-weight: 700; margin: 0; }
    .tagline { margin: 2px 0 0; font-size: 10px; letter-spacing: 0.16em; text-transform: uppercase; color: #7a7168; }
    .badge {
      display: inline-block;
      margin-top: 8px;
      padding: 3px 8px;
      border-radius: 999px;
      font-size: 9px;
      font-weight: 700;
      letter-spacing: 0.12em;
      text-transform: uppercase;
      background: #f1ece3;
      color: #6b5a3e;
    }
    .meta { margin-top: 10px; display: grid; grid-template-columns: 1fr 1fr; gap: 4px 10px; font-size: 11px; }
    .meta dt { color: #7a7168; }
    .meta dd { margin: 0; text-align: right; font-weight: 600; }
    .customer { margin-top: 10px; padding-top: 8px; border-top: 1px dashed #b9b0a3; font-size: 11px; }
    .customer p { margin: 2px 0; }
    table { width: 100%; border-collapse: collapse; margin-top: 10px; }
    thead th {
      font-size: 9px;
      letter-spacing: 0.08em;
      text-transform: uppercase;
      color: #7a7168;
      text-align: left;
      padding: 4px 0;
      border-bottom: 1px solid #d9d2c6;
    }
    thead th.money, tbody td.money { text-align: right; }
    tbody td { padding: 6px 0; vertical-align: top; border-bottom: 1px dotted #e4ded2; }
    tbody td.qty { width: 26px; font-weight: 700; }
    .name { display: block; font-weight: 600; }
    .variant, .sku { display: block; color: #7a7168; font-size: 10px; }
    .totals { margin-top: 10px; font-size: 11px; }
    .totals .row { display: flex; justify-content: space-between; padding: 2px 0; }
    .totals .row.total {
      margin-top: 6px;
      padding-top: 8px;
      border-top: 1px solid #171412;
      font-size: 15px;
      font-weight: 700;
    }
    .payment { margin-top: 10px; padding-top: 8px; border-top: 1px dashed #b9b0a3; font-size: 11px; }
    .payment .state { font-weight: 700; }
    .payment .state.paid { color: #1f7a4d; }
    .payment .state.pending { color: #9a5b00; }
    footer { margin-top: 12px; text-align: center; font-size: 9px; color: #7a7168; line-height: 1.5; }
    .print-actions { max-width: 80mm; margin: 0 auto 12px; display: flex; gap: 8px; }
    .print-actions button {
      flex: 1;
      padding: 10px;
      border: 0;
      border-radius: 8px;
      background: #171412;
      color: #fff;
      font-size: 11px;
      letter-spacing: 0.08em;
      text-transform: uppercase;
      cursor: pointer;
    }
    .print-actions button.secondary { background: #e8e1d4; color: #171412; }
    @media print {
      @page { size: 80mm auto; margin: 3mm; }
      body { background: #fff; padding: 0; }
      .ticket { box-shadow: none; width: auto; padding: 0; }
      .print-actions { display: none; }
    }
  </style>
</head>
<body>
  <div class="print-actions">
    <button type="button" onclick="window.print()">Imprimir</button>
    <button type="button" class="secondary" onclick="window.close()">Cerrar</button>
  </div>
  <main class="ticket">
    <header>
      <h1 class="brand">${escapeHtml(STORE_NAME)}</h1>
      <p class="tagline">${escapeHtml(STORE_TAGLINE)}</p>
      <span class="badge">Venta presencial</span>
    </header>

    <dl class="meta">
      <dt>Comprobante</dt>
      <dd>${escapeHtml(receiptNumber)}</dd>
      <dt>Pedido</dt>
      <dd>${escapeHtml(order.orderNumber ?? '—')}</dd>
      <dt>Fecha</dt>
      <dd>${escapeHtml(formatDate(order.createdAt))}</dd>
      <dt>Entrega</dt>
      <dd>${escapeHtml(deliveryLabel(order))}</dd>
    </dl>

    <section class="customer">
      <p><strong>Comprador:</strong> ${escapeHtml(order.customerName)}</p>
      ${order.phone ? `<p><strong>Teléfono:</strong> ${escapeHtml(order.phone)}</p>` : ''}
      ${order.email ? `<p><strong>Email:</strong> ${escapeHtml(order.email)}</p>` : ''}
    </section>

    <table>
      <thead>
        <tr>
          <th>Cant</th>
          <th>Producto</th>
          <th class="money">V. unit</th>
          <th class="money">Subtotal</th>
        </tr>
      </thead>
      <tbody>
        ${itemRows}
      </tbody>
    </table>

    <section class="totals">
      <div class="row"><span>Subtotal</span><span>${formatCurrency(subtotal, currency)}</span></div>
      ${discount > 0 ? `<div class="row"><span>Descuento</span><span>- ${formatCurrency(discount, currency)}</span></div>` : ''}
      <div class="row"><span>Impuestos</span><span>${formatCurrency(tax, currency)}</span></div>
      <div class="row"><span>Envío</span><span>${formatCurrency(order.shippingCost ?? 0, currency)}</span></div>
      <div class="row total"><span>Total</span><span>${formatCurrency(total, currency)}</span></div>
    </section>

    <section class="payment">
      <p><strong>Método de pago:</strong> ${escapeHtml(paymentMethodLabel(order.paymentMethod))}</p>
      <p>
        <strong>Estado:</strong>
        <span class="state ${paid ? 'paid' : 'pending'}">${escapeHtml(paymentStatusLabel(order.paymentStatus))}</span>
      </p>
    </section>

    <footer>
      <p>Gracias por tu compra.</p>
      <p>${escapeHtml(STORE_LEGAL_NOTE)}</p>
    </footer>
  </main>
</body>
</html>`
}
