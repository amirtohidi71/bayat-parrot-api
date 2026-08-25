import { BadRequestException, NotFoundException } from '@nestjs/common';
import {
  ProductCategorySlug,
  ProductStatus,
} from '../products/entities/product.entity';
import { ChatSourceType } from './entities/chat-conversation.entity';
import { SalesAgentScope } from './entities/sales-agent.entity';
import { SalesChatProductRoutingService } from './sales-chat-product-routing.service';

describe('SalesChatProductRoutingService', () => {
  const products = { findOne: jest.fn() };
  const service = new SalesChatProductRoutingService(products as never);

  beforeEach(() => jest.clearAllMocks());

  it.each([
    [ProductCategorySlug.BUY_PARROT, SalesAgentScope.PARROT],
    [ProductCategorySlug.PARROT_FOOD, SalesAgentScope.PRODUCTS],
    [ProductCategorySlug.PARROT_CAGE, SalesAgentScope.PRODUCTS],
  ])('routes %s authoritatively to %s', async (categorySlug, area) => {
    products.findOne.mockResolvedValue({
      id: '11111111-1111-4111-8111-111111111111',
      sku: 'BP123',
      name: 'Example Product',
      categorySlug,
      status: ProductStatus.PUBLISHED,
    });
    await expect(
      service.resolve({
        area,
        sourceType: ChatSourceType.PRODUCT_PAGE,
        sourceProductId: '11111111-1111-4111-8111-111111111111',
        sourcePath: '/product/example',
      }),
    ).resolves.toEqual({
      area,
      sourceType: ChatSourceType.PRODUCT_PAGE,
      sourceProductId: '11111111-1111-4111-8111-111111111111',
      sourcePath: '/product/BP123/Example-Product',
    });
  });

  it('rejects a spoofed area', async () => {
    products.findOne.mockResolvedValue({
      id: '11111111-1111-4111-8111-111111111111',
      sku: 'BP123',
      name: 'Example Product',
      categorySlug: ProductCategorySlug.PARROT_FOOD,
    });
    await expect(
      service.resolve({
        area: SalesAgentScope.PARROT,
        sourceType: ChatSourceType.PRODUCT_PAGE,
        sourceProductId: '11111111-1111-4111-8111-111111111111',
      }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('rejects an unavailable product without leaking details', async () => {
    products.findOne.mockResolvedValue(null);
    await expect(
      service.resolve({
        area: SalesAgentScope.PRODUCTS,
        sourceType: ChatSourceType.PRODUCT_PAGE,
        sourceProductId: '11111111-1111-4111-8111-111111111111',
      }),
    ).rejects.toEqual(new NotFoundException('Product context is unavailable'));
  });

  it('accepts explicit area selection without product context', async () => {
    await expect(
      service.resolve({
        area: SalesAgentScope.PARROT,
        sourceType: ChatSourceType.ACCOUNT,
        sourcePath: '/account',
      }),
    ).resolves.toEqual({
      area: SalesAgentScope.PARROT,
      sourceType: ChatSourceType.ACCOUNT,
      sourceProductId: null,
      sourcePath: '/account',
    });
  });

  it('rejects a non-product path for product context', async () => {
    products.findOne.mockResolvedValue({
      id: '11111111-1111-4111-8111-111111111111',
      sku: 'BP123',
      name: 'Example Product',
      categorySlug: ProductCategorySlug.PARROT_FOOD,
      status: ProductStatus.PUBLISHED,
    });
    await expect(
      service.resolve({
        area: SalesAgentScope.PRODUCTS,
        sourceType: ChatSourceType.PRODUCT_PAGE,
        sourceProductId: '11111111-1111-4111-8111-111111111111',
        sourcePath: '/account',
      }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('rejects a non-account path for account context', async () => {
    await expect(
      service.resolve({
        area: SalesAgentScope.PRODUCTS,
        sourceType: ChatSourceType.ACCOUNT,
        sourcePath: '/product/example',
      }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('generates the canonical account path when the client omits it', async () => {
    await expect(
      service.resolve({
        area: SalesAgentScope.PRODUCTS,
        sourceType: ChatSourceType.ACCOUNT,
      }),
    ).resolves.toEqual({
      area: SalesAgentScope.PRODUCTS,
      sourceType: ChatSourceType.ACCOUNT,
      sourceProductId: null,
      sourcePath: '/account',
    });
  });
});
