import type { Db } from 'mongodb'
import { getCollection } from '../../../database/repositories/base.repository.js'
import type { ModuleSeed, PermissionSeed, ServiceSeed } from '../config/admin-registry.seeds.js'

export class RegistryRepository {
  constructor(private readonly db: Db) {}

  async upsertPermission(seed: PermissionSeed): Promise<'inserted' | 'updated' | 'unchanged'> {
    const col = getCollection<PermissionSeed & { key: string }>(this.db, 'permissions')
    const existing = await col.findOne({ key: seed.key })
    if (!existing) {
      await col.insertOne(seed as never)
      return 'inserted'
    }
    if (
      existing.name !== seed.name ||
      existing.description !== seed.description ||
      existing.moduleKey !== seed.moduleKey
    ) {
      await col.updateOne({ key: seed.key }, { $set: seed })
      return 'updated'
    }
    return 'unchanged'
  }

  async upsertModule(seed: ModuleSeed): Promise<'inserted' | 'updated' | 'unchanged'> {
    const col = getCollection<ModuleSeed & { key: string }>(this.db, 'modules')
    const existing = await col.findOne({ key: seed.key })
    if (!existing) {
      await col.insertOne(seed as never)
      return 'inserted'
    }
    if (
      existing.name !== seed.name ||
      existing.route !== seed.route ||
      existing.section !== seed.section ||
      existing.order !== seed.order
    ) {
      await col.updateOne({ key: seed.key }, { $set: seed })
      return 'updated'
    }
    return 'unchanged'
  }

  async upsertService(seed: ServiceSeed): Promise<'inserted' | 'updated' | 'unchanged'> {
    const col = getCollection<ServiceSeed & { key: string }>(this.db, 'services')
    const existing = await col.findOne({ key: seed.key })
    if (!existing) {
      await col.insertOne(seed as never)
      return 'inserted'
    }
    if (
      existing.endpoint !== seed.endpoint ||
      existing.httpMethod !== seed.httpMethod ||
      existing.permissionKey !== seed.permissionKey ||
      existing.moduleKey !== seed.moduleKey
    ) {
      await col.updateOne({ key: seed.key }, { $set: seed })
      return 'updated'
    }
    return 'unchanged'
  }

  async listModules(): Promise<ModuleSeed[]> {
    return getCollection<ModuleSeed>(this.db, 'modules').find({}).sort({ order: 1 }).toArray()
  }

  async listPermissions(): Promise<PermissionSeed[]> {
    return getCollection<PermissionSeed>(this.db, 'permissions').find({}).toArray()
  }

  async findPermissionByKey(key: string): Promise<PermissionSeed | null> {
    return getCollection<PermissionSeed & { key: string }>(this.db, 'permissions').findOne({ key })
  }

  async createPermission(seed: PermissionSeed): Promise<PermissionSeed> {
    const col = getCollection<PermissionSeed & { key: string }>(this.db, 'permissions')
    await col.insertOne(seed as never)
    return seed
  }

  async updatePermission(
    key: string,
    patch: Partial<PermissionSeed>,
  ): Promise<PermissionSeed | null> {
    const col = getCollection<PermissionSeed & { key: string }>(this.db, 'permissions')
    await col.updateOne({ key }, { $set: patch })
    return col.findOne({ key })
  }

  /**
   * Inserta en `permissions` solo los permisos del código que falten. Nunca modifica ni borra
   * un documento existente: la base manda, y la relación permiso-rol vive en los roles, que
   * no se tocan aquí.
   */
  async insertMissingPermissions(seeds: PermissionSeed[]): Promise<number> {
    const col = getCollection<PermissionSeed & { key: string }>(this.db, 'permissions')
    let inserted = 0
    for (const seed of seeds) {
      const { key, ...rest } = seed
      // `key` ya viene del filtro del upsert; solo se fijan los campos al insertar.
      const res = await col.updateOne({ key }, { $setOnInsert: rest }, { upsert: true })
      if (res.upsertedCount > 0) inserted++
    }
    return inserted
  }

  async syncPermissions(
    seeds: PermissionSeed[],
  ): Promise<{ inserted: number; updated: number; unchanged: number }> {
    const inserted = await this.insertMissingPermissions(seeds)
    return { inserted, updated: 0, unchanged: seeds.length - inserted }
  }

  async listServices(): Promise<ServiceSeed[]> {
    return getCollection<ServiceSeed>(this.db, 'services').find({}).toArray()
  }

  async findModuleByKey(key: string): Promise<ModuleSeed | null> {
    return getCollection<ModuleSeed>(this.db, 'modules').findOne({ key })
  }

  async upsertModuleFromInput(input: ModuleSeed): Promise<ModuleSeed> {
    const col = getCollection<ModuleSeed & { key: string }>(this.db, 'modules')
    await col.updateOne({ key: input.key }, { $set: input }, { upsert: true })
    return (await col.findOne({ key: input.key }))!
  }
}
