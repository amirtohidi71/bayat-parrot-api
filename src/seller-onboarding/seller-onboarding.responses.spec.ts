import { UserRole } from '../users/entities/user.entity';
import {
  BreederApplicationStatus,
  BreederCallOutcome,
} from './entities/breeder-application.entity';
import { SellerVerificationStatus } from './entities/seller-verification.entity';
import {
  breederAdminResponse,
  breederUserResponse,
  sellerAdminResponse,
  sellerUserResponse,
} from './seller-onboarding.responses';

describe('seller onboarding response allowlists', () => {
  const user = {
    id: 'user-1',
    firstName: 'A',
    lastName: 'B',
    phone: '09123456789',
    email: 'secret@example.test',
    nationalId: '1234567890',
    role: UserRole.CUSTOMER,
  } as never;
  const seller = {
    id: 'seller-1',
    userId: 'user-1',
    user,
    firstName: 'A',
    lastName: 'B',
    birthDate: '2000-01-01',
    consentAcceptedAt: new Date(),
    consentVersion: 'v1',
    status: SellerVerificationStatus.REJECTED,
    rejectionReason: 'public reason',
    internalAdminNote: 'secret note',
    reviewedBy: 'admin',
    reviewedAt: new Date(),
    revokedAt: new Date(),
    revokedBy: 'admin',
    revocationReason: 'public revocation reason',
    createdAt: new Date(),
    updatedAt: new Date(),
  } as never;
  const breeder = {
    id: 'breeder-1',
    userId: 'user-1',
    user,
    breederName: 'Farm',
    city: 'Tehran',
    species: ['cockatiel'],
    experienceYears: 2,
    approximateBirdCount: 3,
    preferredContactTime: 'morning',
    instagramUrl: null,
    websiteUrl: null,
    description: null,
    status: BreederApplicationStatus.FOLLOW_UP,
    callOutcome: BreederCallOutcome.NO_ANSWER,
    contactedAt: new Date(),
    privateCallNote: 'private',
    rejectionReason: null,
    reviewedBy: 'admin',
    reviewedAt: null,
    createdAt: new Date(),
    updatedAt: new Date(),
  } as never;

  it('never leaks internal seller fields in the user response', () => {
    const response = sellerUserResponse(seller);
    expect(response).not.toHaveProperty('internalAdminNote');
    expect(response).not.toHaveProperty('reviewedBy');
    expect(response).not.toHaveProperty('revokedBy');
    expect(response).not.toHaveProperty('user');
    expect(response).toMatchObject({
      revocationReason: 'public revocation reason',
    });
  });

  it('never leaks private call data in the user response', () => {
    const response = breederUserResponse(breeder);
    expect(response).not.toHaveProperty('privateCallNote');
    expect(response).not.toHaveProperty('callOutcome');
    expect(response).not.toHaveProperty('reviewedBy');
  });

  it('allowlists the admin user summary without sensitive user fields', () => {
    for (const response of [
      sellerAdminResponse(seller),
      breederAdminResponse(breeder),
    ]) {
      expect(response.user).toEqual({
        id: 'user-1',
        firstName: 'A',
        lastName: 'B',
        phone: '09123456789',
      });
      expect(response.user).not.toHaveProperty('email');
      expect(response.user).not.toHaveProperty('nationalId');
      expect(response.user).not.toHaveProperty('role');
    }
    expect(sellerAdminResponse(seller)).toMatchObject({
      revokedBy: 'admin',
      revocationReason: 'public revocation reason',
    });
  });
});
