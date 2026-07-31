import { ObjectId } from 'mongodb'
import type { ProductionAuditRepository } from '../infrastructure/production-audit.repository.js'
import type { ProductionConfigRepository } from '../infrastructure/production-config.repository.js'

export class ProductionConfigService {
  constructor(
    private readonly config: ProductionConfigRepository,
    private readonly audit: ProductionAuditRepository,
  ) {}

  async get() {
    const data = await this.config.get()
    return { data }
  }

  async update(patch: Record<string, unknown>, userId: string) {
    const prev = await this.config.get()
    const data = await this.config.update(patch, userId)
    await this.audit.insert({
      event_type: 'config_updated',
      entity_type: 'production_config',
      entity_id: 'global_production_config',
      description: 'Configuración de producción actualizada',
      previous_value: prev,
      new_value: data,
      performed_by: ObjectId.isValid(userId) ? new ObjectId(userId) : userId,
      created_at: new Date(),
    })
    return { data }
  }
}
