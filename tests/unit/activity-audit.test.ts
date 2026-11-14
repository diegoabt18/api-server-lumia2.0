import Fastify from 'fastify'
import cookie from '@fastify/cookie'
import fp from 'fastify-plugin'
import { describe, expect, it } from 'vitest'
import {
  GENESIS_HASH,
  REDACTED,
  computeHash,
  diffSnapshots,
  sanitize,
  verifyChain,
  type ActivityRecord,
} from '../../src/modules/admin-activity/domain/activity-audit.js'
import activityAuditPlugin, {
  resourceFromRoute,
  resultFor,
} from '../../src/modules/admin-activity/activity-audit.plugin.js'
import type { NewActivityRecord } from '../../src/modules/admin-activity/infrastructure/activity-audit.repository.js'

const KEY = 'k'.repeat(48)

describe('sanitize', () => {
  it('never keeps passwords, tokens, secrets or keys', () => {
    const out = sanitize({
      email: 'a@b.co',
      password: 'p',
      newPassword: 'p2',
      refresh_token: 't',
      tempToken: 't2',
      secret: 's',
      apiKey: 'k',
      backupCodes: ['1', '2'],
      nested: { clientSecret: 'x', accessToken: 'y', name: 'ok' },
    }) as Record<string, unknown>
    expect(out.email).toBe('a@b.co')
    for (const key of ['password', 'newPassword', 'refresh_token', 'tempToken', 'secret', 'apiKey', 'backupCodes']) {
      expect(out[key]).toBe(REDACTED)
    }
    expect(out.nested).toEqual({ clientSecret: REDACTED, accessToken: REDACTED, name: 'ok' })
  })

  it('redacts one-time codes only on 2FA routes (currency `code` stays)', () => {
    expect(sanitize({ code: '123456' }, { twoFactorRoute: true })).toEqual({ code: REDACTED })
    expect(sanitize({ code: 'COP' })).toEqual({ code: 'COP' })
  })

  it('bounds strings, arrays and depth', () => {
    const out = sanitize({ s: 'x'.repeat(5000), a: Array.from({ length: 70 }, (_, i) => i) }) as {
      s: string
      a: unknown[]
    }
    expect(out.s.length).toBeLessThan(1100)
    expect(out.a).toHaveLength(51)
    let deep: Record<string, unknown> = {}
    const root = deep
    for (let i = 0; i < 10; i++) deep = deep.next = {} as Record<string, unknown>
    expect(JSON.stringify(sanitize(root))).toContain('[TRUNCATED]')
  })
})

describe('diffSnapshots', () => {
  it('keeps only changed top-level fields', () => {
    expect(diffSnapshots({ name: 'A', price: 1, updatedAt: 'x' }, { name: 'A', price: 2, updatedAt: 'y' })).toEqual({
      price: { before: 1, after: 2 },
    })
  })
  it('records creation and deletion', () => {
    expect(diffSnapshots(null, { name: 'A' })).toEqual({ name: { before: null, after: 'A' } })
    expect(diffSnapshots({ name: 'A' }, null)).toEqual({ name: { before: 'A', after: null } })
  })
  it('returns null when nothing changed', () => {
    expect(diffSnapshots({ a: [1, { b: 2 }] }, { a: [1, { b: 2 }] })).toBeNull()
  })
})

function chain(n: number): ActivityRecord[] {
  const out: ActivityRecord[] = []
  let prev = GENESIS_HASH
  for (let i = 1; i <= n; i++) {
    const base = {
      seq: i,
      at: new Date(Date.UTC(2026, 10, 14, 0, i)),
      actor: { userId: 'u1', ip: '203.0.113.1', userAgent: null },
      action: 'PATCH /api/admin/products/:id',
      resource: { type: 'product', id: `p${i}` },
      input: { price: i },
      changes: { price: { before: i - 1, after: i } },
      result: 'success' as const,
      statusCode: 200,
      errorCode: null,
      requestId: `r${i}`,
      prevHash: prev,
    }
    const hash = computeHash(KEY, base)
    out.push({ ...base, hash })
    prev = hash
  }
  return out
}

describe('hash chain', () => {
  it('verifies an intact chain', () => {
    expect(verifyChain(KEY, chain(5))).toMatchObject({ ok: true, checked: 5 })
  })
  it('detects an altered record', () => {
    const records = chain(5)
    records[2] = { ...records[2]!, input: { price: 999 } }
    expect(verifyChain(KEY, records)).toMatchObject({ ok: false, brokenAtSeq: 3, reason: 'Contenido alterado' })
  })
  it('detects a deleted record', () => {
    const records = chain(5)
    records.splice(1, 1)
    expect(verifyChain(KEY, records)).toMatchObject({ ok: false, brokenAtSeq: 2 })
  })
  it('cannot be rebuilt without the key', () => {
    const records = chain(3)
    const forged = { ...records[1]!, input: { price: 0 } }
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    const { hash: _h, ...rest } = forged
    forged.hash = computeHash('another-key-'.repeat(4), rest)
    records[1] = forged
    expect(verifyChain(KEY, records).ok).toBe(false)
  })
})

describe('route mapping', () => {
  it('derives resource type and id', () => {
    expect(resourceFromRoute('/api/admin/products/:id/variants/:sku', { id: 'p1', sku: 'S' })).toEqual({ type: 'product', id: 'p1' })
    expect(resourceFromRoute('/api/admin/security/users/:id/roles', { id: 'u2' })).toEqual({ type: 'user-roles', id: 'u2' })
    expect(resourceFromRoute('/api/admin/store-shipping-settings', {})).toEqual({ type: 'store-shipping-settings', id: null })
    expect(resourceFromRoute('/api/admin/production/materials/:id', { id: 'm1' })).toEqual({ type: 'production/materials', id: 'm1' })
  })
  it('maps status codes to results', () => {
    expect(resultFor(200)).toBe('success')
    expect(resultFor(403)).toBe('denied')
    expect(resultFor(401)).toBe('denied')
    expect(resultFor(409)).toBe('failure')
    expect(resultFor(500)).toBe('failure')
  })
})

describe('activity audit plugin (Fastify real)', () => {
  async function build() {
    const appended: NewActivityRecord[] = []
    let product = { name: 'Vela', price: 10000, secretNote: 'x' }
    const app = Fastify()
    await app.register(cookie)
    app.decorate('ctx', {
      env: { COOKIE_ACCESS_NAME: 'lumia_access' },
      activityAudit: { append: async (r: NewActivityRecord) => void appended.push(r) },
      services: { adminProducts: { get: async () => ({ product }) } },
      repos: {},
    } as never)
    await app.register(activityAuditPlugin)
    await app.register(
      fp(async (api) => {
        const fakeAuth = async (request: { auth?: unknown; headers: Record<string, unknown> }) => {
          if (request.headers.authorization !== 'Bearer ok') {
            const err = new Error('nope') as Error & { statusCode: number }
            err.statusCode = 403
            throw err
          }
          request.auth = { userId: 'admin-1' }
        }
        api.patch('/api/admin/products/:id', { preHandler: fakeAuth as never }, async (request) => {
          product = { ...product, ...(request.body as object) }
          return { ok: true }
        })
        api.get('/api/admin/products/:id', async () => product)
        api.post('/api/admin/lumi/chat', async () => ({ ok: true }))
        api.post('/api/admin/auth/2fa/verify-setup', async () => ({ ok: true }))
      }),
    )
    // onResponse se ejecuta después de enviar la respuesta: se espera a que termine.
    const settle = () => new Promise((r) => setTimeout(r, 30))
    return { app, appended, settle }
  }

  it('records who, what, resource, changes and sanitized input', async () => {
    const { app, appended, settle } = await build()
    const res = await app.inject({
      method: 'PATCH',
      url: '/api/admin/products/p1',
      headers: { authorization: 'Bearer ok', 'user-agent': 'vitest' },
      payload: { price: 12000, password: 'should-not-appear' },
    })
    expect(res.statusCode).toBe(200)
    await settle()
    expect(appended).toHaveLength(1)
    const r = appended[0]!
    expect(r).toMatchObject({
      actor: { userId: 'admin-1', userAgent: 'vitest' },
      action: 'PATCH /api/admin/products/:id',
      resource: { type: 'product', id: 'p1' },
      result: 'success',
      statusCode: 200,
      changes: { price: { before: 10000, after: 12000 } },
    })
    expect(JSON.stringify(r)).not.toContain('should-not-appear')
    await app.close()
  })

  it('records denied operations without changes', async () => {
    const { app, appended, settle } = await build()
    await app.inject({ method: 'PATCH', url: '/api/admin/products/p1', payload: { price: 1 } })
    await settle()
    expect(appended[0]).toMatchObject({ result: 'denied', statusCode: 403, changes: null, actor: { userId: null } })
    await app.close()
  })

  it('ignores reads and assistant chat; redacts 2FA codes', async () => {
    const { app, appended, settle } = await build()
    await app.inject({ method: 'GET', url: '/api/admin/products/p1' })
    await app.inject({ method: 'POST', url: '/api/admin/lumi/chat', payload: { message: 'hola' } })
    await app.inject({ method: 'POST', url: '/api/admin/auth/2fa/verify-setup', payload: { code: '123456', secret: 's' } })
    await settle()
    expect(appended).toHaveLength(1)
    expect(appended[0]!.input).toEqual({ code: REDACTED, secret: REDACTED })
    await app.close()
  })
})
