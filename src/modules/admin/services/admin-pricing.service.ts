import { AppError } from '../../../common/errors/app.error.js'
import {
  calculatePrice,
  simulateMargins,
  suggestMarginByLevel,
  type PricingConfigInput,
} from '../../production/domain/value-objects/cost-breakdown.vo.js'
import type { ProductionConfigRepository } from '../../production/infrastructure/production-config.repository.js'

function toPricingConfig(config: Awaited<ReturnType<ProductionConfigRepository['get']>>): PricingConfigInput {
  return {
    currency: config.currency,
    priceRounding: config.priceRounding,
    psychologicalRounding: config.psychologicalRounding,
    taxPercentage: config.taxPercentage,
    minimumProfitPercentage: config.minimumProfitPercentage,
    suggestedProfitPercentage: config.suggestedProfitPercentage,
    premiumProfitPercentage: config.premiumProfitPercentage,
    wholesaleProfitPercentage: config.wholesaleProfitPercentage,
    distributorProfitPercentage: config.distributorProfitPercentage,
  }
}

export class AdminPricingService {
  constructor(private readonly config: ProductionConfigRepository) {}

  async calculate(body: Record<string, unknown>) {
    const costTotal = Number(body.costTotal)
    const costPerUnit = Number(body.costPerUnit)
    const marginPercentage = Number(body.marginPercentage)
    if (!Number.isFinite(costTotal) || !Number.isFinite(costPerUnit) || !Number.isFinite(marginPercentage)) {
      throw AppError.badRequest('costTotal, costPerUnit y marginPercentage son requeridos')
    }
    const productionConfig = await this.config.get()
    const pricingConfig = toPricingConfig(productionConfig)
    const result = calculatePrice(costTotal, costPerUnit, marginPercentage, pricingConfig)
    return {
      costTotal: result.costTotal,
      costPerUnit: result.costPerUnit,
      marginPercentage: result.marginPercentage,
      rawPrice: result.rawPrice,
      suggestedPrice: result.suggestedPrice,
      psychologicalPrice: result.psychologicalPrice,
      profitAmount: result.profitAmount,
      profitMarginPercent: result.profitMarginPercent,
      taxAmount: result.taxAmount,
      priceWithTax: result.priceWithTax,
      currency: result.currency,
      rounding: result.rounding,
    }
  }

  async simulate(body: Record<string, unknown>) {
    const costPerUnit = Number(body.costPerUnit)
    if (!Number.isFinite(costPerUnit)) throw AppError.badRequest('costPerUnit es requerido')
    const margins = Array.isArray(body.margins)
      ? body.margins.map((m) => Number(m)).filter((m) => Number.isFinite(m))
      : undefined
    const productionConfig = await this.config.get()
    const pricingConfig = toPricingConfig(productionConfig)
    const results = simulateMargins(costPerUnit, pricingConfig, margins)
    return results.map((r) => ({
      margin: r.marginPercentage,
      suggestedPrice: r.suggestedPrice,
      profit: r.profitAmount,
      profitPercent: r.profitMarginPercent,
      psychologicalPrice: r.psychologicalPrice,
    }))
  }

  async suggestMargin(body: Record<string, unknown>) {
    const costPerUnit = Number(body.costPerUnit)
    if (!Number.isFinite(costPerUnit)) throw AppError.badRequest('costPerUnit es requerido')
    const productionConfig = await this.config.get()
    const pricingConfig = toPricingConfig(productionConfig)
    return suggestMarginByLevel(costPerUnit, pricingConfig)
  }
}
