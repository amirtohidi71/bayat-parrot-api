import { User, UserRole } from '../entities/user.entity';

/** Explicit allowlist: never serialize User relations or newly added columns. */
export class UserDirectoryResponseDto {
  id: string;
  phone: string;
  firstName: string | null;
  lastName: string | null;
  email: string | null;
  profileCompleted: boolean;
  loyaltyPoints: number;
  role: UserRole;
  createdAt: Date;
  updatedAt: Date;
}

export class OwnUserProfileResponseDto extends UserDirectoryResponseDto {
  // The current user's existing account/checkout forms need their own value.
  nationalId: string | null;
}

export function toUserDirectoryResponse(user: User): UserDirectoryResponseDto {
  return {
    id: user.id,
    phone: user.phone,
    firstName: user.firstName ?? null,
    lastName: user.lastName ?? null,
    email: user.email ?? null,
    profileCompleted: user.profileCompleted,
    loyaltyPoints: user.loyaltyPoints,
    role: user.role,
    createdAt: user.createdAt,
    updatedAt: user.updatedAt,
  };
}

export function toOwnUserProfileResponse(
  user: User,
): OwnUserProfileResponseDto {
  return {
    ...toUserDirectoryResponse(user),
    nationalId: user.nationalId ?? null,
  };
}
