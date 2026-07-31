import {
  MODULE_SEEDS,
  PERMISSION_SEEDS,
  SERVICE_SEEDS,
  type ModuleSeed,
  type ServiceSeed,
} from '../config/admin-registry.seeds.js'
import type { RegistryRepository } from '../infrastructure/registry.repository.js'

function buildModuleTree(modules: ModuleSeed[], services: ServiceSeed[]) {
  const roots = modules.filter((m) => !m.parentKey)
  return roots.map((mod) => {
    const children = modules.filter((c) => c.parentKey === mod.key)
    return {
      ...mod,
      services: services.filter((s) => s.moduleKey === mod.key),
      children: children.map((child) => ({
        ...child,
        services: services.filter((s) => s.moduleKey === child.key),
      })),
    }
  })
}

export class AdminRegistryService {
  constructor(private readonly registry: RegistryRepository) {}

  async getFullRegistry() {
    const [dbModules, dbPermissions, dbServices] = await Promise.all([
      this.registry.listModules(),
      this.registry.listPermissions(),
      this.registry.listServices(),
    ])
    const modules = dbModules.length ? dbModules : MODULE_SEEDS
    const permissions = dbPermissions.length ? dbPermissions : PERMISSION_SEEDS
    const services = dbServices.length ? dbServices : SERVICE_SEEDS
    return {
      modules: buildModuleTree(modules, services),
      permissions,
      services,
    }
  }

  listModules() {
    return this.registry.listModules().then(async (rows) => ({ modules: rows.length ? rows : MODULE_SEEDS }))
  }

  listServices() {
    return this.registry.listServices().then(async (rows) => ({ services: rows.length ? rows : SERVICE_SEEDS }))
  }

  async upsertModule(input: {
    key: string
    name: string
    description?: string
    icon?: string | null
    route?: string | null
    section?: string | null
    parentKey?: string | null
    order?: number
    isActive?: boolean
  }) {
    const module = await this.registry.upsertModuleFromInput({
      key: input.key,
      name: input.name,
      description: input.description ?? '',
      icon: input.icon ?? null,
      route: input.route ?? null,
      section: input.section ?? null,
      parentKey: input.parentKey ?? null,
      order: input.order ?? 0,
      isActive: input.isActive ?? true,
    })
    return { module }
  }

  async syncFromSeeds() {
    const results = {
      permissionsInserted: 0,
      permissionsUpdated: 0,
      modulesInserted: 0,
      modulesUpdated: 0,
      servicesInserted: 0,
      servicesUpdated: 0,
    }

    for (const seed of PERMISSION_SEEDS) {
      const r = await this.registry.upsertPermission(seed)
      if (r === 'inserted') results.permissionsInserted++
      if (r === 'updated') results.permissionsUpdated++
    }
    for (const seed of MODULE_SEEDS) {
      const r = await this.registry.upsertModule(seed)
      if (r === 'inserted') results.modulesInserted++
      if (r === 'updated') results.modulesUpdated++
    }
    for (const seed of SERVICE_SEEDS) {
      const r = await this.registry.upsertService(seed)
      if (r === 'inserted') results.servicesInserted++
      if (r === 'updated') results.servicesUpdated++
    }

    return {
      success: true,
      message: 'Registry sincronizado exitosamente',
      results,
    }
  }
}
