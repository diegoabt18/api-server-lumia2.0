import type { Db } from 'mongodb'
import { ObjectId } from 'mongodb'
import { resolvePagingQuery } from '../../../common/utils/pagination.js'
import type { MaterialRepository } from '../infrastructure/material.repository.js'
import type { ProductionAuditRepository } from '../infrastructure/production-audit.repository.js'
import type { RecipeRepository } from '../infrastructure/recipe.repository.js'
import type { SupplierRepository } from '../infrastructure/supplier.repository.js'
import type { ProductionAuditEventType } from '../domain/production-audit.entity.js'

export class ProductionDashboardService {
  constructor(
    private readonly db: Db,
    private readonly materials: MaterialRepository,
    private readonly suppliers: SupplierRepository,
    private readonly recipes: RecipeRepository,
  ) {}

  async getDashboard() {
    const totalMaterials = await this.materials.countAll()
    const activeMaterials = await this.materials.countAll(undefined, undefined, true)
    const totalSuppliers = await this.suppliers.countAll(undefined, true)
    const totalRecipes = await this.recipes.countAll()
    const outdatedSlugs = await this.recipes.getOutdatedProductSlugs()

    const avgCostResult = await this.db
      .collection('recipes')
      .aggregate([
        { $match: { is_active: true } },
        {
          $group: {
            _id: null,
            averageCost: { $avg: '$cached_total_cost' },
            minCost: { $min: '$cached_total_cost' },
            maxCost: { $max: '$cached_total_cost' },
          },
        },
      ])
      .toArray()

    const averageCost = avgCostResult.length > 0 ? Math.round(avgCostResult[0].averageCost ?? 0) : 0
    const minCost = avgCostResult.length > 0 ? Math.round(avgCostResult[0].minCost ?? 0) : 0
    const maxCost = avgCostResult.length > 0 ? Math.round(avgCostResult[0].maxCost ?? 0) : 0

    const oneWeekAgo = new Date()
    oneWeekAgo.setDate(oneWeekAgo.getDate() - 7)
    const weeklyCostChanges = await this.db
      .collection('material_price_history')
      .aggregate([
        { $match: { recorded_at: { $gte: oneWeekAgo } } },
        { $lookup: { from: 'materials', localField: 'material_id', foreignField: '_id', as: 'material' } },
        { $unwind: { path: '$material', preserveNullAndEmptyArrays: true } },
        {
          $project: {
            materialName: '$material.name',
            prevCost: '$material.last_cost',
            newCost: '$unit_cost',
            diff: { $subtract: ['$unit_cost', '$material.last_cost'] },
            recordedAt: '$recorded_at',
          },
        },
        { $sort: { recordedAt: -1 } },
        { $limit: 20 },
      ])
      .toArray()

    const weeklyCostIncrease = weeklyCostChanges.reduce(
      (sum, c) => sum + (typeof c.diff === 'number' && c.diff > 0 ? c.diff : 0),
      0,
    )

    const mostExpensive = await this.db
      .collection('materials')
      .find({ active: true })
      .sort({ last_cost: -1 })
      .limit(10)
      .project({ name: 1, last_cost: 1, purchase_unit: 1 })
      .toArray()

    const recentPriceChanges = await this.db
      .collection('material_price_history')
      .aggregate([
        { $sort: { recorded_at: -1 } },
        { $limit: 20 },
        { $lookup: { from: 'materials', localField: 'material_id', foreignField: '_id', as: 'material' } },
        { $unwind: { path: '$material', preserveNullAndEmptyArrays: true } },
        { $project: { material_id: 1, material_name: '$material.name', unit_cost: 1, recorded_at: 1 } },
      ])
      .toArray()

    const avgCostByCategory = await this.db
      .collection('materials')
      .aggregate([
        { $match: { active: true } },
        { $group: { _id: '$category', averageCost: { $avg: '$last_cost' }, count: { $sum: 1 } } },
        { $sort: { averageCost: -1 } },
      ])
      .toArray()

    return {
      data: {
        totalMaterials,
        activeMaterials,
        totalSuppliers,
        totalRecipes,
        productsWithOutdatedCosts: outdatedSlugs.length,
        pendingApprovals: 0,
        pendingImpacts: 0,
        outdatedVariantsCount: 0,
        averageCost,
        minCost,
        maxCost,
        weeklyCostIncrease,
        weeklyCostChanges: weeklyCostChanges.map((c) => ({
          materialName: c.materialName ?? '—',
          prevCost: c.prevCost ?? 0,
          newCost: c.newCost ?? 0,
          diff: c.diff ?? 0,
          recordedAt: c.recordedAt instanceof Date ? c.recordedAt.toISOString() : '',
        })),
        mostExpensiveMaterials: mostExpensive.map((m) => ({
          id: (m._id as ObjectId).toString(),
          name: m.name,
          lastCost: m.last_cost ?? 0,
          unit: m.purchase_unit,
        })),
        recentlyChangedPrices: recentPriceChanges.map((r) => ({
          materialId: r.material_id?.toString?.() ?? '',
          materialName: r.material_name ?? '',
          unitCost: r.unit_cost ?? 0,
          changedAt: r.recorded_at instanceof Date ? r.recorded_at.toISOString() : '',
        })),
        productsWithOutdatedCostsList: outdatedSlugs.map((slug) => ({ slug, name: slug })),
        averageCostByCategory: avgCostByCategory.map((c) => ({
          category: c._id,
          averageCost: Math.round((c.averageCost ?? 0) * 100) / 100,
          count: c.count,
        })),
        estimatedTotalMaterialValue: mostExpensive.reduce(
          (sum, m) => sum + (typeof m.last_cost === 'number' ? m.last_cost : 0),
          0,
        ),
      },
    }
  }
}

export class ProductionAuditService {
  constructor(private readonly audit: ProductionAuditRepository) {}

  async list(query: Record<string, unknown>) {
    const { page, limit, skip } = resolvePagingQuery(query, { defaultLimit: 20, maxLimit: 100 })
    const result = await this.audit.list({
      eventType: typeof query.eventType === 'string' ? (query.eventType as ProductionAuditEventType) : undefined,
      entityType: typeof query.entityType === 'string' ? query.entityType : undefined,
      entityId: typeof query.entityId === 'string' ? query.entityId : undefined,
      performedBy: typeof query.performedBy === 'string' ? query.performedBy : undefined,
      from: typeof query.from === 'string' ? query.from : undefined,
      to: typeof query.to === 'string' ? query.to : undefined,
      limit,
      offset: skip,
    })
    return {
      data: result.items,
      meta: {
        total: result.total,
        page,
        pageSize: limit,
        totalPages: Math.ceil(result.total / limit) || 1,
      },
    }
  }
}
