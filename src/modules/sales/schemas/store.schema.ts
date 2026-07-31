import { z } from 'zod'

export const submitReviewSchema = z.object({
  stars: z.number().min(1).max(5),
  title: z.string().trim().max(200).optional(),
  body: z.string().trim().min(3).max(4000),
})

export const newsletterSubscribeSchema = z.object({
  email: z.string().trim().email().max(200),
})

export const favoritesSyncSchema = z.object({
  slugs: z.array(z.string().trim().min(1)).max(30),
})

export const favoritesToggleSchema = z.object({
  productSlug: z.string().trim().min(1),
})
