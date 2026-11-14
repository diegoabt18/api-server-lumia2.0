import type { InitiativeLevel, InitiativePriority } from './initiative.types.js'

/**
 * Qué iniciativas merecen una notificación inmediata. Las que no la merecen siguen apareciendo en la
 * revisión diaria y en el centro de iniciativas.
 *  - discreta: nunca notifica en el momento.
 *  - equilibrada: notifica solo las urgentes (prioridad 3) y nuevas.
 *  - proactiva: notifica todas las nuevas.
 */
export function shouldNotify(level: InitiativeLevel, priority: InitiativePriority): boolean {
  if (level === 'discreta') return false
  if (level === 'equilibrada') return priority >= 3
  return true
}
