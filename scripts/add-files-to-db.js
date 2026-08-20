#!/usr/bin/env node

/**
 * Script to add restored files from uploads/ folder to database
 * Run this after restoring a backup that has files but no database entries
 */

const fs = require('fs')
const path = require('path')
const crypto = require('crypto')

const config = require('../controllers/utils/ConfigManager')
const knex = require('knex')({
  client: config.database.client,
  connection: config.database.connection,
  useNullAsDefault: true,
})

const uploadsDir = path.resolve(config.uploads.folder)

const IMAGE_EXTS = ['.webp', '.jpg', '.jpeg', '.gif', '.png', '.tiff', '.tif', '.svg', '.bmp']
const VIDEO_EXTS = ['.webm', '.mp4', '.wmv', '.avi', '.mov', '.mkv', '.m4v', '.mpeg', '.mpg']
const AUDIO_EXTS = ['.mp3', '.flac', '.ogg', '.m4a', '.aac', '.wav', '.wma']

function getFileType(extname) {
  extname = extname.toLowerCase()
  if (IMAGE_EXTS.includes(extname)) return 'image'
  if (VIDEO_EXTS.includes(extname)) return 'video'
  if (AUDIO_EXTS.includes(extname)) return 'audio'
  return 'binary'
}

function generateIdentifier() {
  return crypto.randomBytes(4).toString('hex')
}

async function addFilesToDatabase() {
  console.log(`Scanning uploads directory: ${uploadsDir}`)

  if (!fs.existsSync(uploadsDir)) {
    console.error('Uploads directory does not exist!')
    process.exit(1)
  }

  const files = fs.readdirSync(uploadsDir).filter(f => {
    const fullPath = path.join(uploadsDir, f)
    return fs.statSync(fullPath).isFile() &&
           !f.startsWith('.') &&
           f !== 'db.sqlite3' &&
           f !== 'db.sqlite3-wal' &&
           f !== 'db.sqlite3-shm'
  })

  console.log(`Found ${files.length} files in uploads directory`)

  const existingFiles = await knex('files').select('name')
  const existingNames = new Set(existingFiles.map(f => f.name))

  let added = 0
  let skipped = 0

  for (const filename of files) {
    if (existingNames.has(filename)) {
      skipped++
      continue
    }

    const filePath = path.join(uploadsDir, filename)
    const stats = fs.statSync(filePath)
    const extname = path.extname(filename)
    const identifier = path.basename(filename, extname)

    await knex('files').insert({
      userid: 1,
      name: filename,
      original: filename,
      type: getFileType(extname),
      size: String(stats.size),
      hash: '',
      ip: '127.0.0.1',
      albumid: null,
      timestamp: Math.floor(stats.mtime.getTime() / 1000),
      expirydate: null,
    })

    added++
    if (added % 100 === 0) {
      console.log(`  Added ${added} files...`)
    }
  }

  console.log(`\nDone!`)
  console.log(`  Added: ${added} files`)
  console.log(`  Skipped: ${skipped} files (already in database)`)
  console.log(`  Total: ${files.length} files`)

  await knex.destroy()
}

addFilesToDatabase().catch(error => {
  console.error('Error:', error.message)
  process.exit(1)
})
