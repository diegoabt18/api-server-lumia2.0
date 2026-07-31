export interface LaborConceptEntity {
  name: string
  type: 'fixed' | 'per_unit' | 'per_batch'
  time_required: number
  time_unit: 'minutes' | 'hours' | 'seconds'
  value_per_hour: number
  value_per_minute: number
  operator_name?: string
  active: boolean
}

export interface LaborCostEntity {
  _id?: unknown
  recipe_id: unknown
  concepts: LaborConceptEntity[]
  created_at: Date
  updated_at: Date
}

export interface LaborCostDomain {
  id: string
  recipeId: string
  concepts: {
    name: string
    type: 'fixed' | 'per_unit' | 'per_batch'
    timeRequired: number
    timeUnit: 'minutes' | 'hours' | 'seconds'
    valuePerHour: number
    valuePerMinute: number
    operatorName?: string
    active: boolean
  }[]
  createdAt: string
  updatedAt: string
}

export function toLaborCostDomain(entity: LaborCostEntity & { _id?: { toString(): string } }): LaborCostDomain {
  return {
    id: entity._id?.toString?.() ?? '',
    recipeId: (entity.recipe_id as { toString?: () => string })?.toString?.() ?? '',
    concepts: (entity.concepts ?? []).map((c) => ({
      name: c.name,
      type: c.type,
      timeRequired: c.time_required,
      timeUnit: c.time_unit,
      valuePerHour: c.value_per_hour,
      valuePerMinute: c.value_per_minute,
      operatorName: c.operator_name,
      active: c.active,
    })),
    createdAt: entity.created_at?.toISOString?.() ?? '',
    updatedAt: entity.updated_at?.toISOString?.() ?? '',
  }
}

export function buildLaborCostEntity(
  recipeId: string,
  concepts: {
    name: string
    type: 'fixed' | 'per_unit' | 'per_batch'
    timeRequired: number
    timeUnit: 'minutes' | 'hours' | 'seconds'
    valuePerHour: number
    operatorName?: string
    active?: boolean
  }[],
): Omit<LaborCostEntity, '_id'> {
  const now = new Date()
  return {
    recipe_id: recipeId,
    concepts: concepts.map((c) => ({
      name: c.name,
      type: c.type,
      time_required: c.timeRequired,
      time_unit: c.timeUnit,
      value_per_hour: c.valuePerHour,
      value_per_minute: Math.round((c.valuePerHour / 60) * 100) / 100,
      operator_name: c.operatorName,
      active: c.active ?? true,
    })),
    created_at: now,
    updated_at: now,
  }
}
