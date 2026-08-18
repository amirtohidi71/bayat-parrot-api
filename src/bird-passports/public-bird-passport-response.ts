import { getTehranDateOnly } from './date-only';
import { BirdPassport } from './entities/bird-passport.entity';

export function calculateBirdAgeMonths(
  birthDate: string,
  today: string = getTehranDateOnly(),
): number {
  const [birthYear, birthMonth, birthDay] = birthDate.split('-').map(Number);
  const [todayYear, todayMonth, todayDay] = today.split('-').map(Number);
  const calendarMonths =
    (todayYear - birthYear) * 12 + (todayMonth - birthMonth);
  return Math.max(0, calendarMonths - (todayDay < birthDay ? 1 : 0));
}

function sorted<T extends { sortOrder: number; id: string }>(rows: T[]): T[] {
  return [...rows].sort((left, right) => {
    const orderDifference = left.sortOrder - right.sortOrder;
    if (orderDifference) return orderDifference;
    return left.id < right.id ? -1 : left.id > right.id ? 1 : 0;
  });
}

export function toPublicBirdPassport(passport: BirdPassport) {
  return {
    code: passport.code,
    ownerFullName: passport.ownerFullName,
    birdName: passport.birdName,
    birthDate: passport.birthDate,
    ageMonths: calculateBirdAgeMonths(passport.birthDate),
    species: passport.species,
    subspecies: passport.subspecies,
    hasImage: Boolean(passport.imagePath),
    vaccines: sorted(passport.vaccineRecords ?? []).map((record) => ({
      vaccineName: record.vaccineName,
      vaccinationDate: record.vaccinationDate,
    })),
    feedings: sorted(passport.feedingRecords ?? []).map((record) => ({
      ageRange: record.ageRange,
      description: record.description,
    })),
    veterinaryVisits: sorted(passport.veterinaryVisits ?? []).map((visit) => ({
      visitDate: visit.visitDate,
      clinicalNotes: visit.clinicalNotes,
      veterinaryActions: visit.veterinaryActions,
    })),
  };
}
