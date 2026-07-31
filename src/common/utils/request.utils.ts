import type { FastifyRequest } from 'fastify'

export function getClientIp(request: FastifyRequest): string {
  const forwarded = request.headers['x-forwarded-for']
  if (typeof forwarded === 'string') return forwarded.split(',')[0]?.trim() ?? request.ip
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
