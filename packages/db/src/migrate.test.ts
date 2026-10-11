import { describe, expect, it } from 'vitest'
import { listMigrations, sortMigrationFiles } from './migrate'

describe('migrations (smoke)', () => {
  it('orders migration files by name and ignores non-SQL files', () => {
    expect(sortMigrationFiles(['010_b.sql', 'README', '002_a.sql'])).toEqual([
      '002_a.sql',
      '010_b.sql',
    ])
  })

  it('ships the initial schema migration', async () => {
    expect(await listMigrations()).toContain('001_init.sql')
  })
})
