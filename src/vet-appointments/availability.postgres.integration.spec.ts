import {
  ConflictException,
  NotFoundException,
  BadRequestException,
} from '@nestjs/common';
import { randomBytes, randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { DataSource, QueryRunner } from 'typeorm';
import { VET_TEST_ENTITIES } from '../../test/vet-test-entities';
import { VET_ENTITIES } from './vet-appointments.module';
import { VetAvailabilityService } from './availability.service';
import { VetAppointmentSlot } from './entities/appointment-slot.entity';
import { VetAvailabilityWindow } from './entities/availability-window.entity';
import { encryptVetField } from './security/vet-field-encryption';
import { VetAvailabilityStatus, VetSlotStatus } from './vet-appointment.enums';

const enabled =
  process.env.VET_RUN_DB_TESTS === '1' &&
  process.env.VET_TEST_DATABASE_CONFIRM === 'DISPOSABLE';
const describeDatabase = enabled ? describe : describe.skip;
const geometry = {
  startsAt: '2030-01-02T10:00:00Z',
  endsAt: '2030-01-02T11:00:00Z',
  slotDurationMinutes: 15,
  timeZone: 'Asia/Tehran',
};

describeDatabase(
  'Day 2C production availability service real PostgreSQL',
  () => {
    let source: DataSource;
    let service: VetAvailabilityService;
    let suiteLock: QueryRunner | undefined;
    let disposableConfirmed = false;

    beforeAll(async () => {
      const value = process.env.VET_TEST_DATABASE_URL?.trim();
      if (!value) throw new Error('VET_TEST_DATABASE_URL is required');
      const url = new URL(value);
      if (
        url.pathname.slice(1) !== 'vet_appointments_disposable_test' ||
        !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname) ||
        !['postgres:', 'postgresql:'].includes(url.protocol) ||
        url.search ||
        url.hash
      )
        throw new Error(
          'Local dedicated disposable PostgreSQL URL required; no URL options allowed',
        );
      source = new DataSource({
        type: 'postgres',
        url: value,
        entities: VET_TEST_ENTITIES,
        synchronize: false,
        logging: false,
        extra: { max: 12 },
      });
      await source.initialize();
      const [identity] = await source.query<
        Array<{ database: string; address: string }>
      >(
        'SELECT current_database() AS database, host(inet_server_addr()) AS address',
      );
      if (
        identity.database !== 'vet_appointments_disposable_test' ||
        !['127.0.0.1', '::1'].includes(identity.address)
      )
        throw new Error('Disposable database identity mismatch');
      suiteLock = source.createQueryRunner();
      await suiteLock.connect();
      await suiteLock.query(
        "SELECT pg_advisory_lock(hashtextextended('test:vet-postgres-suites', 0))",
      );
      disposableConfirmed = true;
      await dropVetObjects();
      await source.query('CREATE EXTENSION IF NOT EXISTS "uuid-ossp"');
      await source.query(
        'CREATE TABLE IF NOT EXISTS public.users (id uuid PRIMARY KEY)',
      );
      await source.query(
        'CREATE TABLE IF NOT EXISTS public.bird_passports (id uuid PRIMARY KEY)',
      );
      for (const name of [
        '20260907-create-vet-appointments-v1.sql',
        '20260907-enable-vet-availability-replacement.sql',
      ]) {
        const sql = (
          await readFile(
            resolve(process.cwd(), 'scripts/migrations', name),
            'utf8',
          )
        ).replace(/^\\set[^\r\n]*(?:\r?\n)?/, '');
        const runner = source.createQueryRunner();
        await runner.connect();
        try {
          await runner.query(sql);
        } catch (error) {
          await runner.query('ROLLBACK');
          throw error;
        } finally {
          await runner.release();
        }
      }
      service = new VetAvailabilityService(source);
    }, 60_000);

    afterAll(async () => {
      if (!source?.isInitialized) return;
      try {
        if (disposableConfirmed) await dropVetObjects();
      } finally {
        if (suiteLock) {
          try {
            await suiteLock.query(
              "SELECT pg_advisory_unlock(hashtextextended('test:vet-postgres-suites', 0))",
            );
          } finally {
            await suiteLock.release();
          }
        }
        await source.destroy();
      }
    });

    it('creates one complete window and exact slots atomically with offset timestamps', async () => {
      const doctorId = await doctor();
      const result = await service.create(
        {
          ...geometry,
          doctorId,
          startsAt: '2030-01-02T13:30:00+03:30',
          endsAt: '2030-01-02T14:30:00+03:30',
        },
        'test-admin',
      );
      expect(result.slots).toHaveLength(4);
      expect(result.window.startsAt.toISOString()).toBe(
        '2030-01-02T10:00:00.000Z',
      );
      expect(result.slots[3].endsAt).toEqual(result.window.endsAt);
      expect(await counts(doctorId)).toEqual({
        windows: 1,
        active: 1,
        slots: 4,
        usable: 4,
      });
      expect(await service.slots(result.window.id)).toEqual(result.slots);
      expect(await service.read(result.window.id)).toEqual(result.window);
      expect(result.window).not.toHaveProperty('doctor');
    });

    it('rolls back the window and all slots when a real database slot insert fails', async () => {
      const doctorId = await doctor();
      await rejectSlotWrites(doctorId);
      try {
        await expect(
          service.create({ ...geometry, doctorId }, 'test-admin'),
        ).rejects.toThrow(ConflictException);
      } finally {
        await removeSlotFailure();
      }
      expect(await counts(doctorId)).toEqual({
        windows: 0,
        active: 0,
        slots: 0,
        usable: 0,
      });
    });

    it('rejects overlapping active windows but permits exact adjacency', async () => {
      const f = await fixture();
      await expect(
        service.create(
          {
            ...geometry,
            doctorId: f.doctorId,
            startsAt: '2030-01-02T10:30:00Z',
            endsAt: '2030-01-02T11:30:00Z',
          },
          'admin',
        ),
      ).rejects.toThrow(ConflictException);
      await service.create(
        {
          ...geometry,
          doctorId: f.doctorId,
          startsAt: geometry.endsAt,
          endsAt: '2030-01-02T12:00:00Z',
        },
        'admin',
      );
      expect((await counts(f.doctorId)).active).toBe(2);
    });

    it('returns 404 for missing doctor/window and 409 for inactive doctor', async () => {
      await expect(
        service.create({ ...geometry, doctorId: randomUUID() }, 'admin'),
      ).rejects.toThrow(NotFoundException);
      const doctorId = await doctor(false);
      await expect(
        service.create({ ...geometry, doctorId }, 'admin'),
      ).rejects.toThrow(ConflictException);
      await expect(service.read(randomUUID())).rejects.toThrow(
        NotFoundException,
      );
      await expect(service.slots(randomUUID())).rejects.toThrow(
        NotFoundException,
      );
      await expect(service.cancel(randomUUID())).rejects.toThrow(
        NotFoundException,
      );
      await expect(
        service.replace(randomUUID(), geometry, 'admin'),
      ).rejects.toThrow(NotFoundException);
    });

    it('lists deterministically with doctor, status, interval and pagination filters', async () => {
      const f = await fixture();
      await fixture();
      expect(
        await service.list({
          doctorId: f.doctorId,
          from: '2030-01-02T10:30:00Z',
          to: geometry.endsAt,
          limit: 1,
          offset: 0,
        }),
      ).toMatchObject({
        items: [{ id: f.window.id }],
        total: 1,
        limit: 1,
        offset: 0,
      });
      expect(
        (
          await service.list({
            doctorId: f.doctorId,
            from: geometry.endsAt,
            limit: 50,
            offset: 0,
          })
        ).items,
      ).toEqual([]);
      await service.cancel(f.window.id);
      expect(
        (
          await service.list({
            doctorId: f.doctorId,
            status: VetAvailabilityStatus.ACTIVE,
            limit: 50,
            offset: 0,
          })
        ).total,
      ).toBe(0);
      expect(
        (
          await service.list({
            doctorId: f.doctorId,
            status: VetAvailabilityStatus.CANCELLED,
            limit: 50,
            offset: 0,
          })
        ).total,
      ).toBe(1);
      await expect(
        service.list({
          from: geometry.endsAt,
          to: geometry.startsAt,
          limit: 50,
          offset: 0,
        }),
      ).rejects.toThrow(BadRequestException);
    });

    it('cancels AVAILABLE and BLOCKED slots and makes the window terminal', async () => {
      const f = await fixture();
      await source.query(
        "UPDATE public.vet_appointment_slots SET status='BLOCKED' WHERE id=$1",
        [f.slots[0].id],
      );
      expect((await service.cancel(f.window.id)).status).toBe('CANCELLED');
      expect(
        (await service.slots(f.window.id)).every(
          (s) => s.status === VetSlotStatus.CANCELLED,
        ),
      ).toBe(true);
      await expect(service.cancel(f.window.id)).rejects.toThrow(
        ConflictException,
      );
      await expect(service.retire(f.window.id)).rejects.toThrow(
        ConflictException,
      );
      await expect(
        service.replace(f.window.id, geometry, 'admin'),
      ).rejects.toThrow(ConflictException);
      expect((await counts(f.doctorId)).slots).toBe(4);
    });

    it('reuses CANCELLED starts through replacement and leaves original rows attached', async () => {
      const f = await fixture();
      const result = await service.replace(
        f.window.id,
        { ...geometry, slotDurationMinutes: 30 },
        'replacement-admin',
      );
      expect(result.previousWindow.status).toBe('RETIRED');
      expect(result.window.id).not.toBe(f.window.id);
      expect(result.window.createdByAdmin).toBe('replacement-admin');
      expect(result.slots).toHaveLength(2);
      expect(result.slots[0].startsAt).toEqual(f.slots[0].startsAt);
      expect(await counts(f.doctorId)).toEqual({
        windows: 2,
        active: 1,
        slots: 6,
        usable: 2,
      });
      const old = await service.slots(f.window.id);
      expect(old.map((s) => s.id)).toEqual(f.slots.map((s) => s.id));
      expect(old.every((s) => s.status === VetSlotStatus.CANCELLED)).toBe(true);
    });

    it.each(['CONFIRMED', 'COMPLETED', 'NO_SHOW'])(
      'preserves %s appointment, claim, event and occupied slot bytes during replacement',
      async (status) => {
        const f = await fixture();
        const appointmentId = await occupy(f.slots[0].id, f.doctorId);
        if (status !== 'CONFIRMED')
          await source.query(
            'UPDATE public.vet_appointments SET status=$2::varchar,"completedAt"=CASE WHEN $2::varchar=\'COMPLETED\' THEN now() ELSE NULL END WHERE id=$1',
            [appointmentId, status],
          );
        const before = await history(appointmentId, f.slots[0].id);
        const replacement = await service.replace(
          f.window.id,
          geometry,
          'admin',
        );
        expect(replacement.slots).toHaveLength(3);
        expect(replacement.retainedSlots.map((s) => s.id)).toEqual([
          f.slots[0].id,
        ]);
        expect(replacement.slots[0].startsAt).toEqual(f.slots[0].endsAt);
        expect(await history(appointmentId, f.slots[0].id)).toEqual(before);
        await expect(service.retire(f.window.id)).rejects.toThrow(
          ConflictException,
        );
      },
    );

    it('rolls back cancellation completely when an occupied row exists', async () => {
      const f = await fixture();
      await occupy(f.slots[2].id, f.doctorId);
      await expect(service.cancel(f.window.id)).rejects.toThrow(
        ConflictException,
      );
      expect(await service.slots(f.window.id)).toEqual(f.slots);
      expect((await service.read(f.window.id)).status).toBe('ACTIVE');
    });

    it('retirement preserves ended historical slots and cancels future AVAILABLE/BLOCKED slots', async () => {
      const doctorId = await doctor();
      const [{ cutoff }] = await source.query<Array<{ cutoff: Date }>>(
        "SELECT date_trunc('minute', now()) AS cutoff",
      );
      const f = await service.create(
        {
          ...geometry,
          doctorId,
          startsAt: new Date(+cutoff - 60_000).toISOString(),
          endsAt: new Date(+cutoff + 120_000).toISOString(),
          slotDurationMinutes: 1,
        },
        'admin',
      );
      await source.query(
        "UPDATE public.vet_appointment_slots SET status='BLOCKED' WHERE id=$1",
        [f.slots[2].id],
      );
      await service.retire(f.window.id);
      const slots = await service.slots(f.window.id);
      expect(slots[0]).toEqual(f.slots[0]);
      expect(slots.slice(1).map((s) => s.status)).toEqual([
        'CANCELLED',
        'CANCELLED',
      ]);
    });

    it('reuses slots with cancelled appointment history without deleting the appointment or claim', async () => {
      const f = await fixture();
      const appointmentId = await occupy(f.slots[0].id, f.doctorId);
      await source.query(
        'UPDATE public.vet_appointments SET status=\'CANCELLED\',"cancelledAt"=now(),"cancelledByType"=\'ADMIN\',"cancelledById"=\'admin\',"cancellationReason"=\'test\' WHERE id=$1',
        [appointmentId],
      );
      const before = await history(appointmentId);
      const result = await service.replace(f.window.id, geometry, 'admin');
      expect(result.slots).toHaveLength(4);
      expect(await history(appointmentId)).toEqual(before);
    });

    it('rolls back retirement and partial cancellation for incompatible retained grid geometry', async () => {
      const f = await fixture();
      await occupy(f.slots[0].id, f.doctorId);
      await expect(
        service.replace(
          f.window.id,
          { ...geometry, slotDurationMinutes: 30 },
          'admin',
        ),
      ).rejects.toThrow(ConflictException);
      expect(await service.slots(f.window.id)).toEqual(f.slots);
      expect(await counts(f.doctorId)).toEqual({
        windows: 1,
        active: 1,
        slots: 4,
        usable: 4,
      });
    });

    it('rolls back old state and new window when replacement slot generation hits a DB constraint', async () => {
      const f = await fixture();
      await rejectSlotWrites(f.doctorId);
      try {
        await expect(
          service.replace(f.window.id, geometry, 'admin'),
        ).rejects.toThrow(ConflictException);
      } finally {
        await removeSlotFailure();
      }
      expect(await service.slots(f.window.id)).toEqual(f.slots);
      expect(await service.read(f.window.id)).toEqual(f.window);
      expect(await counts(f.doctorId)).toEqual({
        windows: 1,
        active: 1,
        slots: 4,
        usable: 4,
      });
    });

    it('rejects a replacement envelope overlapping another ACTIVE window even if its generated slots would be omitted', async () => {
      const f = await fixture();
      await service.create(
        {
          ...geometry,
          doctorId: f.doctorId,
          startsAt: geometry.endsAt,
          endsAt: '2030-01-02T12:00:00Z',
        },
        'admin',
      );
      await expect(
        service.replace(
          f.window.id,
          { ...geometry, endsAt: '2030-01-02T12:00:00Z' },
          'admin',
        ),
      ).rejects.toThrow(ConflictException);
      expect(await service.slots(f.window.id)).toEqual(f.slots);
      expect((await counts(f.doctorId)).active).toBe(2);
    });

    it('concurrent overlapping creates have exactly one winner', async () => {
      const doctorId = await doctor();
      await race(
        doctorId,
        () => service.create({ ...geometry, doctorId }, 'admin'),
        () => service.create({ ...geometry, doctorId }, 'admin'),
      );
      expect(await counts(doctorId)).toEqual({
        windows: 1,
        active: 1,
        slots: 4,
        usable: 4,
      });
    });

    it('concurrent replacement has exactly one winner and no duplicate usable starts', async () => {
      const f = await fixture();
      await race(
        f.doctorId,
        () => service.replace(f.window.id, geometry, 'admin'),
        () => service.replace(f.window.id, geometry, 'admin'),
      );
      expect(await counts(f.doctorId)).toEqual({
        windows: 2,
        active: 1,
        slots: 8,
        usable: 4,
      });
      const duplicates = await source.query<unknown[]>(
        'SELECT "startsAt" FROM public.vet_appointment_slots WHERE "doctorId"=$1 AND status<>\'CANCELLED\' GROUP BY "startsAt" HAVING count(*)>1',
        [f.doctorId],
      );
      expect(duplicates).toEqual([]);
    });

    it.each([true, false])(
      'replacement/cancellation race fails closed (replacement first=%s)',
      async (replacementFirst) => {
        const f = await fixture();
        const replace = () => service.replace(f.window.id, geometry, 'admin');
        const cancel = () => service.cancel(f.window.id);
        await race(
          f.doctorId,
          replacementFirst ? replace : cancel,
          replacementFirst ? cancel : replace,
        );
        const final = await service.read(f.window.id);
        expect(final.status).toBe(replacementFirst ? 'RETIRED' : 'CANCELLED');
        expect((await counts(f.doctorId)).active).toBe(
          replacementFirst ? 1 : 0,
        );
      },
    );

    it('explicitly uses READ COMMITTED even when the pooled session defaults to REPEATABLE READ', async () => {
      const runner = source.createQueryRunner();
      await runner.connect();
      await runner.query(
        "SET SESSION default_transaction_isolation = 'repeatable read'",
      );
      const release = jest.spyOn(runner, 'release').mockResolvedValue();
      const createRunner = jest
        .spyOn(source, 'createQueryRunner')
        .mockReturnValue(runner);
      const isolation: string[] = [];
      const query = runner.query.bind(runner) as QueryRunner['query'];
      const querySpy = jest
        .spyOn(runner, 'query')
        .mockImplementation(
          async (...args: Parameters<QueryRunner['query']>) => {
            if (
              typeof args[0] === 'string' &&
              args[0].startsWith('SELECT pg_advisory_xact_lock')
            ) {
              const [row] = (await query(
                "SELECT current_setting('transaction_isolation') AS value",
              )) as Array<{ value: string }>;
              isolation.push(row.value);
            }
            return query(...args) as Promise<unknown>;
          },
        );
      try {
        const f = await fixture();
        await service.replace(f.window.id, geometry, 'admin');
        expect(isolation).toEqual(['read committed', 'read committed']);
      } finally {
        querySpy.mockRestore();
        createRunner.mockRestore();
        release.mockRestore();
        await runner.query('RESET default_transaction_isolation');
        await runner.release();
      }
    });

    async function doctor(active = true): Promise<string> {
      const [row] = await source.query<Array<{ id: string }>>(
        'INSERT INTO public.vet_doctors (username,"passwordHash","displayName",mobile,active) VALUES ($1,$2,\'Test Doctor\',$3,$4) RETURNING id',
        [
          'test_' + randomUUID().replace(/-/g, ''),
          '$2b$12$' + 'a'.repeat(53),
          '09' +
            (BigInt('0x' + randomBytes(6).toString('hex')) % 1000000000n)
              .toString()
              .padStart(9, '0'),
          active,
        ],
      );
      return row.id;
    }

    async function fixture() {
      const doctorId = await doctor();
      return {
        doctorId,
        ...(await service.create({ ...geometry, doctorId }, 'test-admin')),
      };
    }

    async function counts(doctorId: string) {
      const windows = await source
        .getRepository(VetAvailabilityWindow)
        .findBy({ doctorId });
      const slots = await source
        .getRepository(VetAppointmentSlot)
        .findBy({ doctorId });
      return {
        windows: windows.length,
        active: windows.filter((w) => w.status === VetAvailabilityStatus.ACTIVE)
          .length,
        slots: slots.length,
        usable: slots.filter((s) => s.status !== VetSlotStatus.CANCELLED)
          .length,
      };
    }

    async function rejectSlotWrites(doctorId: string) {
      // Disposable-only fault injection after earlier grid rows have been processed.
      await source.query(`CREATE FUNCTION public.vet_test_reject_slot() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN IF NEW."doctorId"::text = TG_ARGV[0] AND NEW."startsAt" >= '2030-01-02T10:30:00Z'::timestamptz THEN
      RAISE EXCEPTION 'test generation failure' USING ERRCODE='23514'; END IF; RETURN NEW; END $$`);
      // UUID generated by the fixture, checked before interpolation into DDL.
      if (!/^[0-9a-f-]{36}$/.test(doctorId))
        throw new Error('Invalid fixture id');
      await source.query(
        `CREATE TRIGGER "TRG_vet_test_slot_failure" BEFORE INSERT ON public.vet_appointment_slots FOR EACH ROW EXECUTE FUNCTION public.vet_test_reject_slot('${doctorId}')`,
      );
    }

    async function removeSlotFailure() {
      await source.query(
        'DROP TRIGGER IF EXISTS "TRG_vet_test_slot_failure" ON public.vet_appointment_slots',
      );
      await source.query(
        'DROP FUNCTION IF EXISTS public.vet_test_reject_slot()',
      );
    }

    async function occupy(slotId: string, doctorId: string): Promise<string> {
      const userId = randomUUID();
      const id = randomUUID();
      // Fixture only: the production availability service has no booking/claim flow.
      await source.transaction('READ COMMITTED', async (manager) => {
        await manager.query('INSERT INTO public.users (id) VALUES ($1)', [
          userId,
        ]);
        await manager.query(
          `INSERT INTO public.vet_appointments (id,"publicReference","bookingRequestId","customerUserId","slotId","doctorId",status,"pricingKind","feeAmountMinor",currency,"pricingRuleVersion","ownerFullNameSnapshot","ownerMobileSnapshot","doctorNameSnapshot","nationalIdCiphertext","nationalIdLast4","confirmedAt")
        VALUES ($1,$2,$3,$4,$5,$6,'CONFIRMED','FREE',0,'IRR','vet-first-free-v1','Test Owner','09111111111','Test Doctor',$7,'5678',now())`,
          [
            id,
            'V' + id.replace(/-/g, '').toUpperCase(),
            randomUUID(),
            userId,
            slotId,
            doctorId,
            encryptVetField('0012345678', randomBytes(32), id + ':nationalId'),
          ],
        );
        await manager.query(
          'INSERT INTO public.vet_free_consultation_claims ("policyVersion","subjectType","ownerUserId","appointmentId") VALUES (\'vet-first-free-v1\',\'OWNER\',$1,$2)',
          [userId, id],
        );
        await manager.query(
          'INSERT INTO public.vet_appointment_events ("appointmentId","eventType","eventKey","actorType") VALUES ($1,\'CONFIRMED\',\'test-confirmation\',\'SYSTEM\')',
          [id],
        );
      });
      return id;
    }

    async function history(appointmentId: string, slotId?: string) {
      const rows: unknown[] = [];
      for (const table of [
        'vet_appointments',
        'vet_free_consultation_claims',
        'vet_appointment_events',
      ]) {
        const column = table === 'vet_appointments' ? 'id' : '"appointmentId"';
        rows.push(
          await source.query(
            `SELECT to_jsonb(t) AS row FROM public.${table} t WHERE ${column}=$1 ORDER BY id`,
            [appointmentId],
          ),
        );
      }
      if (slotId)
        rows.push(
          await source.query(
            'SELECT to_jsonb(t) AS row FROM public.vet_appointment_slots t WHERE id=$1',
            [slotId],
          ),
        );
      return rows;
    }

    async function race(
      doctorId: string,
      first: () => Promise<unknown>,
      second: () => Promise<unknown>,
    ) {
      const gate = source.createQueryRunner();
      await gate.connect();
      await gate.startTransaction('READ COMMITTED');
      await gate.query(
        "SELECT pg_advisory_xact_lock(hashtextextended('vet:availability:doctor:' || $1::text, 0))",
        [doctorId],
      );
      const pending: Promise<PromiseSettledResult<unknown>>[] = [];
      const launch = (operation: () => Promise<unknown>) =>
        Promise.allSettled([operation()]).then((rows) => rows[0]);
      try {
        pending.push(launch(first));
        await waitForBlocked(1);
        pending.push(launch(second));
        await waitForBlocked(2);
        await gate.commitTransaction();
        const results = await Promise.all(pending);
        expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
        expect(results.filter((r) => r.status === 'rejected')).toEqual([
          {
            status: 'rejected',
            reason: expect.any(ConflictException) as unknown,
          },
        ]);
      } finally {
        if (gate.isTransactionActive) await gate.rollbackTransaction();
        await gate.release();
        await Promise.all(pending);
      }
    }

    async function waitForBlocked(count: number) {
      const deadline = Date.now() + 4000;
      while (Date.now() < deadline) {
        const [row] = await source.query<Array<{ count: number }>>(
          "SELECT count(*)::int AS count FROM pg_stat_activity WHERE datname=current_database() AND wait_event='advisory' AND query LIKE 'SELECT pg_advisory_xact_lock%'",
        );
        if (row.count >= count) return;
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      throw new Error(
        'Concurrent service transactions did not reach the lock barrier',
      );
    }

    async function dropVetObjects() {
      if (!disposableConfirmed)
        throw new Error('Disposable identity not confirmed');
      for (const entity of [...VET_ENTITIES].reverse()) {
        const table = source.getMetadata(entity).tableName;
        if (!/^vet_[a-z_]+$/.test(table))
          throw new Error('Unsafe fixture table');
        await source.query(`DROP TABLE IF EXISTS public.${table}`);
      }
      for (const name of [
        'vet_guard_slot',
        'vet_guard_window',
        'vet_guard_appointment_update',
        'vet_reject_history_mutation',
        'vet_assert_free_claim',
        'vet_guard_external_record',
        'vet_test_reject_slot',
      ])
        await source.query(`DROP FUNCTION IF EXISTS public.${name}()`);
    }
  },
);
