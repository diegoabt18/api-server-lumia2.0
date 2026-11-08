/**
 * Contrato compartido de respuestas de API. Fuente de verdad: server/shared/contracts.
 * Solo tipos, sin dependencias. No contiene reglas de negocio.
 */

/** Formato de error devuelto por el servidor en todas las rutas. */
export interface ApiErrorResponse {
  error: true
  message: string
  /** Detalles de validación (zod flatten) cuando el mensaje es "Invalid input". */
  details?: unknown
}

/** Paginación de listas administrativas (forma usada por admin). */
export interface AdminPaginationMeta {
  page: number
  limit: number
  total: number
  totalPages: number
  hasNext: boolean
  hasPrev: boolean
}

/**
 * Paginación plana usada por la tienda (reseñas y listas de storefront).
 * Coexiste con AdminPaginationMeta mientras no se migren las pantallas.
 */
export interface StorefrontPaginationMeta {
  page: number
  pages: number
  total: number
}

export interface PaginatedResponse<T, M = AdminPaginationMeta> {
  items: T[]
  pagination: M
}
