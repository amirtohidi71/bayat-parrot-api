/* eslint-disable @typescript-eslint/no-unsafe-assignment */
import { UnauthorizedException } from '@nestjs/common';
import { GUARDS_METADATA } from '@nestjs/common/constants';
import { AdminController } from '../admin/admin.controller';
import {
  ADMIN_PANEL_SCOPE,
  AdminAuthGuard,
} from '../admin/guards/admin-auth.guard';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { ReorderProductReviewVideosDto } from './dto/reorder-product-review-videos.dto';
import { ProductsController } from './products.controller';

const PRODUCT_ID = '11111111-1111-4111-8111-111111111111';
const VIDEO_ID = '22222222-2222-4222-8222-222222222222';

function reviewVideoService() {
  return {
    findForAdmin: jest.fn().mockResolvedValue({ items: [] }),
    findPublic: jest.fn().mockResolvedValue({ items: [] }),
    create: jest.fn().mockResolvedValue({ id: VIDEO_ID }),
    replace: jest.fn().mockResolvedValue({ id: VIDEO_ID }),
    remove: jest.fn().mockResolvedValue({ items: [] }),
    reorder: jest.fn().mockResolvedValue({ items: [] }),
  };
}

describe('product review video controller boundaries', () => {
  it.each([
    'getProductReviewVideos',
    'createProductReviewVideo',
    'replaceProductReviewVideo',
    'removeProductReviewVideo',
    'reorderProductReviewVideos',
  ] as const)('protects AdminController.%s with AdminAuthGuard', (method) => {
    const guards = Reflect.getMetadata(
      GUARDS_METADATA,
      AdminController.prototype[method],
    );
    expect(guards).toContain(AdminAuthGuard);
  });

  it('rejects a normal user token at the existing admin guard boundary', () => {
    const guard = new AdminAuthGuard({
      verify: jest.fn().mockReturnValue({ sub: 'user-id', role: 'customer' }),
    } as never);
    const request = { headers: { authorization: 'Bearer normal-user-token' } };
    const context = {
      switchToHttp: () => ({ getRequest: () => request }),
    };

    expect(() => guard.canActivate(context as never)).toThrow(
      UnauthorizedException,
    );
  });

  it('accepts only an admin-panel scoped token', () => {
    const guard = new AdminAuthGuard({
      verify: jest.fn().mockReturnValue({
        scope: ADMIN_PANEL_SCOPE,
        username: 'admin',
      }),
    } as never);
    const request: { headers: { authorization: string }; admin?: unknown } = {
      headers: { authorization: 'Bearer admin-token' },
    };
    const context = {
      switchToHttp: () => ({ getRequest: () => request }),
    };

    expect(guard.canActivate(context as never)).toBe(true);
    expect(request.admin).toEqual({
      scope: ADMIN_PANEL_SCOPE,
      username: 'admin',
    });
  });

  it('delegates every admin operation with the product boundary intact', async () => {
    const service = reviewVideoService();
    const controller = new AdminController({} as never, service as never);
    const files = { video: [], cover: [] };

    await controller.getProductReviewVideos(PRODUCT_ID);
    await controller.createProductReviewVideo(PRODUCT_ID, files);
    await controller.replaceProductReviewVideo(PRODUCT_ID, VIDEO_ID, files);
    await controller.removeProductReviewVideo(PRODUCT_ID, VIDEO_ID);
    await controller.reorderProductReviewVideos(PRODUCT_ID, {
      orderedIds: [VIDEO_ID],
    });

    expect(service.findForAdmin).toHaveBeenCalledWith(PRODUCT_ID);
    expect(service.create).toHaveBeenCalledWith(PRODUCT_ID, files);
    expect(service.replace).toHaveBeenCalledWith(PRODUCT_ID, VIDEO_ID, files);
    expect(service.remove).toHaveBeenCalledWith(PRODUCT_ID, VIDEO_ID);
    expect(service.reorder).toHaveBeenCalledWith(PRODUCT_ID, [VIDEO_ID]);
  });

  it('exposes a mapped empty public list through the dedicated endpoint', async () => {
    const service = reviewVideoService();
    const controller = new ProductsController({} as never, service as never);

    await expect(controller.findReviewVideos(PRODUCT_ID)).resolves.toEqual({
      items: [],
    });
    expect(service.findPublic).toHaveBeenCalledWith(PRODUCT_ID);
  });

  it('rejects duplicate or more than 10 reorder IDs at DTO validation', async () => {
    const duplicate = plainToInstance(ReorderProductReviewVideosDto, {
      orderedIds: [VIDEO_ID, VIDEO_ID],
    });
    const tooMany = plainToInstance(ReorderProductReviewVideosDto, {
      orderedIds: Array.from(
        { length: 11 },
        (_, index) =>
          `00000000-0000-4000-8000-${String(index).padStart(12, '0')}`,
      ),
    });

    await expect(validate(duplicate)).resolves.not.toHaveLength(0);
    await expect(validate(tooMany)).resolves.not.toHaveLength(0);
  });
});
