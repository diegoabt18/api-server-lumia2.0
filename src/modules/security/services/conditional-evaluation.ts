import type { ConditionalPermissionEntity } from '../domain/enterprise.entities.js'

export type ConditionType = 'time_range' | 'user_attribute' | 'ip_range' | 'day_of_week'
export type ConditionLogic = 'AND' | 'OR'

export interface TimeRangeConfig {
  startTime: string
  endTime: string
  timezone?: string
}

export interface DayOfWeekConfig {
  days: number[]
}

export interface UserAttributeConfig {
  attribute: string
  value: string
  operator: 'eq' | 'neq' | 'contains'
}

export interface IpRangeConfig {
  ranges: string[]
}

export type ConditionConfig =
  | TimeRangeConfig
  | DayOfWeekConfig
  | UserAttributeConfig
  | IpRangeConfig

export interface ConditionClause {
  type: ConditionType
  config: ConditionConfig
}

export interface ConditionContext {
  currentTime: Date
  userId: string
  userAttributes: Record<string, string>
  ip: string | null
}

export class ConditionEvaluationEngine {
  static evaluate(rules: ConditionalPermissionEntity[], ctx: ConditionContext): string[] {
    const matched = new Set<string>()
    for (const rule of rules) {
      if (rule.status !== 'active') continue
      if (rule.appliesToUserId && rule.appliesToUserId !== ctx.userId) continue
      if (this.evaluateConditions(rule.conditions, rule.logic, ctx)) {
        for (const k of rule.permissionKeys) matched.add(k)
      }
    }
    return [...matched]
  }

  static evaluateConditions(
    conditions: ConditionClause[],
    logic: ConditionLogic,
    ctx: ConditionContext,
  ): boolean {
    if (conditions.length === 0) return true
    const results = conditions.map((c) => this.evaluateClause(c, ctx))
    return logic === 'AND' ? results.every(Boolean) : results.some(Boolean)
  }

  static evaluateClause(clause: ConditionClause, ctx: ConditionContext): boolean {
    switch (clause.type) {
      case 'time_range':
        return this.evaluateTimeRange(clause.config as TimeRangeConfig, ctx)
      case 'day_of_week':
        return this.evaluateDayOfWeek(clause.config as DayOfWeekConfig, ctx)
      case 'user_attribute':
        return this.evaluateUserAttribute(clause.config as UserAttributeConfig, ctx)
      case 'ip_range':
        return this.evaluateIpRange(clause.config as IpRangeConfig, ctx)
      default:
        return false
    }
  }

  private static evaluateTimeRange(config: TimeRangeConfig, ctx: ConditionContext): boolean {
    const now = ctx.currentTime
    const [sh, sm] = config.startTime.split(':').map(Number)
    const [eh, em] = config.endTime.split(':').map(Number)
    const mins = now.getHours() * 60 + now.getMinutes()
    const start = sh * 60 + (sm || 0)
    const end = eh * 60 + (em || 0)
    if (start <= end) return mins >= start && mins <= end
    return mins >= start || mins <= end
  }

  private static evaluateDayOfWeek(config: DayOfWeekConfig, ctx: ConditionContext): boolean {
    return config.days.includes(ctx.currentTime.getDay())
  }

  private static evaluateUserAttribute(config: UserAttributeConfig, ctx: ConditionContext): boolean {
    const val = ctx.userAttributes[config.attribute] ?? ''
    switch (config.operator) {
      case 'eq':
        return val === config.value
      case 'neq':
        return val !== config.value
      case 'contains':
        return val.includes(config.value)
      default:
        return false
    }
  }

  private static evaluateIpRange(config: IpRangeConfig, ctx: ConditionContext): boolean {
    if (!ctx.ip) return false
    return config.ranges.some((r) => ctx.ip!.startsWith(r.replace(/\/\d+$/, '')))
  }
}
