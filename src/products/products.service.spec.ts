import { ConflictException } from '@nestjs/common';
import { QueryFailedError } from 'typeorm';
import { CreateProductDto } from './dto/create-product.dto';
import { Product, ProductStatus } from './entities/product.entity';
import { getTehranJalaliDateCode, ProductsService } from './products.service';

const SKU_PREFIX = 'BP14050501';

describe('ProductsService product SKU allocation', () => {
  beforeEach(() => {
    jest.useFakeTimers().setSystemTime(new Date('2026-07-22T20:30:00.000Z'));
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it('uses the Persian calendar with Latin digits and the Asia/Tehran date boundary', () => {
    expect(getTehranJalaliDateCode(new Date('2026-07-22T20:29:59.000Z'))).toBe(
      '14050431',
    );
    expect(getTehranJalaliDateCode(new Date('2026-07-22T20:30:00.000Z'))).toBe(
      '14050501',
    );
  });

  it.each([
    ['no product for today', null, '0001'],
    ['an active 0001 product', '1', '0002'],
    ['a soft-deleted 0001 product', '1', '0002'],
    ['existing 0001 and 0003 products', '3', '0004'],
  ])(
    'allocates the next suffix with %s',
    async (_caseName, max, expectedSuffix) => {
      const fixture = createServiceFixture([max]);

      const product = await fixture.service.create(createDto());

      expect(product.sku).toBe(`${SKU_PREFIX}${expectedSuffix}`);
      expect(fixture.queryBuilder.withDeleted).toHaveBeenCalledTimes(1);
      expect(fixture.queryBuilder.select).toHaveBeenCalledWith(
        'MAX(CAST(RIGHT(product.sku, 4) AS integer))',
        'max',
      );
      expect(fixture.queryBuilder.where).toHaveBeenCalledWith(
        'product.sku ~ :skuPattern',
        { skuPattern: `^${SKU_PREFIX}[0-9]{4}$` },
      );
    },
  );

  it('does not filter by status and includes deleted rows in the maximum query', async () => {
    const fixture = createServiceFixture(['4']);

    await fixture.service.create(createDto());

    expect(fixture.queryBuilder.withDeleted).toHaveBeenCalledTimes(1);
    expect(fixture.queryBuilder.where).toHaveBeenCalledTimes(1);
    expect(fixture.queryBuilder.where).toHaveBeenCalledWith(
      'product.sku ~ :skuPattern',
      { skuPattern: `^${SKU_PREFIX}[0-9]{4}$` },
    );
  });

  it('overrides the client SKU and keeps the editor-provided pending status', async () => {
    const fixture = createServiceFixture([null]);

    const product = await fixture.service.create(
      createDto({
        sku: 'BP999999990999',
        status: ProductStatus.PENDING,
      }),
    );

    expect(product).toMatchObject({
      sku: `${SKU_PREFIX}0001`,
      status: ProductStatus.PENDING,
    });
    expect(fixture.transactionalRepository.query).toHaveBeenCalledWith(
      'SELECT pg_advisory_xact_lock(hashtext($1))',
      [SKU_PREFIX],
    );
  });

  it('serializes concurrent creates and allocates distinct SKUs', async () => {
    const storedSequences: number[] = [];
    let previousTransaction = Promise.resolve();
    const transactionalRepository = createTransactionalRepository(null);
    transactionalRepository.createQueryBuilder.mockImplementation(() => {
      const queryBuilder = createQueryBuilder(null);
      queryBuilder.getRawOne.mockImplementation(() =>
        Promise.resolve({
          max:
            storedSequences.length > 0
              ? String(Math.max(...storedSequences))
              : null,
        }),
      );
      return queryBuilder;
    });
    transactionalRepository.save.mockImplementation((product: Product) => {
      storedSequences.push(Number(product.sku.slice(-4)));
      return Promise.resolve(product);
    });
    const dataSource = {
      transaction: jest.fn(
        async (
          callback: (manager: {
            getRepository: () => typeof transactionalRepository;
          }) => Promise<Product>,
        ) => {
          const waitForPrevious = previousTransaction;
          let releaseTransaction: () => void = () => undefined;
          previousTransaction = new Promise<void>((resolve) => {
            releaseTransaction = resolve;
          });
          await waitForPrevious;
          try {
            return await callback({
              getRepository: () => transactionalRepository,
            });
          } finally {
            releaseTransaction();
          }
        },
      ),
    };
    const service = new ProductsService(
      {} as never,
      {} as never,
      dataSource as never,
    );

    const products = await Promise.all([
      service.create(createDto()),
      service.create(createDto()),
    ]);

    expect(products.map((product) => product.sku)).toEqual([
      `${SKU_PREFIX}0001`,
      `${SKU_PREFIX}0002`,
    ]);
    expect(transactionalRepository.query).toHaveBeenCalledTimes(2);
  });

  it('maps PostgreSQL 23505 during create to a safe 409 Conflict', async () => {
    const databaseError = createQueryFailedError('23505');
    const fixture = createServiceFixture([null], databaseError);

    await expect(fixture.service.create(createDto())).rejects.toMatchObject({
      status: 409,
      message: 'Product SKU already exists',
    });
  });

  it('maps PostgreSQL 23505 during update to a safe 409 Conflict', async () => {
    const databaseError = createQueryFailedError('23505');
    const repository = { save: jest.fn().mockRejectedValue(databaseError) };
    const service = new ProductsService(
      repository as never,
      {} as never,
      {} as never,
    );
    jest.spyOn(service, 'findOne').mockResolvedValue({
      id: 'product-id',
      sku: `${SKU_PREFIX}0001`,
      status: ProductStatus.PENDING,
    } as Product);

    await expect(
      service.update('product-id', { sku: `${SKU_PREFIX}0002` }),
    ).rejects.toBeInstanceOf(ConflictException);
    await expect(
      service.update('product-id', { sku: `${SKU_PREFIX}0002` }),
    ).rejects.toThrow('Product SKU already exists');
  });

  it.each(['create', 'update'] as const)(
    'does not convert non-23505 errors during %s',
    async (operation) => {
      const databaseError = createQueryFailedError('23503');
      const fixture = createServiceFixture(
        [null],
        operation === 'create' ? databaseError : undefined,
      );
      jest.spyOn(fixture.service, 'findOne').mockResolvedValue({
        id: 'product-id',
        sku: `${SKU_PREFIX}0001`,
        status: ProductStatus.PENDING,
      } as Product);
      if (operation === 'update') {
        fixture.baseRepository.save.mockRejectedValue(databaseError);
      }

      const result =
        operation === 'create'
          ? fixture.service.create(createDto())
          : fixture.service.update('product-id', { sku: `${SKU_PREFIX}0002` });

      await expect(result).rejects.toBe(databaseError);
    },
  );
});

function createDto(
  overrides: Partial<CreateProductDto> = {},
): CreateProductDto {
  return {
    sku: 'BP000000000001',
    name: 'Test product',
    price: 100,
    stock: 1,
    status: ProductStatus.PENDING,
    ...overrides,
  } as CreateProductDto;
}

function createQueryBuilder(max: string | null) {
  const queryBuilder = {
    withDeleted: jest.fn(),
    select: jest.fn(),
    where: jest.fn(),
    getRawOne: jest.fn(() => Promise.resolve({ max })),
  };
  queryBuilder.withDeleted.mockReturnValue(queryBuilder);
  queryBuilder.select.mockReturnValue(queryBuilder);
  queryBuilder.where.mockReturnValue(queryBuilder);
  return queryBuilder;
}

function createTransactionalRepository(max: string | null, saveError?: Error) {
  const queryBuilder = createQueryBuilder(max);
  return {
    query: jest.fn().mockResolvedValue(undefined),
    createQueryBuilder: jest.fn(() => queryBuilder),
    create: jest.fn((payload: Partial<Product>) => payload as Product),
    save: saveError
      ? jest.fn().mockRejectedValue(saveError)
      : jest.fn((product: Product) => Promise.resolve(product)),
    queryBuilder,
  };
}

function createServiceFixture(
  maxValues: Array<string | null>,
  saveError?: Error,
) {
  const transactionalRepository = createTransactionalRepository(
    maxValues[0] ?? null,
    saveError,
  );
  const baseRepository = { save: jest.fn() };
  const dataSource = {
    transaction: jest.fn(
      (
        callback: (manager: {
          getRepository: () => typeof transactionalRepository;
        }) => Promise<Product>,
      ) => callback({ getRepository: () => transactionalRepository }),
    ),
  };
  return {
    service: new ProductsService(
      baseRepository as never,
      {} as never,
      dataSource as never,
    ),
    baseRepository,
    transactionalRepository,
    queryBuilder: transactionalRepository.queryBuilder,
  };
}

function createQueryFailedError(code: string): QueryFailedError {
  const driverError = Object.assign(new Error('Database write failed'), {
    code,
  });
  return new QueryFailedError('INSERT INTO products', [], driverError);
}
