import net from 'node:net'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { MailService } from '../../src/modules/notifications/services/mail.service.js'

/**
 * Servidor SMTP mínimo en memoria (solo para pruebas): acepta EHLO, MAIL, RCPT, DATA y QUIT y
 * guarda el mensaje. Comprueba que el MailService (nodemailer 10) entrega por SMTP real.
 */
function startSmtpSink() {
  const messages: Array<{ from: string; to: string[]; data: string }> = []
  const server = net.createServer((socket) => {
    let from = ''
    let to: string[] = []
    let inData = false
    let data = ''
    let buffer = ''
    socket.write('220 sink ESMTP\r\n')
    socket.on('data', (chunk) => {
      buffer += chunk.toString('utf8')
      let idx: number
      while ((idx = buffer.indexOf('\r\n')) >= 0) {
        const line = buffer.slice(0, idx)
        buffer = buffer.slice(idx + 2)
        if (inData) {
          if (line === '.') {
            inData = false
            messages.push({ from, to, data })
            socket.write('250 OK queued\r\n')
          } else {
            data += `${line}\n`
          }
          continue
        }
        const cmd = line.toUpperCase()
        if (cmd.startsWith('EHLO') || cmd.startsWith('HELO')) socket.write('250-sink\r\n250 8BITMIME\r\n')
        else if (cmd.startsWith('MAIL FROM:')) {
          from = line.slice(10).trim()
          socket.write('250 OK\r\n')
        } else if (cmd.startsWith('RCPT TO:')) {
          to.push(line.slice(8).trim())
          socket.write('250 OK\r\n')
        } else if (cmd === 'DATA') {
          inData = true
          data = ''
          socket.write('354 End with .\r\n')
        } else if (cmd === 'QUIT') {
          socket.end('221 Bye\r\n')
        } else if (cmd === 'RSET' || cmd === 'NOOP') socket.write('250 OK\r\n')
        else socket.write('502 Not implemented\r\n')
      }
    })
    socket.on('error', () => undefined)
    void to
    to = []
  })
  return { server, messages }
}

describe('MailService over real SMTP (nodemailer 10)', () => {
  const sink = startSmtpSink()
  let port = 0

  beforeAll(async () => {
    await new Promise<void>((resolve) => sink.server.listen(0, '127.0.0.1', resolve))
    port = (sink.server.address() as net.AddressInfo).port
  })

  afterAll(async () => {
    await new Promise<void>((resolve) => sink.server.close(() => resolve()))
  })

  it('sends the pre-order notification to the sales address only', async () => {
    const mail = new MailService({
      enabled: true,
      smtpHost: '127.0.0.1',
      smtpPort: port,
      smtpSecure: false,
      smtpUser: undefined,
      smtpPass: undefined,
      mailFrom: 'notificaciones@example.com',
      salesNotifyEmail: 'ventas@example.com',
    } as never)
    await mail.notifyPreOrderCreated({
      id: 'o1',
      orderNumber: 'ORD-1',
      customerName: 'Ana <script>alert(1)</script>',
      email: 'ana@example.com',
      phone: '3000000000',
      address: 'Calle 1 # 2-3',
      city: 'Bogotá',
      reference: null,
      notes: null,
      paymentStatus: 'unpaid',
      total: 120000,
      currency: 'COP',
      items: [{ name: 'Vela', quantity: 2, unitPrice: 60000, subtotal: 120000 }],
      createdAt: new Date().toISOString(),
    } as never)
    expect(sink.messages).toHaveLength(1)
    const message = sink.messages[0]!
    expect(message.from).toContain('notificaciones@example.com')
    expect(message.to).toEqual(['<ventas@example.com>'])
    expect(message.data).toMatch(/ORD-1/)
    // En la parte HTML el nombre del cliente va escapado; el texto plano no se interpreta.
    const html = message.data.slice(message.data.indexOf('Content-Type: text/html'))
    expect(html).toContain('&lt;script&gt;')
    expect(html).not.toContain('<script>alert(1)</script>')
  })
})
