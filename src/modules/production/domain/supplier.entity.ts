export interface SupplierEntity {
  _id?: unknown
  name: string
  contact_name?: string
  phone?: string
  email?: string
  notes?: string
  is_favorite: boolean
  active: boolean
  created_at: Date
  updated_at: Date
}

export interface SupplierDomain {
  id: string
  name: string
  contactName?: string
  phone?: string
  email?: string
  notes?: string
  isFavorite: boolean
  active: boolean
  createdAt: string
  updatedAt: string
}

export function toSupplierDomain(entity: SupplierEntity & { _id?: { toString(): string } }): SupplierDomain {
  return {
    id: entity._id?.toString?.() ?? '',
    name: entity.name,
    contactName: entity.contact_name,
    phone: entity.phone,
    email: entity.email,
    notes: entity.notes,
    isFavorite: entity.is_favorite,
    active: entity.active,
    createdAt: entity.created_at?.toISOString?.() ?? '',
    updatedAt: entity.updated_at?.toISOString?.() ?? '',
  }
}

export function toSupplierEntity(input: {
  name: string
  contactName?: string
  phone?: string
  email?: string
  notes?: string
  isFavorite?: boolean
  active?: boolean
}): Omit<SupplierEntity, '_id'> {
  const now = new Date()
  return {
    name: input.name.trim(),
    contact_name: input.contactName?.trim(),
    phone: input.phone?.trim(),
    email: input.email?.trim() || undefined,
    notes: input.notes?.trim(),
    is_favorite: input.isFavorite ?? false,
    active: input.active ?? true,
    created_at: now,
    updated_at: now,
  }
}
