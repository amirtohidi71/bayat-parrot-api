import { BreederApplication } from './entities/breeder-application.entity';
import { SellerVerification } from './entities/seller-verification.entity';

const userSummary = (value: SellerVerification | BreederApplication) => ({
  id: value.user.id,
  firstName: value.user.firstName ?? null,
  lastName: value.user.lastName ?? null,
  phone: value.user.phone,
});

export const sellerUserResponse = (value: SellerVerification) => ({
  id: value.id,
  firstName: value.firstName,
  lastName: value.lastName,
  birthDate: value.birthDate,
  consentAcceptedAt: value.consentAcceptedAt,
  consentVersion: value.consentVersion,
  status: value.status,
  rejectionReason: value.rejectionReason,
  revokedAt: value.revokedAt,
  revocationReason: value.revocationReason,
  createdAt: value.createdAt,
  updatedAt: value.updatedAt,
});

export const sellerAdminResponse = (value: SellerVerification) => ({
  ...sellerUserResponse(value),
  user: userSummary(value),
  internalAdminNote: value.internalAdminNote,
  reviewedBy: value.reviewedBy,
  reviewedAt: value.reviewedAt,
  revokedBy: value.revokedBy,
});

export const breederUserResponse = (value: BreederApplication) => ({
  id: value.id,
  breederName: value.breederName,
  city: value.city,
  species: value.species,
  experienceYears: value.experienceYears,
  approximateBirdCount: value.approximateBirdCount,
  preferredContactTime: value.preferredContactTime,
  instagramUrl: value.instagramUrl,
  websiteUrl: value.websiteUrl,
  description: value.description,
  status: value.status,
  rejectionReason: value.rejectionReason,
  contacted: Boolean(value.contactedAt),
  createdAt: value.createdAt,
  updatedAt: value.updatedAt,
});

export const breederAdminResponse = (value: BreederApplication) => ({
  ...breederUserResponse(value),
  user: userSummary(value),
  callOutcome: value.callOutcome,
  contactedAt: value.contactedAt,
  privateCallNote: value.privateCallNote,
  reviewedBy: value.reviewedBy,
  reviewedAt: value.reviewedAt,
});
