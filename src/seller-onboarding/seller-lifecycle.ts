import { EntityManager } from 'typeorm';
import { User, UserRole, isCustomerRole } from '../users/entities/user.entity';

export enum ReapplicationIntent {
  BLOCKED = 'BLOCKED',
  REQUIRE_REVERIFICATION = 'REQUIRE_REVERIFICATION',
}

export type RevocableApproval = {
  status: string;
  isCurrent?: boolean;
  revokedAt: Date | null;
  reapplicationIntent: ReapplicationIntent;
  reapplicationGrantedAt?: Date | null;
};

export function effectiveReapplicationIntent(value: RevocableApproval) {
  return value.revokedAt && value.reapplicationGrantedAt
    ? ReapplicationIntent.REQUIRE_REVERIFICATION
    : value.reapplicationIntent;
}

// Acquire before any row locks in onboarding/listing mutations. PostgreSQL
// releases this per-seller, cross-instance lock on transaction end/rollback.
export async function lockSellerLifecycle(
  manager: EntityManager,
  userId: string,
) {
  await manager.query(
    "SELECT pg_advisory_xact_lock(hashtextextended('seller-lifecycle:' || $1, 0))",
    [userId],
  );
}

export function effectiveApprovalStatus(
  value: RevocableApproval & { user?: User },
): string {
  if (value.user?.isActive === false) return 'ACCOUNT_INACTIVE';
  return value.revokedAt
    ? effectiveReapplicationIntent(value) ===
      ReapplicationIntent.REQUIRE_REVERIFICATION
      ? 'REVERIFICATION_REQUIRED'
      : 'BLOCKED'
    : value.status;
}

export function canReapply(
  value: RevocableApproval,
  user: User | undefined,
  breeder = false,
): boolean {
  return Boolean(
    value.isCurrent !== false &&
    user?.isActive &&
    user.phoneVerifiedAt &&
    isCustomerRole(user.role) &&
    (!breeder || user.role === UserRole.CUSTOMER) &&
    (value.status === 'REJECTED' ||
      (value.revokedAt &&
        effectiveReapplicationIntent(value) ===
          ReapplicationIntent.REQUIRE_REVERIFICATION)),
  );
}
