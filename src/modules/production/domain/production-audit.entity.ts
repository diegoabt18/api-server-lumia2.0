export type ProductionAuditEventType =
  | 'material_updated'
  | 'material_price_changed'
  | 'recipe_created'
  | 'recipe_modified'
  | 'recipe_deleted'
  | 'cost_calculated'
  | 'config_updated'
  | 'price_approved'
  | 'price_rejected'
  | 'price_published'
  | 'impact_resolved'

export interface ProductionAuditEntryEntity {
  _id?: unknown
  event_type: ProductionAuditEventType
  entity_type: string
  entity_id: string
  description: string
  metadata?: Record<string, unknown>
  previous_value?: unknown
  new_value?: unknown
  performed_by: unknown
  ip_address?: string
  created_at: Date
}

export interface ProductionAuditEntryDomain {
  id: string
  eventType: ProductionAuditEventType
  entityType: string
  entityId: string
  description: string
  metadata?: Record<string, unknown>
  previousValue?: unknown
  newValue?: unknown
  performedBy: string
  ipAddress?: string
  createdAt: string
}

export function toProductionAuditDomain(
  entity: ProductionAuditEntryEntity & { _id?: { toString(): string } },
): ProductionAuditEntryDomain {
  return {
    id: entity._id?.toString?.() ?? '',
    eventType: entity.event_type,
    entityType: entity.entity_type,
    entityId: entity.entity_id,
    description: entity.description,
    metadata: entity.metadata,
    previousValue: entity.previous_value,
    newValue: entity.new_value,
    performedBy: (entity.performed_by as { toString?: () => string })?.toString?.() ?? '',
    ipAddress: entity.ip_address,
    createdAt: entity.created_at?.toISOString?.() ?? '',
  }
}
