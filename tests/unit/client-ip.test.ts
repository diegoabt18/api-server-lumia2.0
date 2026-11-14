import Fastify from 'fastify'
import { describe, expect, it } from 'vitest'
import { parseTrustProxy } from '../../src/config/env.js'
import {
  CLIENT_IP_HEADER,
  PROXY_SECRET_HEADER,
  trustedProxyClientIp,
} from '../../src/common/utils/request.utils.js'

const SECRET = 'x'.repeat(40)

function req(headers: Record<string, string>) {
  return { headers } as never
}

describe('trustedProxyClientIp', () => {
  it('accepts the declared IP only with the shared secret', () => {
    expect(
      trustedProxyClientIp(req({ [PROXY_SECRET_HEADER]: SECRET, [CLIENT_IP_HEADER]: '203.0.113.7' }), SECRET),
    ).toBe('203.0.113.7')
  })

  it('ignores the header without secret, with a wrong secret or when no secret is configured', () => {
    expect(trustedProxyClientIp(req({ [CLIENT_IP_HEADER]: '203.0.113.7' }), SECRET)).toBeNull()
    expect(
      trustedProxyClientIp(req({ [PROXY_SECRET_HEADER]: 'y'.repeat(40), [CLIENT_IP_HEADER]: '203.0.113.7' }), SECRET),
    ).toBeNull()
    expect(
      trustedProxyClientIp(req({ [PROXY_SECRET_HEADER]: SECRET, [CLIENT_IP_HEADER]: '203.0.113.7' }), undefined),
    ).toBeNull()
  })

  it('rejects values that are not IP addresses', () => {
    for (const bad of ['evil', '1.2.3.4, 5.6.7.8', '', '999.1.1.1']) {
      expect(
        trustedProxyClientIp(req({ [PROXY_SECRET_HEADER]: SECRET, [CLIENT_IP_HEADER]: bad }), SECRET),
      ).toBeNull()
    }
    expect(
      trustedProxyClientIp(req({ [PROXY_SECRET_HEADER]: SECRET, [CLIENT_IP_HEADER]: '2001:db8::1' }), SECRET),
    ).toBe('2001:db8::1')
  })
})

describe('TRUST_PROXY=loopback,uniquelocal (API solo accesible por loopback/Docker)', () => {
  async function ipFor(remoteAddress: string, xff?: string): Promise<string> {
    const app = Fastify({ trustProxy: parseTrustProxy('loopback,uniquelocal') })
    app.get('/ip', async (request) => request.ip)
    const res = await app.inject({
      url: '/ip',
      remoteAddress,
      headers: xff ? { 'x-forwarded-for': xff } : {},
    })
    await app.close()
    return res.body
  }

  it('uses the IP appended by Cloudflare even if the client forged X-Forwarded-For', async () => {
    // cloudflared en el host → puerto publicado → la API ve la puerta de enlace Docker (172.x)
    expect(await ipFor('172.18.0.1', '6.6.6.6, 198.51.100.20')).toBe('198.51.100.20')
  })

  it('a public client connecting directly cannot choose its IP', async () => {
    expect(await ipFor('198.51.100.99', '1.1.1.1')).toBe('198.51.100.99')
  })

  it('uses the IP the BFF declares through the Docker network', async () => {
    expect(await ipFor('172.18.0.5', '192.0.2.44')).toBe('192.0.2.44')
  })
})

describe('device id by client application', async () => {
  const { buildDeviceId } = await import('../../src/common/utils/crypto.utils.js')
  it('keeps the previous id for the storefront (no client) and separates the admin', () => {
    const ua = 'Mozilla/5.0 Test'
    const store = buildDeviceId(ua, { acceptLanguage: 'es-CO' })
    expect(buildDeviceId(ua, { acceptLanguage: 'es-CO', clientApp: undefined })).toBe(store)
    expect(buildDeviceId(ua, { acceptLanguage: 'es-CO', clientApp: 'admin' })).not.toBe(store)
  })
})
