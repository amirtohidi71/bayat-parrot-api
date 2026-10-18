import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { DataSource } from 'typeorm';

const DATABASE = 'parrot_listing_disposable_test';
const enabled =
  process.env.PARROT_LISTING_RUN_DB_TESTS === '1' &&
  process.env.PARROT_LISTING_TEST_DATABASE_CONFIRM === 'DISPOSABLE' &&
  Boolean(process.env.PARROT_LISTING_TEST_DATABASE_URL?.trim());

(enabled ? describe : describe.skip)(
  'Ledger runtime privileges on PostgreSQL',
  () => {
    async function disposable(
      run: (source: DataSource) => Promise<void>,
      options = { role: true, table: true },
    ) {
      const target = new URL(process.env.PARROT_LISTING_TEST_DATABASE_URL!);
      if (
        process.env.PARROT_LISTING_RUN_DB_TESTS !== '1' ||
        process.env.PARROT_LISTING_TEST_DATABASE_CONFIRM !== 'DISPOSABLE' ||
        !['postgres:', 'postgresql:'].includes(target.protocol) ||
        !['localhost', '127.0.0.1', '[::1]'].includes(target.hostname) ||
        target.pathname !== `/${DATABASE}` ||
        target.search ||
        target.hash
      )
        throw new Error(
          'Exact loopback disposable database configuration required',
        );
      const adminUrl = new URL(target);
      adminUrl.pathname = '/postgres';
      const administrator = new DataSource({
        type: 'postgres',
        url: adminUrl.toString(),
        synchronize: false,
        logging: false,
        extra: { max: 1 },
      });
      const source = new DataSource({
        type: 'postgres',
        url: target.toString(),
        synchronize: false,
        logging: false,
        extra: { max: 1 },
      });
      let databaseCreated = false;
      let roleCreated = false;
      try {
        await administrator.initialize();
        await assertIdentity(administrator, 'postgres');
        await administrator.query(
          "SELECT pg_advisory_lock(hashtextextended('test:ledger-runtime-role', 0))",
        );
        const [existing] = await administrator.query<
          Array<{ database: boolean; role: boolean }>
        >(
          `SELECT EXISTS(SELECT 1 FROM pg_database WHERE datname = $1) AS database,
         EXISTS(SELECT 1 FROM pg_roles WHERE rolname = 'bayat_app') AS role`,
          [DATABASE],
        );
        if (existing.database || existing.role)
          throw new Error(
            'Disposable database or runtime role already exists; refusing reuse',
          );
        await administrator.query(
          'CREATE DATABASE "parrot_listing_disposable_test"',
        );
        databaseCreated = true;
        await source.initialize();
        await assertIdentity(source, DATABASE);
        if (options.role) {
          await source.query(
            'CREATE ROLE bayat_app NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT',
          );
          roleCreated = true;
        }
        if (options.table)
          await source.query(`CREATE TABLE public.parrot_sale_listing_creation_ledger (
          "listingId" uuid PRIMARY KEY, "sellerUserId" uuid NOT NULL,
          "createdAt" timestamptz NOT NULL, "deletedAt" timestamptz,
          "cleanupCompletedAt" timestamptz)`);
        await run(source);
      } finally {
        try {
          if (source.isInitialized) await source.destroy();
          if (administrator.isInitialized && databaseCreated) {
            await assertIdentity(administrator, 'postgres');
            await administrator.query(
              'DROP DATABASE "parrot_listing_disposable_test"',
            );
            const [remaining] = await administrator.query<
              Array<{ exists: boolean }>
            >(
              'SELECT EXISTS(SELECT 1 FROM pg_database WHERE datname = $1) AS exists',
              [DATABASE],
            );
            expect(remaining.exists).toBe(false);
          }
        } finally {
          try {
            if (administrator.isInitialized && roleCreated) {
              await administrator.query('DROP ROLE bayat_app');
              const [remaining] = await administrator.query<
                Array<{ exists: boolean }>
              >(
                "SELECT EXISTS(SELECT 1 FROM pg_roles WHERE rolname = 'bayat_app') AS exists",
              );
              expect(remaining.exists).toBe(false);
            }
          } finally {
            if (administrator.isInitialized) await administrator.destroy();
          }
        }
      }
    }

    async function migrate(source: DataSource) {
      const sql = await readFile(
        resolve(
          'scripts/migrations/20261019-grant-parrot-listing-ledger-runtime-privileges-v1.sql',
        ),
        'utf8',
      );
      try {
        await source.query(sql.replace(/^\\set[^\r\n]*(?:\r?\n)?/, ''));
      } catch (error) {
        await source.query('ROLLBACK');
        throw error;
      }
    }

    async function assertIdentity(source: DataSource, database: string) {
      const [identity] = await source.query<
        Array<{ database: string; address: string }>
      >(
        'SELECT current_database() AS database, host(inet_server_addr()) AS address',
      );
      if (
        identity.database !== database ||
        !['127.0.0.1', '::1'].includes(identity.address)
      )
        throw new Error('Disposable database identity mismatch');
    }

    it('applies successfully on first run', async () => {
      await disposable(async (source) => {
        await expect(migrate(source)).resolves.toBeUndefined();
      });
    });

    it('reruns idempotently', async () => {
      await disposable(async (source) => {
        await migrate(source);
        await expect(migrate(source)).resolves.toBeUndefined();
      });
    });

    it('grants exactly SELECT/INSERT/UPDATE without ownership or destructive privileges', async () => {
      await disposable(async (source) => {
        await migrate(source);
        for (const privilege of [
          'SELECT',
          'INSERT',
          'UPDATE',
          'DELETE',
          'TRUNCATE',
          'REFERENCES',
          'TRIGGER',
        ]) {
          const [result] = await source.query<Array<{ allowed: boolean }>>(
            "SELECT has_table_privilege('bayat_app', 'public.parrot_sale_listing_creation_ledger', $1) AS allowed",
            [privilege],
          );
          expect(result.allowed).toBe(
            ['SELECT', 'INSERT', 'UPDATE'].includes(privilege),
          );
        }
        const [owner] = await source.query<Array<{ owned: boolean }>>(
          "SELECT tableowner = 'bayat_app' AS owned FROM pg_tables WHERE schemaname = 'public' AND tablename = 'parrot_sale_listing_creation_ledger'",
        );
        expect(owner.owned).toBe(false);
        await source.query('SET ROLE bayat_app');
        try {
          await source.query(`INSERT INTO public.parrot_sale_listing_creation_ledger
          ("listingId", "sellerUserId", "createdAt") VALUES
          ('00000000-0000-4000-8000-000000000001', '00000000-0000-4000-8000-000000000002', CURRENT_TIMESTAMP)`);
          await source.query(
            'UPDATE public.parrot_sale_listing_creation_ledger SET "deletedAt" = CURRENT_TIMESTAMP',
          );
          const rows: unknown[] = await source.query(
            'SELECT * FROM public.parrot_sale_listing_creation_ledger',
          );
          expect(rows).toHaveLength(1);
          await expect(
            source.query(
              'DELETE FROM public.parrot_sale_listing_creation_ledger',
            ),
          ).rejects.toMatchObject({ code: '42501' });
          await expect(
            source.query('TRUNCATE public.parrot_sale_listing_creation_ledger'),
          ).rejects.toMatchObject({ code: '42501' });
        } finally {
          await source.query('RESET ROLE');
        }
      });
    });

    it('fails closed when the runtime role is missing', async () => {
      await disposable(
        async (source) => {
          await expect(migrate(source)).rejects.toThrow(
            'Required ledger runtime role is missing',
          );
        },
        { role: false, table: true },
      );
    });

    it('fails closed when the ledger table is missing', async () => {
      await disposable(
        async (source) => {
          await expect(migrate(source)).rejects.toThrow(
            'Parrot listing creation ledger table is required',
          );
        },
        { role: true, table: false },
      );
    });
  },
);
