import { HttpException } from '@nestjs/common';
import {
  Product,
  ProductCategorySlug,
  ProductStatus,
} from '../products/entities/product.entity';
import { ParrotSaleListingErrorCode } from './parrot-sale-listing.errors';
import { ParrotSaleListingOptionsService } from './parrot-sale-listing-options.service';

const product = (
  species: string | null,
  subspecies: string | null,
  colors: string[] | null,
) => ({ species, subspecies, colors });

describe('ParrotSaleListingOptionsService', () => {
  const products = { find: jest.fn() };
  const manager = {
    getRepository: jest.fn((target: unknown) => {
      if (target === Product) return products;
      throw new Error('Unexpected repository');
    }),
  };
  const dataSource = { manager };
  const service = new ParrotSaleListingOptionsService(dataSource as never);

  beforeEach(() => jest.clearAllMocks());

  it('returns only cleaned, unique and sorted values from published bird products', async () => {
    products.find.mockResolvedValueOnce([
      product(' macaw ', ' blue-gold ', [' blue ', '', 'gold']),
      product('african-grey', ' red-tail ', ['gray', ' blue ']),
      product('macaw', 'blue-gold', ['gold']),
      product('african-grey', null, null),
      product('  ', 'ignored', ['ignored']),
      product(null, null, ['ignored']),
    ]);

    await expect(service.getOptions()).resolves.toEqual({
      species: ['african-grey', 'macaw'],
      subspeciesBySpecies: {
        'african-grey': ['red-tail'],
        macaw: ['blue-gold'],
      },
      colors: ['blue', 'gold', 'gray'],
    });
    expect(products.find).toHaveBeenCalledWith({
      select: { species: true, subspecies: true, colors: true },
      where: {
        categorySlug: ProductCategorySlug.BUY_PARROT,
        status: ProductStatus.PUBLISHED,
      },
    });
  });

  it('accepts an exact species with optional valid subspecies and colors', async () => {
    products.find.mockResolvedValue([
      product('african-grey', 'red-tail', ['gray', 'red']),
    ]);
    await expect(
      service.assertValidSelection(
        {
          species: 'african-grey',
          subspecies: 'red-tail',
          colors: ['gray'],
        },
        manager as never,
      ),
    ).resolves.toBeUndefined();
    await expect(
      service.assertValidSelection(
        { species: 'african-grey', subspecies: null, colors: [] },
        manager as never,
      ),
    ).resolves.toBeUndefined();
  });

  it.each([
    ['species', { species: 'guessed-species' }],
    ['subspecies', { species: 'african-grey', subspecies: 'wrong-subspecies' }],
    ['colors', { species: 'african-grey', colors: ['guessed-color'] }],
  ])(
    'rejects a selection containing an invalid %s option',
    async (_field, selection) => {
      products.find.mockResolvedValueOnce([
        product('african-grey', 'red-tail', ['gray']),
      ]);
      try {
        await service.assertValidSelection(selection, manager as never);
        throw new Error('Expected option validation to fail');
      } catch (error: unknown) {
        expect(error).toBeInstanceOf(HttpException);
        const exception = error as HttpException;
        expect(exception.getStatus()).toBe(400);
        expect(exception.getResponse()).toMatchObject({
          code: ParrotSaleListingErrorCode.INVALID_OPTION,
        });
      }
    },
  );

  it('uses the transaction-scoped Product repository for validation', async () => {
    products.find.mockResolvedValueOnce([
      product('african-grey', null, ['gray']),
    ]);
    await service.assertValidSelection(
      { species: 'african-grey' },
      manager as never,
    );
    expect(manager.getRepository).toHaveBeenCalledWith(Product);
  });
});
