/**
 * Add token expiry to users and create temp_uploads table.
 */
exports.up = async function (knex) {
  // Add token_expiry column to users table
  const hasTokenExpiry = await knex.schema.hasColumn('users', 'token_expiry')
  if (!hasTokenExpiry) {
    await knex.schema.table('users', table => {
      table.integer('token_expiry').nullable()
    })
  }

  // Create temp_uploads table for anonymous temporary file uploads
  const hasTempUploads = await knex.schema.hasTable('temp_uploads')
  if (!hasTempUploads) {
    await knex.schema.createTable('temp_uploads', table => {
      table.increments()
      table.string('name').notNullable()
      table.string('original').notNullable()
      table.string('type')
      table.string('size')
      table.string('hash')
      table.string('ip')
      table.string('identifier').unique().notNullable()
      table.integer('created_at').notNullable()
      table.integer('expires_at').notNullable()
      table.integer('download_count').defaultTo(0)
    })
  }
}

exports.down = async function (knex) {
  const hasTempUploads = await knex.schema.hasTable('temp_uploads')
  if (hasTempUploads) {
    await knex.schema.dropTable('temp_uploads')
  }

  const hasTokenExpiry = await knex.schema.hasColumn('users', 'token_expiry')
  if (hasTokenExpiry) {
    await knex.schema.table('users', table => {
      table.dropColumn('token_expiry')
    })
  }
}
