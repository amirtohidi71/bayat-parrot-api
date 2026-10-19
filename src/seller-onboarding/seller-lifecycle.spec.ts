import { User, UserRole } from '../users/entities/user.entity';
import {
  canReapply,
  effectiveApprovalStatus,
  ReapplicationIntent,
} from './seller-lifecycle';

describe('reverification response policy', () => {
  const user = {
    isActive: true,
    phoneVerifiedAt: new Date(),
    role: UserRole.CUSTOMER,
  } as User;
  const revoked = {
    status: 'APPROVED',
    revokedAt: new Date(),
    reapplicationIntent: ReapplicationIntent.REQUIRE_REVERIFICATION,
  };

  it('shows permitted re-verification independently from historical approval', () => {
    expect(effectiveApprovalStatus(revoked)).toBe('REVERIFICATION_REQUIRED');
    expect(canReapply(revoked, user)).toBe(true);
  });

  it('keeps default and unknown revocation intent fail-closed', () => {
    const blocked = {
      ...revoked,
      reapplicationIntent: ReapplicationIntent.BLOCKED,
    };
    expect(effectiveApprovalStatus(blocked)).toBe('BLOCKED');
    expect(canReapply(blocked, user)).toBe(false);
  });

  it('derives reapplication from a separate grant without rewriting the original block', () => {
    const value = {
      ...revoked,
      reapplicationIntent: ReapplicationIntent.BLOCKED,
      reapplicationGrantedAt: new Date(),
    };
    expect(effectiveApprovalStatus(value)).toBe('REVERIFICATION_REQUIRED');
    expect(canReapply(value, user)).toBe(true);
    expect(value.reapplicationIntent).toBe('BLOCKED');
    expect(canReapply({ ...value, isCurrent: false }, user)).toBe(false);
    expect(canReapply(value, { ...user, isActive: false })).toBe(false);
  });

  it('does not advertise reapplication for inactive accounts or historical rows', () => {
    expect(canReapply(revoked, { ...user, isActive: false })).toBe(false);
    expect(
      effectiveApprovalStatus({
        ...revoked,
        user: { ...user, isActive: false },
      }),
    ).toBe('ACCOUNT_INACTIVE');
    expect(canReapply({ ...revoked, isCurrent: false }, user)).toBe(false);
  });

  it('requires live CUSTOMER role for a new breeder promotion', () => {
    expect(canReapply(revoked, user, true)).toBe(true);
    expect(canReapply(revoked, { ...user, role: UserRole.BREEDER }, true)).toBe(
      false,
    );
    expect(canReapply(revoked, { ...user, role: UserRole.ADMIN }, true)).toBe(
      false,
    );
  });
});
