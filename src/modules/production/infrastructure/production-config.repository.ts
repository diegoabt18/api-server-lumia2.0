import type { Db, Filter } from 'mongodb'
import { ObjectId } from 'mongodb'
import { getCollection } from '../../../database/repositories/base.repository.js'
import {
  PRODUCTION_CONFIG_DEFAULTS,
  PRODUCTION_CONFIG_ID,
  toProductionConfigDomain,
  type ProductionConfigDomain,
  type ProductionConfigEntity,
} from '../domain/production-config.entity.js'

export class ProductionConfigRepository {
  private readonly collection: ReturnType<typeof getCollection<ProductionConfigEntity>>

  constructor(db: Db) {
    this.collection = getCollection<ProductionConfigEntity>(db, 'production_config')
  }

  async ensureIndexes(): Promise<void> {
    // Singleton por _id fijo — MongoDB ya indexa _id automáticamente
  }

  async get(): Promise<ProductionConfigDomain> {
    let doc = await this.collection.findOne({ _id: PRODUCTION_CONFIG_ID } as Filter<ProductionConfigEntity>)
    if (!doc) {
      const now = new Date()
      const seed: ProductionConfigEntity = {
        _id: PRODUCTION_CONFIG_ID,
        ...PRODUCTION_CONFIG_DEFAULTS,
        updated_at: now,
      }
      await this.collection.insertOne(seed as never)
      doc = seed
    }
    return toProductionConfigDomain(doc)
  }

  async update(patch: Record<string, unknown>, updatedBy: string): Promise<ProductionConfigDomain> {
    await this.get()
    const $set: Record<string, unknown> = {
      updated_by: ObjectId.isValid(updatedBy) ? new ObjectId(updatedBy) : updatedBy,
      updated_at: new Date(),
    }

    if (patch.defaultMarginPercentage !== undefined) $set.default_margin_percentage = patch.defaultMarginPercentage
    if (patch.currency !== undefined) $set.currency = patch.currency
    if (patch.decimalPlaces !== undefined) $set.decimal_places = patch.decimalPlaces
    if (patch.priceRounding !== undefined) $set.price_rounding = patch.priceRounding
    if (patch.defaultIndirectCosts !== undefined) {
      $set.default_indirect_costs = (patch.defaultIndirectCosts as ProductionConfigEntity['default_indirect_costs']).map(
        (ic) => ({ name: ic.name, type: ic.type, value: ic.value, optional: ic.optional }),
      )
    }
    if (patch.taxPercentage !== undefined) $set.tax_percentage = patch.taxPercentage
    if (patch.minimumProfitPercentage !== undefined) $set.minimum_profit_percentage = patch.minimumProfitPercentage
    if (patch.suggestedProfitPercentage !== undefined) $set.suggested_profit_percentage = patch.suggestedProfitPercentage
    if (patch.premiumProfitPercentage !== undefined) $set.premium_profit_percentage = patch.premiumProfitPercentage
    if (patch.wholesaleProfitPercentage !== undefined) $set.wholesale_profit_percentage = patch.wholesaleProfitPercentage
    if (patch.distributorProfitPercentage !== undefined) $set.distributor_profit_percentage = patch.distributorProfitPercentage
    if (patch.psychologicalRounding !== undefined) $set.psychological_rounding = patch.psychologicalRounding
    if (patch.defaultLaborCostPerHour !== undefined) $set.default_labor_cost_per_hour = patch.defaultLaborCostPerHour
    if (patch.defaultEnergyCostPerHour !== undefined) $set.default_energy_cost_per_hour = patch.defaultEnergyCostPerHour
    if (patch.globalWastePercent !== undefined) $set.global_waste_percent = patch.globalWastePercent

    await this.collection.updateOne({ _id: PRODUCTION_CONFIG_ID } as Filter<ProductionConfigEntity>, { $set })
    return this.get()
  }
}
