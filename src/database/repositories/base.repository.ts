import type { Collection, Db, Document, Filter, OptionalUnlessRequiredId, WithId } from 'mongodb'
import { MongoServerError, ObjectId } from 'mongodb'

export abstract class BaseRepository<T extends Document> {
  constructor(protected readonly collection: Collection<T>) {}

  async findById(id: string): Promise<WithId<T> | null> {
    if (!ObjectId.isValid(id)) return null
    return this.collection.findOne({ _id: new ObjectId(id) } as Filter<T>)
  }

  async findOne(filter: Filter<T>): Promise<WithId<T> | null> {
    return this.collection.findOne(filter)
  }

  async findMany(filter: Filter<T>, options?: { skip?: number; limit?: number; sort?: Document }): Promise<WithId<T>[]> {
    let cursor = this.collection.find(filter)
    if (options?.sort) cursor = cursor.sort(options.sort)
    if (options?.skip) cursor = cursor.skip(options.skip)
    if (options?.limit) cursor = cursor.limit(options.limit)
    return cursor.toArray()
  }

  async count(filter: Filter<T> = {} as Filter<T>): Promise<number> {
    return this.collection.countDocuments(filter)
  }

  async insertOne(doc: OptionalUnlessRequiredId<T>): Promise<string> {
    const result = await this.collection.insertOne(doc)
    return result.insertedId.toString()
  }

  async updateById(id: string, update: Document): Promise<boolean> {
    if (!ObjectId.isValid(id)) return false
    const result = await this.collection.updateOne(
      { _id: new ObjectId(id) } as Filter<T>,
      update,
    )
    return result.modifiedCount > 0 || result.matchedCount > 0
  }

  async deleteById(id: string): Promise<boolean> {
    if (!ObjectId.isValid(id)) return false
    const result = await this.collection.deleteOne({ _id: new ObjectId(id) } as Filter<T>)
    return result.deletedCount > 0
  }

  async ensureIndexes(indexes: Parameters<Collection<T>['createIndexes']>[0]): Promise<void> {
    if (indexes.length === 0) return
    try {
      await this.collection.createIndexes(indexes)
    } catch (err) {
      // Compatibilidad con índices creados por el monolito lumia (misma DB)
      if (err instanceof MongoServerError) {
        const code = typeof err.code === 'number' ? err.code : Number(err.code)
        if ([85, 86, 197].includes(code)) return
      }
      throw err
    }
  }
}

export function getCollection<T extends Document>(db: Db, name: string): Collection<T> {
  return db.collection<T>(name)
}
