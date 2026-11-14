import { AppError } from '../../../common/errors/app.error.js'
import {
  ALL_PERMISSION_IDS,
  PERMISSION_WILDCARD,
  type PermissionId,
} from '../../../common/permissions/registry.js'

/**
 * Who is changing permissions: the authenticated user and their effective permissions
 * (as resolved by the auth middleware for the current request).
 */
export interface GrantActor {
  userId: string
  permissionKeys: readonly string[]
}

const KNOWN = new Set<string>(ALL_PERMISSION_IDS)

function actorHasAll(actorKeys: ReadonlySet<string>): boolean {
  if (actorKeys.has(PERMISSION_WILDCARD)) return true
  return ALL_PERMISSION_IDS.every((id) => actorKeys.has(id))
}

/**
 * Permissions in `requested` that the actor does not hold. `*` requires holding every
 * permission. Keys that are not registry permissions grant nothing, so they are ignored.
 */
export function findUngrantable(
  actorKeys: readonly string[],
  requested: readonly string[],
): string[] {
  const held = new Set(actorKeys)
  if (actorHasAll(held)) return []
  const missing = new Set<string>()
  for (const key of requested) {
    if (key === PERMISSION_WILDCARD) {
      missing.add(PERMISSION_WILDCARD)
      continue
    }
    if (KNOWN.has(key) && !held.has(key)) missing.add(key)
  }
  return [...missing].sort()
}

/** Rejects (403 PRIVILEGE_ESCALATION) granting any permission the actor does not hold. */
export function assertCanGrant(actor: GrantActor, requested: readonly string[]): void {
  const missing = findUngrantable(actor.permissionKeys, requested)
  if (missing.length > 0) {
    throw new AppError(
      403,
      'No puedes conceder permisos que no tienes',
      'PRIVILEGE_ESCALATION',
      { permissions: missing },
    )
  }
}

/** Rejects (403 SELF_PERMISSION_CHANGE) changing one's own roles or grants. */
export function assertNotSelf(actor: GrantActor, targetUserId: string): void {
  if (actor.userId === targetUserId) {
    throw new AppError(
      403,
      'No puedes cambiar tus propios roles o permisos',
      'SELF_PERMISSION_CHANGE',
    )
  }
}

/** Effective allow keys of a set of permission keys plus inherited ones, minus denied ones. */
export function effectiveAllow(
  allow: readonly string[],
  deny: readonly string[] = [],
): PermissionId[] {
  const denied = new Set(deny.includes(PERMISSION_WILDCARD) ? ALL_PERMISSION_IDS : deny)
  const keys = allow.includes(PERMISSION_WILDCARD)
    ? ALL_PERMISSION_IDS
    : allow.filter((k): k is PermissionId => KNOWN.has(k))
  return [...new Set(keys)].filter((k) => !denied.has(k))
}
