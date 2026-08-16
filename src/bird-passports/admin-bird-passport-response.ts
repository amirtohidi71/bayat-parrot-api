import { BirdFeedingRecord } from './entities/bird-feeding-record.entity';
import { BirdPassport } from './entities/bird-passport.entity';
import { BirdVaccineRecord } from './entities/bird-vaccine-record.entity';
import { BirdVeterinaryVisit } from './entities/bird-veterinary-visit.entity';

export function toAdminPassportSummary(passport: BirdPassport) {
  return {
    id: passport.id,
    code: passport.code,
    ownerMobile: passport.ownerMobile,
    birthDate: passport.birthDate,
    species: passport.species,
    subspecies: passport.subspecies,
    status: passport.status,
    hasImage: Boolean(passport.imagePath),
    createdAt: passport.createdAt,
    updatedAt: passport.updatedAt,
  };
}

export function toAdminPassportDetail(passport: BirdPassport) {
  return {
    ...toAdminPassportSummary(passport),
    vaccines: sorted(passport.vaccineRecords ?? []).map(vaccineResponse),
    feedings: sorted(passport.feedingRecords ?? []).map(feedingResponse),
    veterinaryVisits: sorted(passport.veterinaryVisits ?? []).map(
      veterinaryResponse,
    ),
  };
}

function sorted<T extends { sortOrder: number; id: string }>(rows: T[]): T[] {
  return [...rows].sort(
    (left, right) =>
      left.sortOrder - right.sortOrder || left.id.localeCompare(right.id),
  );
}

export function vaccineResponse(row: BirdVaccineRecord) {
  return {
    id: row.id,
    vaccineName: row.vaccineName,
    vaccinationDate: row.vaccinationDate,
    sortOrder: row.sortOrder,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

export function feedingResponse(row: BirdFeedingRecord) {
  return {
    id: row.id,
    ageRange: row.ageRange,
    description: row.description,
    sortOrder: row.sortOrder,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

export function veterinaryResponse(row: BirdVeterinaryVisit) {
  return {
    id: row.id,
    visitDate: row.visitDate,
    clinicalNotes: row.clinicalNotes,
    veterinaryActions: row.veterinaryActions,
    sortOrder: row.sortOrder,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}
