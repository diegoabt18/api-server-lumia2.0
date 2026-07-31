import { ObjectId } from 'mongodb'
import { AppError } from '../../../common/errors/app.error.js'
import { buildAuthzSnapshot } from '../../../common/permissions/registry.js'
import { buildPaginationMeta, resolvePagingQuery } from '../../../common/utils/pagination.js'
import type { UserRepository } from '../../identity/infrastructure/user.repository.js'
import type { OrderRepository } from '../../sales/infrastructure/order.repository.js'
import type { RoleRepository } from '../../security/infrastructure/role.repository.js'
import type { UserRoleRepository } from '../../security/infrastructure/user-role.repository.js'

export class AdminUsersService {
  constructor(
    private readonly users: UserRepository,
    private readonly orders: OrderRepository,
    private readonly roles: RoleRepository,
    private readonly userRoles: UserRoleRepository,
  ) {}

  async list(query: Record<string, unknown>) {
    const typeRaw = typeof query.type === 'string' ? query.type : 'all'
    const type = typeRaw === 'staff' || typeRaw === 'customers' ? typeRaw : 'all'
    const qParam = typeof query.q === 'string' ? query.q : ''
    const sParam = typeof query.search === 'string' ? query.search : ''
    const combinedSearch = (sParam || qParam).trim()
    const { page, limit, skip, search } = resolvePagingQuery(
      { ...query, search: combinedSearch || undefined },
      { defaultLimit: 30, maxLimit: 100 },
    )
    const { items, total } = await this.users.listAll(skip, limit, { type, search: search || undefined })
    const mapped = items.map((u) => ({
      id: u._id,
      email: u.email,
      name: u.name ?? null,
      nickname: u.nickname ?? null,
      role: u.role,
      isStaff: !!u.isStaff,
      permissionsVersion: u.permissionsVersion ?? 1,
      permissionUpdatedAt: u.permissionUpdatedAt?.toISOString?.() ?? null,
      createdAt: u.createdAt?.toISOString?.() ?? null,
    }))
    return { total, items: mapped, pagination: buildPaginationMeta(total, page, limit) }
  }

  async get(id: string) {
    if (!ObjectId.isValid(id)) throw AppError.badRequest('ID de usuario inválido')
    const user = await this.users.findByIdSafe(id)
    if (!user) throw AppError.notFound('Usuario no encontrado')

    const assignments = await this.userRoles.findByUserId(id)
    const roleIds = [...new Set(assignments.map((a) => a.roleId))]
    const roleDocs = await this.roles.findByIds(roleIds)
    const roles = roleDocs.map((r) => ({ id: r._id, name: r.name, key: r.key }))

    const snap = user.isStaff ? buildAuthzSnapshot(user.role) : { permissionKeys: [] as string[], permHash: '' }

    let orderCount = 0
    let orderTotal = 0
    try {
      orderCount = await this.orders.countByUser(id)
      orderTotal = await this.orders.sumPaidTotalByUser(id)
    } catch {
      // cross-context silencioso
    }

    return {
      user: {
        id,
        email: user.email,
        name: user.name ?? null,
        nickname: user.nickname ?? null,
        role: user.role,
        isStaff: !!user.isStaff,
        provider: user.provider ?? 'local',
        avatar: user.avatar ?? null,
        permissionsVersion: user.permissionsVersion ?? 1,
        permissionUpdatedAt: user.permissionUpdatedAt?.toISOString?.() ?? null,
        createdAt: user.createdAt?.toISOString?.() ?? null,
        shippingAddresses: user.shippingAddresses ?? [],
        notificationPreferences: user.notificationPreferences ?? null,
      },
      roles,
      effectivePermissionKeys: snap.permissionKeys,
      permHash: snap.permHash,
      stats: { orderCount, orderTotal },
    }
  }
}
