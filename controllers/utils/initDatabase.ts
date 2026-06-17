import * as crypto from 'crypto'
const logger = require('./../../logger')

const DEFAULT_ROOT_USERNAME = 'root'
const DEFAULT_ROOT_PASSWORD = crypto.randomBytes(16).toString('base64url')

const initDatabase = async (db: any) => {
  await db.schema.hasTable('albums').then((exists: boolean) => {
    if (!exists) {
      return db.schema.createTable('albums', (table: any) => {
        table.increments()
        table.integer('userid')
        table.string('name')
        table.string('identifier')
        table.integer('enabled')
        table.integer('timestamp')
        table.integer('editedAt')
        table.integer('zipGeneratedAt')
        table.integer('download')
        table.integer('public')
        table.string('description')
      })
    }
  })

  await db.schema.hasTable('files').then((exists: boolean) => {
    if (!exists) {
      return db.schema.createTable('files', (table: any) => {
        table.increments()
        table.integer('userid')
        table.string('name')
        table.string('original')
        table.string('type')
        table.string('size')
        table.string('hash')
        table.string('ip')
        table.integer('albumid')
        table.integer('timestamp')
        table.integer('expirydate')
      })
    }
  })

  await db.schema.hasTable('users').then((exists: boolean) => {
    if (!exists) {
      return db.schema.createTable('users', (table: any) => {
        table.increments()
        table.string('username')
        table.string('password')
        table.string('token')
        table.integer('enabled')
        table.integer('timestamp')
        table.integer('permission')
        table.integer('registration')
      })
    }
  })

  const usersCount = await db.table('users')
    .count('id as count')
    .then((rows: any[]) => rows[0].count)

  if (usersCount === 0) {
    const hash = await require('bcrypt').hash(DEFAULT_ROOT_PASSWORD, 10)
    const timestamp = Math.floor(Date.now() / 1000)
    await db.table('users')
      .insert({
        username: DEFAULT_ROOT_USERNAME,
        password: hash,
        token: require('randomstring').generate(64),
        timestamp,
        permission: require('./../permissionController').permissions.superadmin,
        registration: timestamp
      })
    logger.log(`Created user "${DEFAULT_ROOT_USERNAME}" with password "${DEFAULT_ROOT_PASSWORD}".`)
  }
}

export = initDatabase
