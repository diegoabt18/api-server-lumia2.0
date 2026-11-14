import { MongoServerError, ObjectId, type Collection, type Db, type Filter, type WithId } from 'mongodb'
import { getCollection } from '../../../../database/repositories/base.repository.js'
import type {
  AutomationStore,
  ExecutionPatch,
  NewExecution,
  NewTask,
  TaskPatch,
} from '../domain/automation.store.js'
import type { ExecutionStatus, LumiExecution, LumiReview, LumiTask, TaskStatus } from '../domain/automation.types.js'
import type { LumiSchedule } from '../domain/schedule.js'

interface TaskDocument {
  _id: ObjectId
  userId: string
  title: string
  description: string | null
  kind: LumiTask['kind']
  status: TaskStatus
  schedule: LumiSchedule
  nextRunAt: Date | null
  lastRunAt: Date | null
  parentTaskId: string | null
  createdAt: Date
  updatedAt: Date
}

interface ReviewDocument {
  _id: ObjectId
  taskId: string
  userId: string
  localDate: string
  reviewedAt: Date | null
  suppressed: boolean
  updatedAt: Date
}

interface ExecutionDocument {
  _id: ObjectId
  occurrenceKey: string
  taskId: string
  userId: string
  scheduledFor: Date
  status: ExecutionStatus
  attempts: number
  nextAttemptAt: Date
  lockedAt: Date | null
  startedAt: Date | null
  finishedAt: Date | null
  error: string | null
  result: string | null
  createdAt: Date
}

const DUPLICATE_KEY = 11000

function taskFrom(doc: WithId<TaskDocument>): LumiTask {
  return {
    id: doc._id.toString(),
    userId: doc.userId,
    title: doc.title,
    description: doc.description,
    kind: doc.kind,
    status: doc.status,
    schedule: doc.schedule,
    nextRunAt: doc.nextRunAt,
    lastRunAt: doc.lastRunAt,
    parentTaskId: doc.parentTaskId ?? null,
    createdAt: doc.createdAt,
    updatedAt: doc.updatedAt,
  }
}

function reviewFrom(doc: ReviewDocument): LumiReview {
  return {
    taskId: doc.taskId,
    userId: doc.userId,
    localDate: doc.localDate,
    reviewedAt: doc.reviewedAt ?? null,
    suppressed: doc.suppressed ?? false,
    updatedAt: doc.updatedAt,
  }
}

function executionFrom(doc: WithId<ExecutionDocument>): LumiExecution {
  return {
    id: doc._id.toString(),
    occurrenceKey: doc.occurrenceKey,
    taskId: doc.taskId,
    userId: doc.userId,
    scheduledFor: doc.scheduledFor,
    status: doc.status,
    attempts: doc.attempts,
    nextAttemptAt: doc.nextAttemptAt,
    lockedAt: doc.lockedAt,
    startedAt: doc.startedAt,
    finishedAt: doc.finishedAt,
    error: doc.error,
    result: doc.result,
    createdAt: doc.createdAt,
  }
}

export class LumiAutomationRepository implements AutomationStore {
  private readonly tasks: Collection<TaskDocument>
  private readonly executions: Collection<ExecutionDocument>
  private readonly reviews: Collection<ReviewDocument>

  constructor(db: Db) {
    this.tasks = getCollection<TaskDocument>(db, 'lumi_tasks')
    this.executions = getCollection<ExecutionDocument>(db, 'lumi_executions')
    this.reviews = getCollection<ReviewDocument>(db, 'lumi_reviews')
  }

  async ensureIndexes(): Promise<void> {
    await this.tasks.createIndexes([
      { key: { userId: 1, status: 1 }, name: 'lumi_tasks_user_status' },
      { key: { status: 1, nextRunAt: 1 }, name: 'lumi_tasks_due' },
    ])
    await this.executions.createIndexes([
      { key: { occurrenceKey: 1 }, name: 'lumi_executions_occurrence_unique', unique: true },
      { key: { status: 1, nextAttemptAt: 1 }, name: 'lumi_executions_queue' },
      { key: { userId: 1, taskId: 1, scheduledFor: -1 }, name: 'lumi_executions_user_task' },
    ])
    await this.reviews.createIndexes([
      { key: { taskId: 1, localDate: 1 }, name: 'lumi_reviews_task_date_unique', unique: true },
    ])
  }

  async findReview(taskId: string, localDate: string): Promise<LumiReview | null> {
    const doc = await this.reviews.findOne({ taskId, localDate })
    return doc ? reviewFrom(doc) : null
  }

  async upsertReview(
    taskId: string,
    userId: string,
    localDate: string,
    patch: { reviewedAt?: Date; suppressed?: boolean },
    now: Date,
  ): Promise<void> {
    await this.reviews.updateOne(
      { taskId, localDate },
      {
        $set: { ...patch, userId, updatedAt: now },
        $setOnInsert: { _id: new ObjectId(), taskId, localDate },
      },
      { upsert: true },
    )
  }


  async createTask(task: NewTask): Promise<string> {
    const now = task.createdAt
    const result = await this.tasks.insertOne({ ...task, _id: new ObjectId(), lastRunAt: null, updatedAt: now })
    return result.insertedId.toString()
  }

  async findTask(id: string): Promise<LumiTask | null> {
    if (!ObjectId.isValid(id)) return null
    const doc = await this.tasks.findOne({ _id: new ObjectId(id) })
    return doc ? taskFrom(doc) : null
  }

  async findTaskForUser(id: string, userId: string): Promise<LumiTask | null> {
    const task = await this.findTask(id)
    return task && task.userId === userId ? task : null
  }

  async listTasksForUser(userId: string, status?: TaskStatus): Promise<LumiTask[]> {
    const docs = await this.tasks
      .find({ userId, ...(status ? { status } : {}) })
      .sort({ nextRunAt: 1, createdAt: -1 })
      .limit(100)
      .toArray()
    return docs.map(taskFrom)
  }

  async countOpenTasksForUser(userId: string): Promise<number> {
    return this.tasks.countDocuments({ userId, status: { $in: ['active', 'paused'] } })
  }

  async updateTaskIf(
    id: string,
    expected: { status?: TaskStatus | TaskStatus[]; nextRunAt?: Date },
    patch: TaskPatch,
  ): Promise<boolean> {
    if (!ObjectId.isValid(id)) return false
    const filter: Filter<TaskDocument> = { _id: new ObjectId(id) }
    if (expected.status !== undefined) {
      filter.status = Array.isArray(expected.status) ? { $in: expected.status } : expected.status
    }
    if (expected.nextRunAt !== undefined) filter.nextRunAt = expected.nextRunAt
    const result = await this.tasks.updateOne(filter, {
      $set: { ...patch, updatedAt: new Date() },
    })
    return result.matchedCount > 0
  }

  async deleteTaskForUser(id: string, userId: string): Promise<boolean> {
    if (!ObjectId.isValid(id)) return false
    const result = await this.tasks.deleteOne({ _id: new ObjectId(id), userId })
    return result.deletedCount > 0
  }

  async findDueTasks(now: Date, limit: number): Promise<LumiTask[]> {
    const docs = await this.tasks
      .find({ status: 'active', nextRunAt: { $lte: now } })
      .sort({ nextRunAt: 1 })
      .limit(limit)
      .toArray()
    return docs.map(taskFrom)
  }

  async insertExecution(execution: NewExecution): Promise<boolean> {
    try {
      await this.executions.insertOne({
        ...execution,
        _id: new ObjectId(),
        status: 'pending',
        attempts: 0,
        lockedAt: null,
        startedAt: null,
        finishedAt: null,
        error: null,
        result: null,
      })
      return true
    } catch (err) {
      if (err instanceof MongoServerError && err.code === DUPLICATE_KEY) return false
      throw err
    }
  }

  async claimExecution(now: Date, maxAttempts: number): Promise<LumiExecution | null> {
    const doc = await this.executions.findOneAndUpdate(
      {
        nextAttemptAt: { $lte: now },
        $or: [
          { status: 'pending' },
          { status: 'failed', attempts: { $lt: maxAttempts } },
        ],
      },
      { $set: { status: 'running', lockedAt: now, startedAt: now }, $inc: { attempts: 1 } },
      { sort: { nextAttemptAt: 1 }, returnDocument: 'after' },
    )
    return doc ? executionFrom(doc) : null
  }

  async updateExecution(id: string, patch: ExecutionPatch): Promise<void> {
    if (!ObjectId.isValid(id)) return
    await this.executions.updateOne({ _id: new ObjectId(id) }, { $set: patch })
  }

  async recoverStaleExecutions(staleBefore: Date, now: Date): Promise<number> {
    const result = await this.executions.updateMany(
      { status: 'running', lockedAt: { $lt: staleBefore } },
      {
        $set: {
          status: 'failed',
          lockedAt: null,
          nextAttemptAt: now,
          error: 'Interrumpida por reinicio del servidor',
        },
      },
    )
    return result.modifiedCount
  }

  async findExecution(id: string): Promise<LumiExecution | null> {
    if (!ObjectId.isValid(id)) return null
    const doc = await this.executions.findOne({ _id: new ObjectId(id) })
    return doc ? executionFrom(doc) : null
  }

  async listExecutionsForUser(
    userId: string,
    taskId: string | undefined,
    limit: number,
  ): Promise<LumiExecution[]> {
    const docs = await this.executions
      .find({ userId, ...(taskId ? { taskId } : {}) })
      .sort({ scheduledFor: -1 })
      .limit(limit)
      .toArray()
    return docs.map(executionFrom)
  }
}
