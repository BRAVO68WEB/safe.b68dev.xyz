/**
 * Baseline migration: represents the current schema state.
 * This migration is safe to run on both fresh and existing databases.
 */
exports.up = async function (knex) {
  // Create tables only if they don't already exist (for fresh installs)
  const hasAlbums = await knex.schema.hasTable('albums')
  if (!hasAlbums) {
    await knex.schema.createTable('albums', table => {
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

  const hasFiles = await knex.schema.hasTable('files')
  if (!hasFiles) {
    await knex.schema.createTable('files', table => {
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

  const hasUsers = await knex.schema.hasTable('users')
  if (!hasUsers) {
    await knex.schema.createTable('users', table => {
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

  // Add columns that were previously handled by scripts/migrate.js
  // These are all idempotent (hasColumn check)

  // files.expirydate
  if (hasFiles && !await knex.schema.hasColumn('files', 'expirydate')) {
    await knex.schema.table('files', table => table.integer('expirydate'))
  }

  // albums columns
  if (hasAlbums) {
    for (const [col, type] of [
      ['editedAt', 'integer'],
      ['zipGeneratedAt', 'integer'],
      ['download', 'integer'],
      ['public', 'integer'],
      ['description', 'string']
    ]) {
      if (!await knex.schema.hasColumn('albums', col)) {
        await knex.schema.table('albums', table => table[type](col))
      }
    }
  }

  // users columns
  if (hasUsers) {
    for (const [col, type] of [
      ['enabled', 'integer'],
      ['permission', 'integer'],
      ['registration', 'integer']
    ]) {
      if (!await knex.schema.hasColumn('users', col)) {
        await knex.schema.table('users', table => table[type](col))
      }
    }
  }
}

exports.down = async function (knex) {
  // Do not drop tables in down migration for safety
  // This is a baseline migration representing existing schema
}
