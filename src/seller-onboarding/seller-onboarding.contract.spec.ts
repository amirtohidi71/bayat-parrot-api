import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { GUARDS_METADATA } from '@nestjs/common/constants';
import { AdminAuthGuard } from '../admin/guards/admin-auth.guard';
import { isCustomerRole, UserRole } from '../users/entities/user.entity';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { JwtStrategy } from '../auth/strategies/jwt.strategy';
import { AdminSellerOnboardingController } from './admin-seller-onboarding.controller';
import { SellerOnboardingController } from './seller-onboarding.controller';
import { getMetadataArgsStorage } from 'typeorm';
import { SellerVerification } from './entities/seller-verification.entity';
import { BreederApplication } from './entities/breeder-application.entity';

describe('seller onboarding contracts', () => {
  it('keeps customer and admin surfaces behind their existing guards', () => {
    expect(
      Reflect.getMetadata(GUARDS_METADATA, SellerOnboardingController),
    ).toContain(JwtAuthGuard);
    expect(
      Reflect.getMetadata(GUARDS_METADATA, AdminSellerOnboardingController),
    ).toContain(AdminAuthGuard);
  });

  it('preserves ordinary customer capabilities for breeder without granting admin', () => {
    expect(isCustomerRole(UserRole.CUSTOMER)).toBe(true);
    expect(isCustomerRole(UserRole.BREEDER)).toBe(true);
    expect(isCustomerRole(UserRole.ADMIN)).toBe(false);
  });

  it('accepts breeder only as a signed user-token role and still rejects scoped tokens', () => {
    const strategy = new JwtStrategy({ get: jest.fn(() => 'secret') } as never);
    expect(
      strategy.validate({
        sub: 'user-1',
        phone: '09123456789',
        role: 'breeder',
      }),
    ).toEqual({ id: 'user-1', phone: '09123456789', role: 'breeder' });
    expect(() =>
      strategy.validate({
        sub: 'user-1',
        phone: '09123456789',
        role: 'breeder',
        scope: 'admin-panel',
      }),
    ).toThrow('Invalid user token');
  });

  it('ships explicit forward and safe rollback SQL with active-request indexes', () => {
    const forward = readFileSync(
      join(
        process.cwd(),
        'scripts/migrations/20260926-create-seller-onboarding-v1.sql',
      ),
      'utf8',
    );
    const rollback = readFileSync(
      join(
        process.cwd(),
        'scripts/migrations/20260926-rollback-seller-onboarding-v1.sql',
      ),
      'utf8',
    );
    expect(forward).toContain(
      "ALTER TYPE public.users_role_enum ADD VALUE 'breeder'",
    );
    expect(forward).toContain('UQ_seller_verifications_active_user');
    expect(forward).toContain('UQ_breeder_applications_active_user');
    expect(forward).toContain('ON DELETE RESTRICT');
    expect(forward).not.toContain('WHERE consumed = true');
    expect(forward).toContain('never trusted as proof');
    expect(forward).toMatch(
      /JOIN pg_namespace n ON n\.oid=t\.typnamespace\s+WHERE n\.nspname='public' AND t\.typname='users_role_enum'/,
    );
    expect(rollback).toContain('Rollback refused: BREEDER users exist');
  });

  it('pins every onboarding enum to the migration type name', () => {
    const columns = getMetadataArgsStorage().columns;
    const enumName = (target: object, propertyName: string) =>
      columns.find(
        (column) =>
          column.target === target && column.propertyName === propertyName,
      )?.options.enumName;

    expect(enumName(SellerVerification, 'status')).toBe(
      'seller_verifications_status_enum',
    );
    expect(enumName(BreederApplication, 'status')).toBe(
      'breeder_applications_status_enum',
    );
    expect(enumName(BreederApplication, 'callOutcome')).toBe(
      'breeder_applications_call_outcome_enum',
    );
  });
});
