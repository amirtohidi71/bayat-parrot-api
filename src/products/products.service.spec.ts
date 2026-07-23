import { BadRequestException, ConflictException } from '@nestjs/common';
import { QueryFailedError } from 'typeorm';
import { CreateProductDto } from './dto/create-product.dto';
import {
  PELLET_BASED_TREAT_SUBCATEGORIES,
  PELLET_BASED_TREAT_WEIGHTS,
  ParrotTreatSubCategory,
  SERLAK_WEIGHTS,
} from './config/product-catalog-rules';
import {
  Product,
  ProductCategorySlug,
  ProductStatus,
} from './entities/product.entity';
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

describe('ProductsService product catalog validation', () => {
  beforeEach(() => {
    jest.useFakeTimers().setSystemTime(new Date('2026-07-22T20:30:00.000Z'));
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it.each(SERLAK_WEIGHTS)('creates parrot-serlak with the allowed weight %s', async (weight) => {
    const fixture = createServiceFixture([null]);

    await expect(
      fixture.service.create(createDto({
        categorySlug: ProductCategorySlug.PARROT_SERLAK,
        weight,
      })),
    ).resolves.toMatchObject({
      categorySlug: ProductCategorySlug.PARROT_SERLAK,
      weight,
    });
  });

  it.each(['400g', '1kg'])('rejects parrot-serlak with invalid weight %s', async (weight) => {
    const fixture = createServiceFixture([null]);

    await expect(
      fixture.service.create(createDto({
        categorySlug: ProductCategorySlug.PARROT_SERLAK,
        weight,
      })),
    ).rejects.toMatchObject({
      status: 400,
      message: expect.stringContaining('Invalid weight for parrot-serlak'),
    });
  });

  it('requires weight for parrot-serlak', async () => {
    const fixture = createServiceFixture([null]);

    await expect(
      fixture.service.create(createDto({ categorySlug: ProductCategorySlug.PARROT_SERLAK })),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it.each(
    PELLET_BASED_TREAT_SUBCATEGORIES.flatMap((subCategory) =>
      PELLET_BASED_TREAT_WEIGHTS.map((weight) => [subCategory, weight] as const),
    ),
  )('creates pellet-based treat %s with allowed weight %s', async (subCategory, weight) => {
    const fixture = createServiceFixture([null]);

    await expect(
      fixture.service.create(createDto({
        categorySlug: ProductCategorySlug.PARROT_TREATS,
        subCategory,
        weight,
      })),
    ).resolves.toMatchObject({
      categorySlug: ProductCategorySlug.PARROT_TREATS,
      subCategory,
      weight,
    });
  });

  it.each(
    PELLET_BASED_TREAT_SUBCATEGORIES.flatMap((subCategory) =>
      ['500g', '1000g'].map((weight) => [subCategory, weight] as const),
    ),
  )('rejects pellet-based treat %s with invalid weight %s', async (subCategory, weight) => {
    const fixture = createServiceFixture([null]);

    await expect(
      fixture.service.create(createDto({
        categorySlug: ProductCategorySlug.PARROT_TREATS,
        subCategory,
        weight,
      })),
    ).rejects.toMatchObject({
      status: 400,
      message: expect.stringContaining('Invalid weight for pellet-based parrot treats'),
    });
  });

  it.each([
    ParrotTreatSubCategory.FREEZE_DRIED,
    ParrotTreatSubCategory.PRESTIGE_SNACK,
    ParrotTreatSubCategory.SPRAY_MILLET,
  ])('does not impose pellet weight rules on %s', async (subCategory) => {
    const fixture = createServiceFixture([null]);

    await expect(
      fixture.service.create(createDto({
        categorySlug: ProductCategorySlug.PARROT_TREATS,
        subCategory,
      })),
    ).resolves.toMatchObject({ subCategory });
  });

  it('rejects parrot-treats without a subcategory', async () => {
    const fixture = createServiceFixture([null]);

    await expect(
      fixture.service.create(createDto({ categorySlug: ProductCategorySlug.PARROT_TREATS })),
    ).rejects.toMatchObject({
      status: 400,
      message: 'Subcategory is required for parrot-treats',
    });
  });

  it('rejects an unknown parrot-treats subcategory', async () => {
    const fixture = createServiceFixture([null]);

    await expect(
      fixture.service.create(createDto({
        categorySlug: ProductCategorySlug.PARROT_TREATS,
        subCategory: 'unknown-treat',
      })),
    ).rejects.toMatchObject({
      status: 400,
      message: expect.stringContaining('Invalid parrot-treats subcategory'),
    });
  });

  it('keeps other product categories unaffected', async () => {
    const fixture = createServiceFixture([null]);

    await expect(
      fixture.service.create(createDto({
        categorySlug: ProductCategorySlug.PARROT_FOOD,
        weight: 'legacy-or-custom-weight',
      })),
    ).resolves.toMatchObject({
      categorySlug: ProductCategorySlug.PARROT_FOOD,
      weight: 'legacy-or-custom-weight',
    });
  });

  it('validates a partial PATCH against the merged existing product', async () => {
    const product = existingProduct({
      categorySlug: ProductCategorySlug.PARROT_TREATS,
      subCategory: ParrotTreatSubCategory.PELLET,
      weight: '100g',
    });
    const fixture = createUpdateFixture(product);

    await expect(fixture.service.update(product.id, { weight: '400g' })).resolves.toMatchObject({
      categorySlug: ProductCategorySlug.PARROT_TREATS,
      subCategory: ParrotTreatSubCategory.PELLET,
      weight: '400g',
    });
    expect(fixture.repository.save).toHaveBeenCalledTimes(1);
  });

  it('rejects a partial PATCH whose merged catalog fields are invalid', async () => {
    const product = existingProduct({
      categorySlug: ProductCategorySlug.PARROT_TREATS,
      subCategory: ParrotTreatSubCategory.PELLET,
      weight: '100g',
    });
    const fixture = createUpdateFixture(product);

    await expect(fixture.service.update(product.id, { weight: '500g' })).rejects.toMatchObject({
      status: 400,
    });
    expect(fixture.repository.save).not.toHaveBeenCalled();
  });

  it('allows unrelated PATCH fields on a product with a legacy weight', async () => {
    const product = existingProduct({
      categorySlug: ProductCategorySlug.PARROT_SERLAK,
      weight: '3kg',
    });
    const fixture = createUpdateFixture(product);

    await expect(fixture.service.update(product.id, { name: 'Updated legacy product' }))
      .resolves.toMatchObject({
        name: 'Updated legacy product',
        weight: '3kg',
      });
    expect(fixture.repository.save).toHaveBeenCalledTimes(1);
  });

  it('allows a full PATCH payload when legacy catalog values are unchanged', async () => {
    const product = existingProduct({
      categorySlug: ProductCategorySlug.PARROT_SERLAK,
      subCategory: null as never,
      weight: '3kg',
    });
    const fixture = createUpdateFixture(product);

    await expect(fixture.service.update(product.id, {
      name: 'Updated legacy product',
      categorySlug: ProductCategorySlug.PARROT_SERLAK,
      subCategory: null as never,
      weight: '3kg',
    })).resolves.toMatchObject({
      name: 'Updated legacy product',
      categorySlug: ProductCategorySlug.PARROT_SERLAK,
      subCategory: null,
      weight: '3kg',
    });
    expect(fixture.repository.save).toHaveBeenCalledTimes(1);
  });

  it('does not activate legacy validation when weight is present but unchanged', async () => {
    const product = existingProduct({
      categorySlug: ProductCategorySlug.PARROT_SERLAK,
      weight: '3kg',
    });
    const fixture = createUpdateFixture(product);

    await expect(fixture.service.update(product.id, {
      name: 'Updated legacy product',
      weight: '3kg',
    })).resolves.toMatchObject({
      name: 'Updated legacy product',
      weight: '3kg',
    });
    expect(fixture.repository.save).toHaveBeenCalledTimes(1);
  });

  it('treats null and undefined optional catalog values as equivalent for comparison', async () => {
    const product = existingProduct({
      categorySlug: ProductCategorySlug.PARROT_SERLAK,
      subCategory: undefined,
      weight: '3kg',
    });
    const fixture = createUpdateFixture(product);

    await expect(fixture.service.update(product.id, {
      name: 'Updated legacy product',
      subCategory: null as never,
    })).resolves.toMatchObject({ name: 'Updated legacy product' });
    expect(fixture.repository.save).toHaveBeenCalledTimes(1);
  });

  it('accepts a real legacy weight change when the merged product is valid', async () => {
    const product = existingProduct({
      categorySlug: ProductCategorySlug.PARROT_SERLAK,
      weight: '3kg',
    });
    const fixture = createUpdateFixture(product);

    await expect(fixture.service.update(product.id, { weight: '500g' }))
      .resolves.toMatchObject({ weight: '500g' });
    expect(fixture.repository.save).toHaveBeenCalledTimes(1);
  });

  it('rejects a real legacy weight change when the merged product is invalid', async () => {
    const product = existingProduct({
      categorySlug: ProductCategorySlug.PARROT_SERLAK,
      weight: '3kg',
    });
    const fixture = createUpdateFixture(product);

    await expect(fixture.service.update(product.id, { weight: '400g' }))
      .rejects.toMatchObject({ status: 400 });
    expect(fixture.repository.save).not.toHaveBeenCalled();
  });

  it('validates merged catalog rules when categorySlug actually changes', async () => {
    const product = existingProduct({
      categorySlug: ProductCategorySlug.PARROT_FOOD,
      weight: 'custom-weight',
    });
    const fixture = createUpdateFixture(product);

    await expect(fixture.service.update(product.id, {
      categorySlug: ProductCategorySlug.PARROT_SERLAK,
    })).rejects.toMatchObject({ status: 400 });
    expect(fixture.repository.save).not.toHaveBeenCalled();
  });

  it('validates merged catalog rules when subCategory actually changes', async () => {
    const product = existingProduct({
      categorySlug: ProductCategorySlug.PARROT_TREATS,
      subCategory: ParrotTreatSubCategory.FREEZE_DRIED,
      weight: '500g',
    });
    const fixture = createUpdateFixture(product);

    await expect(fixture.service.update(product.id, {
      subCategory: ParrotTreatSubCategory.PELLET,
    })).rejects.toMatchObject({ status: 400 });
    expect(fixture.repository.save).not.toHaveBeenCalled();
  });
});

describe('ProductsService public category filters', () => {
  it('applies exact category and weight filters while keeping published-only pagination', async () => {
    const fixture = createFilteredQueryFixture();

    const result = await fixture.service.findAllPublished({
      category: ProductCategorySlug.PARROT_SERLAK,
      weight: '100g',
      page: 2,
      limit: 12,
    });

    expect(fixture.queryBuilder.andWhere).toHaveBeenCalledWith(
      'product.status = :status',
      { status: ProductStatus.PUBLISHED },
    );
    expect(fixture.queryBuilder.andWhere).toHaveBeenCalledWith(
      'product.categorySlug = :category',
      { category: ProductCategorySlug.PARROT_SERLAK },
    );
    expect(fixture.queryBuilder.andWhere).toHaveBeenCalledWith(
      'product.weight = :weight',
      { weight: '100g' },
    );
    expect(fixture.queryBuilder.skip).toHaveBeenCalledWith(12);
    expect(fixture.queryBuilder.take).toHaveBeenCalledWith(12);
    expect(result).toEqual({ items: [], total: 0, page: 2, limit: 12 });
  });

  it('applies exact parrot-treats subcategory and weight filters together', async () => {
    const fixture = createFilteredQueryFixture();

    await fixture.service.findAllPublished({
      category: ProductCategorySlug.PARROT_TREATS,
      subCategory: ParrotTreatSubCategory.PELLET,
      weight: '400g',
    });

    expect(fixture.queryBuilder.andWhere).toHaveBeenCalledWith(
      'product.subCategory IN (:...subCategories)',
      { subCategories: [ParrotTreatSubCategory.PELLET] },
    );
    expect(fixture.queryBuilder.andWhere).toHaveBeenCalledWith(
      'product.weight = :weight',
      { weight: '400g' },
    );
  });

  it('does not add a weight predicate when the parameter is absent', async () => {
    const fixture = createFilteredQueryFixture();

    await fixture.service.findAllPublished({ category: ProductCategorySlug.PARROT_FOOD });

    expect(fixture.queryBuilder.andWhere).not.toHaveBeenCalledWith(
      'product.weight = :weight',
      expect.anything(),
    );
  });
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

function existingProduct(overrides: Partial<Product> = {}): Product {
  return {
    id: 'product-id',
    sku: `${SKU_PREFIX}0001`,
    name: 'Existing product',
    status: ProductStatus.PENDING,
    isAmazingOffer: false,
    ...overrides,
  } as Product;
}

function createUpdateFixture(product: Product) {
  const repository = {
    save: jest.fn((savedProduct: Product) => Promise.resolve(savedProduct)),
  };
  const service = new ProductsService(repository as never, {} as never, {} as never);
  jest.spyOn(service, 'findOne').mockResolvedValue(product);
  return { service, repository };
}

function createFilteredQueryFixture() {
  const queryBuilder = {
    andWhere: jest.fn(),
    orderBy: jest.fn(),
    addOrderBy: jest.fn(),
    skip: jest.fn(),
    take: jest.fn(),
    getManyAndCount: jest.fn().mockResolvedValue([[], 0]),
  };
  Object.values(queryBuilder).forEach((method) => {
    if (typeof method === 'function' && method !== queryBuilder.getManyAndCount) {
      method.mockReturnValue(queryBuilder);
    }
  });
  const repository = {
    createQueryBuilder: jest.fn(() => queryBuilder),
  };
  return {
    service: new ProductsService(repository as never, {} as never, {} as never),
    queryBuilder,
  };
}
