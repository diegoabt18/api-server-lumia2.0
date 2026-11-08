/** Contrato de reseñas, preguntas y respuestas de producto. */

export interface ReviewContract {
  id: string
  userId: string
  userName: string
  userAvatar: string
  stars: number
  title: string
  body: string
  verifiedPurchase: boolean
  images: string[]
  helpfulCount: number
  notHelpfulCount: number
  createdAt: string
}

export interface AnswerContract {
  id: string
  userId: string
  userName: string
  userAvatar: string
  body: string
  official: boolean
  helpfulCount: number
  notHelpfulCount: number
  createdAt: string
}

export interface QuestionContract {
  id: string
  userId: string
  userName: string
  userAvatar: string
  body: string
  status: 'open' | 'answered' | 'closed'
  officialAnswered: boolean
  helpfulCount: number
  notHelpfulCount: number
  createdAt: string
  answers: AnswerContract[]
}

/**
 * Respuesta de GET /products/:slug/feedback. Incluye la paginación plana (lumia2.0)
 * y por bloques (Lumia) para no romper ninguno de los dos clientes.
 */
export interface FeedbackListContract {
  rating: { average: number; count: number; distribution: Array<{ stars: number; count: number }> }
  reviews: ReviewContract[]
  questions: QuestionContract[]
  pagination: {
    page: number
    pages: number
    total: number
    reviews: { page: number; limit: number; total: number; pages: number }
    questions: { page: number; limit: number; total: number; pages: number }
  }
}
