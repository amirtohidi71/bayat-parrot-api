/* eslint-disable @typescript-eslint/require-await, @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access -- In-memory Jest repositories intentionally model TypeORM's any-based test boundary. */
import {
  BadRequestException,
  ConflictException,
  NotFoundException,
} from '@nestjs/common';
import { BirdPassportsService } from './bird-passports.service';
import { BirdFeedingRecord } from './entities/bird-feeding-record.entity';
import {
  BirdPassport,
  BirdPassportStatus,
} from './entities/bird-passport.entity';
import { BirdVaccineRecord } from './entities/bird-vaccine-record.entity';
import { BirdVeterinaryVisit } from './entities/bird-veterinary-visit.entity';

function passport(overrides: Partial<BirdPassport> = {}): BirdPassport {
  return Object.assign(new BirdPassport(), {
    id: 'passport-1',
    code: 'B25543210',
    ownerMobile: '09123456789',
    birthDate: '2025-01-01',
    species: 'Parrot',
    subspecies: 'Macaw',
    imagePath: null,
    status: BirdPassportStatus.DRAFT,
    vaccineRecords: [],
    feedingRecords: [],
    veterinaryVisits: [],
    ...overrides,
  });
}

function repository<T extends object>(initial: T[] = []) {
  const rows = [...initial];
  const queryBuilder = {
    orderBy: jest.fn().mockReturnThis(),
    addOrderBy: jest.fn().mockReturnThis(),
    skip: jest.fn().mockReturnThis(),
    take: jest.fn().mockReturnThis(),
    andWhere: jest.fn().mockReturnThis(),
    getManyAndCount: jest.fn(async () => [rows, rows.length] as const),
  };
  return {
    rows,
    queryBuilder,
    createQueryBuilder: jest.fn(() => queryBuilder),
    create: jest.fn((value: Partial<T>) => Object.assign({}, value) as T),
    save: jest.fn(async (value: T) => value),
    remove: jest.fn(async (value: T) => value),
    find: jest.fn(async () => rows),
    findOne: jest.fn(async ({ where, order }: any) => {
      const matches = rows.filter((row: any) =>
        Object.entries(where ?? {}).every(([key, value]) => row[key] === value),
      );
      if (order?.sortOrder === 'DESC') {
        return (
          matches.sort((a: any, b: any) => b.sortOrder - a.sortOrder)[0] ?? null
        );
      }
      return matches[0] ?? null;
    }),
  };
}

function createContext(
  options: { sequence?: string; passports?: BirdPassport[] } = {},
) {
  const passports = repository(options.passports ?? [passport()]);
  const vaccines = repository<BirdVaccineRecord>();
  const feeding = repository<BirdFeedingRecord>();
  const veterinary = repository<BirdVeterinaryVisit>();
  const manager = {
    query: jest.fn(async (query: string, params?: unknown[]) => {
      void params;
      return query.includes('nextval')
        ? [{ nextValue: options.sequence ?? '25543210' }]
        : [];
    }),
    getRepository: jest.fn((entity: unknown) => {
      if (entity === BirdPassport) return passports;
      if (entity === BirdVaccineRecord) return vaccines;
      if (entity === BirdFeedingRecord) return feeding;
      if (entity === BirdVeterinaryVisit) return veterinary;
      throw new Error('Unexpected entity');
    }),
  };
  const dataSource = {
    transaction: jest.fn(async (callback: (value: typeof manager) => unknown) =>
      callback(manager),
    ),
  };
  const service = new BirdPassportsService(
    passports as never,
    dataSource as never,
  );
  return {
    service,
    passports,
    vaccines,
    feeding,
    veterinary,
    manager,
    dataSource,
  };
}

describe('BirdPassportsService', () => {
  const createDto = {
    ownerMobile: '+989123456789',
    birthDate: '2025-01-01',
    species: ' Parrot ',
    subspecies: ' Macaw ',
  };

  it('creates B25543210 from mocked nextval, normalizes mobile and starts as draft', async () => {
    const context = createContext();
    const result = await context.service.create(createDto);

    expect(context.manager.query).toHaveBeenCalledWith(
      `SELECT nextval('public.bird_passport_code_seq')::text AS "nextValue"`,
    );
    expect(result).toMatchObject({
      code: 'B25543210',
      ownerMobile: '09123456789',
      status: BirdPassportStatus.DRAFT,
      imagePath: null,
      species: 'Parrot',
      subspecies: 'Macaw',
    });
    expect(result).not.toHaveProperty('accessToken');
  });

  it('does not accept client code, status or imagePath through the create DTO shape', async () => {
    const context = createContext();
    const input = {
      ...createDto,
      code: 'B99999999',
      status: BirdPassportStatus.ACTIVE,
      imagePath: '/unsafe',
    };
    const result = await context.service.create(input);
    expect(result.code).toBe('B25543210');
    expect(result.status).toBe(BirdPassportStatus.DRAFT);
    expect(result.imagePath).toBeNull();
  });

  it('rejects a future birthDate before opening a transaction', async () => {
    const context = createContext();
    expect(() =>
      context.service.create({ ...createDto, birthDate: '2999-01-01' }),
    ).toThrow(BadRequestException);
    expect(context.dataSource.transaction).not.toHaveBeenCalled();
  });

  it('updates only allowed fields and preserves immutable code/status/imagePath', async () => {
    const row = passport({ imagePath: '/private/image.webp' });
    const context = createContext({ passports: [row] });
    const result = await context.service.updatePassport(row.id, {
      ownerMobile: '۰۹۹۱۲۳۴۵۶۷۸',
      species: ' Cockatoo ',
    });
    expect(result).toMatchObject({
      code: 'B25543210',
      ownerMobile: '09912345678',
      species: 'Cockatoo',
      status: BirdPassportStatus.DRAFT,
      imagePath: '/private/image.webp',
    });
  });

  it('rejects activation without imagePath', async () => {
    const context = createContext();
    await expect(
      context.service.activatePassport('passport-1'),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('activates a complete passport', async () => {
    const row = passport({ imagePath: '/private/image.webp' });
    const context = createContext({ passports: [row] });
    const result = await context.service.activatePassport(row.id);
    expect(result.status).toBe(BirdPassportStatus.ACTIVE);
  });

  it('archives without deleting data and makes the passport read-only', async () => {
    const row = passport({
      vaccineRecords: [Object.assign(new BirdVaccineRecord(), { id: 'v1' })],
    });
    const context = createContext({ passports: [row] });
    const result = await context.service.archivePassport(row.id);
    expect(result.status).toBe(BirdPassportStatus.ARCHIVED);
    expect(result.vaccineRecords).toHaveLength(1);
    expect(context.passports.remove).not.toHaveBeenCalled();
    await expect(
      context.service.updatePassport(row.id, { species: 'Other' }),
    ).rejects.toBeInstanceOf(ConflictException);
  });

  it('adds, updates and deletes a vaccine with automatic sortOrder', async () => {
    const context = createContext();
    context.vaccines.rows.push(
      Object.assign(new BirdVaccineRecord(), {
        id: 'old',
        passportId: 'passport-1',
        sortOrder: 2,
      }),
    );
    const added = await context.service.addVaccine('passport-1', {
      vaccineName: ' Vaccine A ',
      vaccinationDate: '2026-01-02',
    });
    expect(added).toMatchObject({ vaccineName: 'Vaccine A', sortOrder: 3 });
    context.vaccines.rows.push(Object.assign(added, { id: 'v1' }));
    const updated = await context.service.updateVaccine('passport-1', 'v1', {
      vaccineName: 'Vaccine B',
    });
    expect(updated).toMatchObject({
      vaccineName: 'Vaccine B',
      sortOrder: 3,
    });
    await context.service.deleteVaccine('passport-1', 'v1');
    expect(context.vaccines.remove).toHaveBeenCalledWith(updated);
  });

  it('adds, updates and deletes a feeding record', async () => {
    const context = createContext();
    const added = await context.service.addFeeding('passport-1', {
      ageRange: '0-3 months',
      description: 'Formula',
    });
    context.feeding.rows.push(Object.assign(added, { id: 'f1' }));
    const updated = await context.service.updateFeeding('passport-1', 'f1', {
      description: 'Seeds',
    });
    expect(updated.description).toBe('Seeds');
    await context.service.deleteFeeding('passport-1', 'f1');
    expect(context.feeding.remove).toHaveBeenCalledWith(updated);
  });

  it('adds, updates and deletes a veterinary visit', async () => {
    const context = createContext();
    const added = await context.service.addVeterinaryVisit('passport-1', {
      visitDate: '2026-01-01',
      clinicalNotes: 'Healthy',
      veterinaryActions: 'Checkup',
    });
    context.veterinary.rows.push(Object.assign(added, { id: 'visit-1' }));
    const updated = await context.service.updateVeterinaryVisit(
      'passport-1',
      'visit-1',
      {
        clinicalNotes: 'Very healthy',
      },
    );
    expect(updated.clinicalNotes).toBe('Very healthy');
    await context.service.deleteVeterinaryVisit('passport-1', 'visit-1');
    expect(context.veterinary.remove).toHaveBeenCalledWith(updated);
  });

  it('rejects update/delete when a child belongs to another passport', async () => {
    const context = createContext();
    context.vaccines.rows.push(
      Object.assign(new BirdVaccineRecord(), {
        id: 'v-other',
        passportId: 'passport-other',
        sortOrder: 0,
      }),
    );
    await expect(
      context.service.updateVaccine('passport-1', 'v-other', {
        vaccineName: 'X',
      }),
    ).rejects.toBeInstanceOf(NotFoundException);
    await expect(
      context.service.deleteVaccine('passport-1', 'v-other'),
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  it('has no SMS/Auth dependency or login side effect', () => {
    const context = createContext();
    expect(Object.keys(context.service)).not.toContain('smsService');
    expect(Object.keys(context.service)).not.toContain('jwtService');
    expect(Object.keys(context.service)).not.toContain('usersService');
  });

  it.each([
    [{ ...createDto, species: '   ' }, 'species'],
    [{ ...createDto, subspecies: '   ' }, 'subspecies'],
  ])('rejects whitespace-only create fields', (input, field) => {
    const context = createContext();
    expect(() => context.service.create(input)).toThrow(`${field} is required`);
    expect(context.dataSource.transaction).not.toHaveBeenCalled();
  });

  it.each([{ species: '   ' }, { subspecies: '   ' }])(
    'rejects whitespace-only update fields',
    async (dto) => {
      const context = createContext();
      await expect(
        context.service.updatePassport('passport-1', dto),
      ).rejects.toBeInstanceOf(BadRequestException);
    },
  );

  it('trims Persian species values', async () => {
    const context = createContext();
    const result = await context.service.create({
      ...createDto,
      species: '  کاسکو  ',
      subspecies: '  دم قرمز  ',
    });
    expect(result.species).toBe('کاسکو');
    expect(result.subspecies).toBe('دم قرمز');
  });

  it.each([
    ['missing', undefined],
    ['non-numeric', 'not-a-number'],
    ['decimal-like string', '25543210.0'],
    ['whitespace-padded string', ' 25543210 '],
    ['below range', '25543209'],
    ['above range', '100000000'],
    ['unsafe numeric', '9007199254740993'],
  ])(
    'rejects %s sequence response without fallback',
    async (_label, sequence) => {
      const context = createContext({ sequence: sequence as string });
      if (sequence === undefined)
        context.manager.query.mockResolvedValueOnce([]);
      await expect(context.service.create(createDto)).rejects.toThrow(
        'Bird passport code sequence returned an invalid value',
      );
      expect(context.manager.query).toHaveBeenCalledTimes(1);
      expect(context.passports.save).not.toHaveBeenCalled();
    },
  );

  it('propagates save failure after one sequence allocation without retry or repair', async () => {
    const context = createContext();
    const failure = new Error('database save failed');
    context.passports.save.mockRejectedValueOnce(failure);
    await expect(context.service.create(createDto)).rejects.toBe(failure);
    expect(context.manager.query).toHaveBeenCalledTimes(1);
    expect(context.manager.query.mock.calls[0][0]).toContain('nextval');
  });

  it.each([
    ['ownerMobile', '   '],
    ['birthDate', '   '],
    ['species', '   '],
    ['subspecies', '   '],
    ['imagePath', '   '],
  ])('rejects activation when %s has no real value', async (field, value) => {
    const row = passport({ imagePath: '/private/image.webp', [field]: value });
    const context = createContext({ passports: [row] });
    await expect(
      context.service.activatePassport(row.id),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('uses pessimistic_write before mutating a passport', async () => {
    const context = createContext();
    await context.service.updatePassport('passport-1', { species: 'Cockatoo' });
    expect(context.passports.findOne).toHaveBeenCalledWith(
      expect.objectContaining({ lock: { mode: 'pessimistic_write' } }),
    );
  });

  it('takes row lock before advisory lock and automatic-order lookup', async () => {
    const context = createContext();
    const events: string[] = [];
    context.passports.findOne.mockImplementationOnce(async () => {
      events.push('passport-row-lock');
      return context.passports.rows[0];
    });
    context.manager.query.mockImplementationOnce(async () => {
      events.push('advisory-lock');
      return [];
    });
    context.vaccines.findOne.mockImplementationOnce(async () => {
      events.push('max-sort-read');
      return null as never;
    });
    await context.service.addVaccine('passport-1', {
      vaccineName: 'A',
      vaccinationDate: '2026-01-01',
    });
    expect(events).toEqual([
      'passport-row-lock',
      'advisory-lock',
      'max-sort-read',
    ]);
  });

  it('uses distinct advisory namespaces by record type and passport', async () => {
    const context = createContext({
      passports: [
        passport(),
        passport({ id: 'passport-2', code: 'B25543211' }),
      ],
    });
    await context.service.addVaccine('passport-1', {
      vaccineName: 'A',
      vaccinationDate: '2026-01-01',
    });
    await context.service.addFeeding('passport-1', {
      ageRange: 'adult',
      description: 'Seeds',
    });
    await context.service.addVeterinaryVisit('passport-1', {
      visitDate: '2026-01-01',
      clinicalNotes: 'OK',
      veterinaryActions: 'Check',
    });
    await context.service.addFeeding('passport-2', {
      ageRange: 'adult',
      description: 'Seeds',
    });
    const keys = context.manager.query.mock.calls
      .filter(([query]) => String(query).includes('pg_advisory_xact_lock'))
      .map(([, params]) => params?.[0]);
    expect(new Set(keys).size).toBe(4);
  });

  it('routes concurrent automatic adds through the advisory lock path', async () => {
    const context = createContext();
    await Promise.all([
      context.service.addFeeding('passport-1', {
        ageRange: 'young',
        description: 'Formula',
      }),
      context.service.addFeeding('passport-1', {
        ageRange: 'adult',
        description: 'Seeds',
      }),
    ]);
    const lockCalls = context.manager.query.mock.calls.filter(([query]) =>
      String(query).includes('pg_advisory_xact_lock'),
    );
    expect(lockCalls).toHaveLength(2);
  });

  it('rejects every mutation path for an archived passport', async () => {
    const row = passport({ status: BirdPassportStatus.ARCHIVED });
    const context = createContext({ passports: [row] });
    const mutations: Array<() => Promise<unknown>> = [
      () => context.service.updatePassport(row.id, { species: 'X' }),
      () => context.service.activatePassport(row.id),
      () => context.service.archivePassport(row.id),
      () =>
        context.service.addVaccine(row.id, {
          vaccineName: 'A',
          vaccinationDate: '2026-01-01',
        }),
      () => context.service.updateVaccine(row.id, 'v1', { vaccineName: 'A' }),
      () => context.service.deleteVaccine(row.id, 'v1'),
      () =>
        context.service.addFeeding(row.id, {
          ageRange: 'adult',
          description: 'Seeds',
        }),
      () =>
        context.service.updateFeeding(row.id, 'f1', { description: 'Seeds' }),
      () => context.service.deleteFeeding(row.id, 'f1'),
      () =>
        context.service.addVeterinaryVisit(row.id, {
          visitDate: '2026-01-01',
          clinicalNotes: 'OK',
          veterinaryActions: 'Check',
        }),
      () =>
        context.service.updateVeterinaryVisit(row.id, 'visit-1', {
          clinicalNotes: 'OK',
        }),
      () => context.service.deleteVeterinaryVisit(row.id, 'visit-1'),
    ];
    for (const mutation of mutations) {
      await expect(mutation()).rejects.toBeInstanceOf(ConflictException);
    }
  });

  it('keeps listPassports lightweight without child relations', async () => {
    const context = createContext();
    await context.service.listPassports();
    expect(context.passports.find).toHaveBeenCalledWith({
      order: { createdAt: 'DESC' },
    });
  });

  it('paginates and filters the admin list in the database query', async () => {
    const context = createContext();
    const result = await context.service.listPassportsAdmin({
      page: 2,
      limit: 10,
      status: BirdPassportStatus.DRAFT,
      search: ' B255 ',
    });
    expect(context.passports.queryBuilder.skip).toHaveBeenCalledWith(10);
    expect(context.passports.queryBuilder.take).toHaveBeenCalledWith(10);
    expect(context.passports.queryBuilder.andWhere).toHaveBeenCalledWith(
      'passport.status = :status',
      { status: BirdPassportStatus.DRAFT },
    );
    expect(context.passports.queryBuilder.andWhere).toHaveBeenCalledWith(
      expect.stringContaining("passport.ownerMobile ILIKE :search ESCAPE '\\'"),
      { search: '%B255%' },
    );
    expect(result).toMatchObject({ total: 1, page: 2, limit: 10 });
  });

  it.each([
    ['percent', '100%', '%100\\%%'],
    ['underscore', 'A_B', '%A\\_B%'],
    ['backslash', 'A\\B', '%A\\\\B%'],
    ['SQL-like text', "%' OR 1=1 --", "%\\%' OR 1=1 --%"],
  ])(
    'escapes %s as literal data in the parameterized admin search',
    async (_label, search, expected) => {
      const context = createContext();
      await context.service.listPassportsAdmin({ page: 1, limit: 20, search });
      const [, parameters] =
        context.passports.queryBuilder.andWhere.mock.calls[0];
      expect(parameters).toEqual({ search: expected });
      expect(
        context.passports.queryBuilder.andWhere.mock.calls[0][0],
      ).not.toContain(search);
    },
  );

  it('trims admin search and skips a whitespace-only search', async () => {
    const trimmed = createContext();
    await trimmed.service.listPassportsAdmin({
      page: 1,
      limit: 20,
      search: '  Macaw  ',
    });
    expect(trimmed.passports.queryBuilder.andWhere).toHaveBeenCalledWith(
      expect.any(String),
      { search: '%Macaw%' },
    );
    const blank = createContext();
    await blank.service.listPassportsAdmin({
      page: 1,
      limit: 20,
      search: '   ',
    });
    expect(blank.passports.queryBuilder.andWhere).not.toHaveBeenCalled();
  });

  it('defensively rejects direct service searches over 100 characters', async () => {
    await expect(
      createContext().service.listPassportsAdmin({
        page: 1,
        limit: 20,
        search: 'x'.repeat(101),
      }),
    ).rejects.toThrow('exceeds 100 characters');
  });
});
