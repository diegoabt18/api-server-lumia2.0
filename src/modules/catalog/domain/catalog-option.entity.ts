import type { ObjectId } from 'mongodb'

export interface ProductOptionAxisEntity {
  _id?: ObjectId
  product_id: ObjectId
  name: string
  position: number
  created_at?: Date
}

export interface ProductOptionValueEntity {
  _id?: ObjectId
  option_id: ObjectId
  value: string
  slug: string
  position: number
  created_at?: Date
}

export interface ProductOptionWithValues {
  id: string
  name: string
  position: number
  values: Array<{
    id: string
    optionId: string
    value: string
    slug: string
    position: number
    createdAt?: string
  }>
}

export interface LegacyProductOption {
  name: string
  values: string[]
}
