import { timingSafeEqual } from 'node:crypto'
import { isIP } from 'node:net'
import type { FastifyRequest } from 'fastify'
import { getEnv } from '../../config/env.js'

/** Cabeceras con las que un proxy propio (BFF de Lumia Admin, Worker de Lumia 2.0) informa la IP real. */
export const CLIENT_IP_HEADER = 'x-lumia-client-ip'
export const PROXY_SECRET_HEADER = 'x-lumia-proxy-secret'

function safeEqual(a: string, b: string): boolean {
  const left = Buffer.from(a)
  const right = Buffer.from(b)
  return left.length === right.length && timingSafeEqual(left, right)
}

/**
 * IP declarada por un proxy de confianza. Solo se acepta si la petición trae el secreto compartido
 * (EDGE_PROXY_SECRET) y la IP es sintácticamente válida. Cualquier otro cliente que envíe estas
 * cabeceras es ignorado: no puede elegir su IP.
 */
export function trustedProxyClientIp(request: FastifyRequest, secret: string | undefined): string | null {
  if (!secret) return null
  const provided = request.headers[PROXY_SECRET_HEADER]
  if (typeof provided !== 'string' || !safeEqual(provided, secret)) return null
  const declared = request.headers[CLIENT_IP_HEADER]
  if (typeof declared !== 'string') return null
  const ip = declared.trim()
  return isIP(ip) ? ip : null
}

/**
 * IP del cliente:
 * 1. La que declara un proxy propio autenticado con EDGE_PROXY_SECRET (Worker de la tienda, BFF).
 * 2. Si no, la que calcula Fastify con TRUST_PROXY (proxy-addr): con la API solo accesible por
 *    loopback/Docker y TRUST_PROXY=loopback,uniquelocal, es la IP que añade Cloudflare.
 */
export function getClientIp(request: FastifyRequest): string {
  return trustedProxyClientIp(request, getEnv().EDGE_PROXY_SECRET) ?? request.ip
}

/** Aplicación que inicia la sesión (cabecera X-Lumia-Client: p. ej. "admin"); vacío = tienda. */
export function clientAppOf(request: FastifyRequest): string | undefined {
  const raw = request.headers['x-lumia-client']
  const value = typeof raw === 'string' ? raw.trim().toLowerCase() : ''
  return /^[a-z][a-z0-9-]{0,19}$/.test(value) ? value : undefined
}

export function getClientContext(request: FastifyRequest) {
  return {
    clientApp: clientAppOf(request),
    ip: getClientIp(request),
    userAgent: request.headers['user-agent'] ?? '',
    country: (request.headers['cf-ipcountry'] as string | undefined) ?? null,
    requestId: request.id,
  }
}
