import { ObjectId, type Db } from 'mongodb'
import { getCollection } from '../../../database/repositories/base.repository.js'
import type { ReviewReaction } from './review.repository.js'

export interface QuestionAnswerView {
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

export interface QuestionView {
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
  answers: QuestionAnswerView[]
}

/** Preguntas de producto, sus respuestas y reacciones (sales_db). Solo lo que no está oculto. */
export class QuestionRepository {
  constructor(private readonly db: Db) {}

  private questions() {
    return getCollection(this.db, 'product_questions')
  }
  private answers() {
    return getCollection(this.db, 'product_answers')
  }
  private reactions() {
    return getCollection(this.db, 'question_reactions')
  }

  async ensureIndexes(): Promise<void> {
    await this.questions().createIndexes([{ key: { product_slug: 1, created_at: -1 } }])
    await this.answers().createIndexes([{ key: { question_id: 1, created_at: 1 } }])
    await this.reactions().createIndexes([
      // Sin `name` personalizado: el índice ya existe en producción con el nombre automático.
      { key: { question_id: 1, user_id: 1 }, unique: true },
    ])
  }

  async listForProduct(productSlug: string, page: number, limit: number) {
    const filter = { product_slug: productSlug, hidden: { $ne: true } }
    const skip = (page - 1) * limit
    const [docs, total] = await Promise.all([
      this.questions()
        .find(filter as never)
        .sort({ official_answered: -1, created_at: -1 })
        .skip(skip)
        .limit(limit)
        .toArray(),
      this.questions().countDocuments(filter as never),
    ])

    const ids = docs.map((d) => d._id as ObjectId)
    const answerDocs = ids.length
      ? await this.answers().find({ question_id: { $in: ids } } as never).sort({ created_at: 1 }).toArray()
      : []
    const byQuestion = new Map<string, QuestionAnswerView[]>()
    for (const a of answerDocs) {
      const key = String(a.question_id)
      const list = byQuestion.get(key) ?? []
      list.push({
        id: String(a._id),
        userId: a.user_id,
        userName: a.user_name,
        userAvatar: typeof a.user_avatar === 'string' ? a.user_avatar : '',
        body: a.body,
        official: !!a.official,
        helpfulCount: Number(a.helpful_count ?? 0),
        notHelpfulCount: Number(a.not_helpful_count ?? 0),
        createdAt: new Date(a.created_at).toISOString(),
      })
      byQuestion.set(key, list)
    }

    const questions: QuestionView[] = docs.map((q) => ({
      id: String(q._id),
      userId: q.user_id,
      userName: q.user_name,
      userAvatar: typeof q.user_avatar === 'string' ? q.user_avatar : '',
      body: q.body,
      status: (q.status ?? 'open') as QuestionView['status'],
      officialAnswered: !!q.official_answered,
      helpfulCount: Number(q.helpful_count ?? 0),
      notHelpfulCount: Number(q.not_helpful_count ?? 0),
      createdAt: new Date(q.created_at).toISOString(),
      answers: byQuestion.get(String(q._id)) ?? [],
    }))

    return { questions, total, pages: Math.max(1, Math.ceil(total / limit)) }
  }

  async createQuestion(productSlug: string, user: { id: string; name: string; avatar: string }, body: string) {
    const now = new Date()
    const result = await this.questions().insertOne({
      product_slug: productSlug,
      user_id: user.id,
      user_name: user.name,
      user_avatar: user.avatar,
      body,
      status: 'open',
      official_answered: false,
      helpful_count: 0,
      not_helpful_count: 0,
      hidden: false,
      created_at: now,
      updated_at: now,
    } as never)
    return { id: result.insertedId.toString() }
  }

  /** Devuelve null si la pregunta no existe o está oculta. */
  async createAnswer(
    questionId: string,
    user: { id: string; name: string; avatar: string },
    body: string,
    official: boolean,
  ): Promise<{ id: string } | null> {
    if (!ObjectId.isValid(questionId)) return null
    const qid = new ObjectId(questionId)
    const question = await this.questions().findOne({ _id: qid, hidden: { $ne: true } } as never)
    if (!question) return null
    const now = new Date()
    const result = await this.answers().insertOne({
      question_id: qid,
      user_id: user.id,
      user_name: user.name,
      user_avatar: user.avatar,
      body,
      official,
      helpful_count: 0,
      not_helpful_count: 0,
      created_at: now,
      updated_at: now,
    } as never)
    await this.questions().updateOne(
      { _id: qid } as never,
      { $set: { status: 'answered', updated_at: now, ...(official ? { official_answered: true } : {}) } } as never,
    )
    return { id: result.insertedId.toString() }
  }

  /** Mismo criterio que las reseñas: un voto por usuario y cambio de voto ajusta ambos contadores. */
  async react(questionId: string, userId: string, reaction: ReviewReaction): Promise<boolean> {
    if (!ObjectId.isValid(questionId)) return false
    const qid = new ObjectId(questionId)
    const question = await this.questions().findOne({ _id: qid, hidden: { $ne: true } } as never)
    if (!question) return false

    const existing = await this.reactions().findOne({ question_id: qid, user_id: userId } as never)
    if (existing?.reaction === reaction) return true

    await this.reactions().updateOne(
      { question_id: qid, user_id: userId } as never,
      { $set: { reaction, created_at: new Date() } } as never,
      { upsert: true },
    )
    const inc: Record<string, number> = {}
    if (reaction === 'helpful') {
      inc.helpful_count = 1
      if (existing?.reaction === 'not_helpful') inc.not_helpful_count = -1
    } else {
      inc.not_helpful_count = 1
      if (existing?.reaction === 'helpful') inc.helpful_count = -1
    }
    await this.questions().updateOne({ _id: qid } as never, { $inc: inc } as never)
    return true
  }
}
