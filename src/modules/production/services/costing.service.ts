import { ObjectId } from 'mongodb'
import {
  calculateCostBreakdown,
  calculateSuggestedPrice,
  calculateUnitCost,
} from '../domain/value-objects/cost-breakdown.vo.js'
import type { MaterialRepository } from '../infrastructure/material.repository.js'
import type { ProductionConfigRepository } from '../infrastructure/production-config.repository.js'
import type { ProductionAuditRepository } from '../infrastructure/production-audit.repository.js'
import type { RecipeRepository } from '../infrastructure/recipe.repository.js'
import { UnitConversionService } from './unit-conversion.service.js'

export class CostingService {
  constructor(
    private readonly recipes: RecipeRepository,
    private readonly materials: MaterialRepository,
    private readonly config: ProductionConfigRepository,
    private readonly audit: ProductionAuditRepository,
    private readonly conversion: UnitConversionService,
  ) {}

  async calculateRecipeCost(recipeId: string, userId: string) {
    const recipe = await this.recipes.getById(recipeId)
    if (!recipe) throw new Error(`Receta con id "${recipeId}" no encontrada`)

    const materialIds = recipe.lines.map((l) => l.materialId).filter(Boolean)
    const materialList = await this.materials.getByIds(materialIds)
    const materialMap = new Map(materialList.map((m) => [m.id, m]))

    const lines = await Promise.all(
      recipe.lines.map(async (l) => {
        const mat = materialMap.get(l.materialId)
        if (!mat) {
          return {
            materialId: l.materialId,
            materialName: l.materialName,
            unit: l.unit,
            quantity: l.quantity,
            unitCost: 0,
            partialCost: 0,
          }
        }

        let costValue: number
        const isRollo = mat.purchaseUnit === 'rollo'
        const rolloMeters = l.rolloMeters ?? mat.rollMeters

        if (isRollo && rolloMeters && rolloMeters > 0) {
          if (l.unit === 'rollo') {
            costValue = l.quantity * Math.max(mat.lastCost, 0.001)
          } else {
            const conversion = await this.conversion.convert({
              value: l.quantity,
              fromUnit: l.unit,
              toUnit: 'm',
            })
            const costPerMeter = Math.max(mat.lastCost, 0.001) / rolloMeters
            costValue = conversion.toValue * costPerMeter
          }
        } else {
          const costResult = await this.conversion.calculateCost({
            price: Math.max(mat.lastCost, 0.001),
            purchaseUnit: mat.lastCostUnit || mat.purchaseUnit,
            recipeQuantity: l.quantity,
            recipeUnit: l.unit,
          })
          costValue = costResult.cost
        }

        const unitCost = l.quantity > 0 ? costValue / l.quantity : 0
        return {
          materialId: l.materialId,
          materialName: mat.name,
          unit: l.unit,
          quantity: l.quantity,
          unitCost,
          partialCost: costValue,
        }
      }),
    )

    const breakdown = calculateCostBreakdown(lines, recipe.indirectCosts, recipe.currency)
    const productionConfig = await this.config.get()
    const marginPct = recipe.marginPercentage ?? productionConfig.defaultMarginPercentage

    let suggestedPrice: number | undefined
    if (marginPct > 0) {
      suggestedPrice = calculateSuggestedPrice(
        breakdown.totalCost,
        marginPct,
        productionConfig.priceRounding,
        recipe.currency,
      ).suggestedPrice
    }

    await this.recipes.update(recipeId, {
      cached_materials_cost: breakdown.materialsCost,
      cached_indirect_cost: breakdown.indirectCostTotal,
      cached_total_cost: breakdown.totalCost,
      costs_outdated: false,
      costs_last_calculated_at: new Date(),
      costs_last_calculated_by: ObjectId.isValid(userId) ? new ObjectId(userId) : userId,
      suggested_price: suggestedPrice,
    })

    await this.audit.insert({
      event_type: 'cost_calculated',
      entity_type: 'recipe',
      entity_id: recipeId,
      description: `Costo calculado para receta "${recipe.name}"`,
      metadata: { totalCost: breakdown.totalCost, suggestedPrice },
      performed_by: ObjectId.isValid(userId) ? new ObjectId(userId) : userId,
      created_at: new Date(),
    })

    return {
      success: true as const,
      data: {
        ...breakdown,
        marginPercentage: marginPct,
        suggestedPrice,
        config: {
          defaultMarginPercentage: productionConfig.defaultMarginPercentage,
          priceRounding: productionConfig.priceRounding,
          currency: productionConfig.currency,
        },
      },
    }
  }

  calculateUnitCost(price: number, quantity: number): number {
    return calculateUnitCost(price, quantity)
  }
}
