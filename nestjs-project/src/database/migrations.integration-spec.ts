import { DataSource } from 'typeorm';
import { User } from '../users/entities/user.entity';
import { Channel } from '../channels/entities/channel.entity';
import { RefreshToken } from '../auth/entities/refresh-token.entity';
import { VerificationToken } from '../auth/entities/verification-token.entity';
import { CreateUsersAndChannels1775687773260 } from './migrations/1775687773260-CreateUsersAndChannels';
import { CreateAuthTokens1777579850478 } from './migrations/1777579850478-CreateAuthTokens';
import {
  cleanAllTables,
  createTestDataSource,
} from '../test/create-test-data-source';

const MANAGED_TABLES = [
  'users',
  'channels',
  'refresh_tokens',
  'verification_tokens',
];

const MANAGED_MIGRATIONS = [
  CreateUsersAndChannels1775687773260,
  CreateAuthTokens1777579850478,
];

// Owned by CreateAuthTokens — dropping "verification_tokens" does not drop the
// enum type its "type" column uses, so it survives as an orphan and blocks the
// next CREATE TYPE with "type already exists" unless removed explicitly.
const MANAGED_ENUM_TYPES = ['verification_tokens_type_enum'];

interface ExternalForeignKey {
  tableName: string;
  constraintName: string;
  definition: string;
}

describe('Database migrations (integration)', () => {
  let dataSource: DataSource;
  let externalForeignKeys: ExternalForeignKey[];

  beforeAll(async () => {
    dataSource = createTestDataSource(
      [User, Channel, RefreshToken, VerificationToken],
      {
        synchronize: false,
        migrations: MANAGED_MIGRATIONS,
      },
    );

    await dataSource.initialize();

    // A prior suite in the same run may leave rows in tables outside this
    // test's scope (e.g. "videos") whose FK still points at a "channels"/
    // "users" row. Re-adding the external FK captured below validates all
    // existing data, so orphaned leftovers from another suite would make
    // that ALTER TABLE fail — clear them first, same helper every other
    // integration/e2e suite already uses to reset shared state.
    await cleanAllTables(dataSource);

    // Migrations outside this test's scope (e.g. phase-03's CreateVideos) may
    // have added foreign keys into these tables. Dropping "channels"/"users"
    // with CASCADE silently removes just the FK constraint on the other side
    // (Postgres cascades the constraint, not the referencing table), so it
    // must be captured here and restored in afterAll — otherwise the shared
    // dev DB is left with a permanently missing constraint after this suite
    // runs.
    externalForeignKeys = await dataSource.query<ExternalForeignKey[]>(
      `SELECT
         conrelid::regclass::text AS "tableName",
         conname AS "constraintName",
         pg_get_constraintdef(oid) AS definition
       FROM pg_constraint
       WHERE contype = 'f'
         AND confrelid::regclass::text = ANY($1::text[])
         AND conrelid::regclass::text != ALL($1::text[])`,
      [MANAGED_TABLES],
    );

    // Sequential, not Promise.all: concurrent DROP TABLE ... CASCADE statements
    // across tables with FKs between them can deadlock in Postgres.
    for (const table of MANAGED_TABLES) {
      await dataSource.query(`DROP TABLE IF EXISTS "${table}" CASCADE`);
    }
    for (const enumType of MANAGED_ENUM_TYPES) {
      await dataSource.query(`DROP TYPE IF EXISTS "${enumType}"`);
    }

    // Only this test's own migration records — other migrations (e.g.
    // phase-03's CreateVideos) must stay tracked as applied, since this test
    // never touches their tables/types and can't recreate them.
    const [{ exists: migrationsTableExists }] = await dataSource.query<
      { exists: boolean }[]
    >(`SELECT to_regclass('public.migrations') IS NOT NULL AS exists`);
    if (migrationsTableExists) {
      const managedMigrationNames = MANAGED_MIGRATIONS.map(
        (Migration) => new Migration().name,
      );
      await dataSource.query(
        `DELETE FROM "migrations" WHERE name = ANY($1::text[])`,
        [managedMigrationNames],
      );
    }
  });

  afterAll(async () => {
    // The second test undoes the last migration, leaving token tables missing.
    // Re-apply so the shared DB is fully migrated when subsequent suites run.
    await dataSource.runMigrations();

    for (const fk of externalForeignKeys) {
      await dataSource.query(
        `ALTER TABLE "${fk.tableName}" ADD CONSTRAINT "${fk.constraintName}" ${fk.definition}`,
      );
    }

    await dataSource.destroy();
  });

  it('should apply all migrations and create all four tables', async () => {
    const ranMigrations = await dataSource.runMigrations();

    expect(ranMigrations).toHaveLength(2);

    const result = await dataSource.query<{ table_name: string }[]>(
      `SELECT table_name FROM information_schema.tables
       WHERE table_schema = 'public'
         AND table_name = ANY($1::text[])
       ORDER BY table_name`,
      [MANAGED_TABLES],
    );
    const tableNames = result.map((r) => r.table_name);
    expect(tableNames).toEqual([
      'channels',
      'refresh_tokens',
      'users',
      'verification_tokens',
    ]);
  });

  it('should revert the last migration and remove token tables', async () => {
    await dataSource.undoLastMigration();

    const result = await dataSource.query<{ table_name: string }[]>(
      `SELECT table_name FROM information_schema.tables
       WHERE table_schema = 'public'
         AND table_name = ANY($1::text[])`,
      [['refresh_tokens', 'verification_tokens']],
    );
    expect(result).toHaveLength(0);
  });
});
