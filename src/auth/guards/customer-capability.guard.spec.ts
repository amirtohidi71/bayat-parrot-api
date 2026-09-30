import { ExecutionContext, ForbiddenException } from '@nestjs/common';
import { GUARDS_METADATA } from '@nestjs/common/constants';
import { ProductsController } from '../../products/products.controller';
import { OrdersController } from '../../orders/orders.controller';
import { CustomerSalesChatController } from '../../sales-chat/customer-sales-chat.controller';
import { SellerOnboardingController } from '../../seller-onboarding/seller-onboarding.controller';
import { UserRole } from '../../users/entities/user.entity';
import { RolesGuard } from './roles.guard';
import { JwtAuthGuard } from './jwt-auth.guard';
import { CustomerCapabilityGuard } from './customer-capability.guard';

describe('CustomerCapabilityGuard', () => {
  const guard = new CustomerCapabilityGuard();

  it.each([UserRole.CUSTOMER, UserRole.BREEDER])(
    'accepts the %s customer capability',
    (role) => {
      expect(guard.canActivate(contextWithRole(role))).toBe(true);
    },
  );

  it.each([UserRole.ADMIN, 'invalid-role'])(
    'rejects the %s role with Forbidden',
    (role) => {
      expect(() => guard.canActivate(contextWithRole(role))).toThrow(
        ForbiddenException,
      );
    },
  );

  it('rejects an unauthenticated request if reached', () => {
    expect(() => guard.canActivate(contextWithRole())).toThrow(
      ForbiddenException,
    );
  });

  it('protects only customer order operations', () => {
    expect(methodGuards(OrdersController, 'create')).toContain(
      CustomerCapabilityGuard,
    );
    expect(methodGuards(OrdersController, 'findAllByUser')).toContain(
      CustomerCapabilityGuard,
    );
    expect(methodGuards(OrdersController, 'findOne')).toContain(
      CustomerCapabilityGuard,
    );
    expect(classGuards(OrdersController)).toContain(JwtAuthGuard);

    const updateGuards = methodGuards(OrdersController, 'updateStatus');
    expect(updateGuards).toContain(RolesGuard);
    expect(updateGuards).not.toContain(CustomerCapabilityGuard);
  });

  it('protects review submission without restricting public product reads', () => {
    expect(methodGuards(ProductsController, 'submitReview')).toEqual([
      JwtAuthGuard,
      CustomerCapabilityGuard,
    ]);
    expect(methodGuards(ProductsController, 'findAll')).not.toContain(
      CustomerCapabilityGuard,
    );
    expect(methodGuards(ProductsController, 'findOne')).not.toContain(
      CustomerCapabilityGuard,
    );
  });

  it('runs authentication before customer capability on customer controllers', () => {
    expect(classGuards(CustomerSalesChatController).slice(0, 2)).toEqual([
      JwtAuthGuard,
      CustomerCapabilityGuard,
    ]);
    expect(classGuards(SellerOnboardingController)).toEqual([
      JwtAuthGuard,
      CustomerCapabilityGuard,
    ]);
  });
});

function contextWithRole(role?: string): ExecutionContext {
  const request = role
    ? { user: { id: 'user-id', phone: '09120000000', role } }
    : {};
  return {
    switchToHttp: () => ({ getRequest: () => request }),
  } as ExecutionContext;
}

function classGuards(controller: object): unknown[] {
  const metadata: unknown = Reflect.getMetadata(GUARDS_METADATA, controller);
  return Array.isArray(metadata) ? (metadata as unknown[]) : [];
}

function methodGuards(
  controller: { prototype: Record<string, unknown> },
  method: string,
): unknown[] {
  const metadata: unknown = Reflect.getMetadata(
    GUARDS_METADATA,
    controller.prototype[method],
  );
  return Array.isArray(metadata) ? (metadata as unknown[]) : [];
}
