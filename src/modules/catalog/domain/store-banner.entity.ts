import type { ObjectId } from 'mongodb'

export const STORE_BANNER_POSITIONS = [
  'homepage_hero',
  'homepage_secondary',
  'catalog_top',
  'catalog_middle',
  'seasonal',
  'featured',
] as const

export type StoreBannerPosition = (typeof STORE_BANNER_POSITIONS)[number]

export function isStoreBannerPosition(v: string): v is StoreBannerPosition {
  return (STORE_BANNER_POSITIONS as readonly string[]).includes(v)
}

export interface StoreBannerEntity {
  _id?: ObjectId
  active: boolean
  position: StoreBannerPosition
  priority: number
  starts_at: Date
  ends_at: Date
  image_url: string
  title?: string | null
  subtitle?: string | null
  cta_label?: string | null
  cta_href?: string | null
  promotion_id?: string | null
  category_slug?: string | null
  collection_slug?: string | null
  created_at?: Date
  updated_at?: Date
}

export interface PublicStoreBannerDto {
  id: string
  position: StoreBannerPosition
  priority: number
  imageUrl: string
  title: string | null
  subtitle: string | null
  ctaLabel: string | null
  href: string
}
