import type { FastifyRequest } from 'fastify'

/**
 * IP del cliente según la configuración TRUST_PROXY (Fastify/proxy-addr). No se lee
 * X-Forwarded-For a mano: con proxies de confianza acotados, el cliente no puede falsearla.
 */
export function getClientIp(request: FastifyRequest): string {
  return request.ip
}

export function getClientContext(request: FastifyRequest) {
  return {
    ip: getClientIp(request),
    userAgent: request.headers['user-agent'] ?? '',
    country: (request.headers['cf-ipcountry'] as string | undefined) ?? null,
    requestId: request.id,
  }
}
