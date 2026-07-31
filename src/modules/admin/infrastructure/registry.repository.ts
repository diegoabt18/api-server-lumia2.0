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

  async updatePermission(key: string, patch: Partial<PermissionSeed>): Promise<PermissionSeed | null> {
    const col = getCollection<PermissionSeed & { key: string }>(this.db, 'permissions')
    await col.updateOne({ key }, { $set: patch })
    return col.findOne({ key })
  }

  async syncPermissions(seeds: PermissionSeed[]): Promise<{ inserted: number; updated: number; unchanged: number }> {
    let inserted = 0
    let updated = 0
    let unchanged = 0
    for (const seed of seeds) {
      const result = await this.upsertPermission(seed)
      if (result === 'inserted') inserted++
      else if (result === 'updated') updated++
      else unchanged++
    }
    return { inserted, updated, unchanged }
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
