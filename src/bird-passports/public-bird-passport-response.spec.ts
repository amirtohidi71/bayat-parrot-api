import {
  BirdPassport,
  BirdPassportGender,
} from './entities/bird-passport.entity';
import {
  calculateBirdAgeMonths,
  toPublicBirdPassport,
} from './public-bird-passport-response';

describe('public Bird Passport response', () => {
  it.each([
    ['2025-05-10', '2025-06-09', 0],
    ['2025-05-10', '2025-06-10', 1],
    ['2024-08-13', '2026-08-13', 24],
    ['2026-08-14', '2026-08-13', 0],
    // The helper uses the same calendar day as the completed-month boundary;
    // short months therefore remain below the next full same-day anniversary.
    ['2023-01-31', '2023-02-28', 0],
    ['2024-01-31', '2024-02-29', 0],
    ['2024-02-29', '2025-02-28', 11],
    ['2024-02-29', '2025-03-01', 12],
  ])(
    'calculates full completed months for %s on %s',
    (birth, today, expected) => {
      expect(calculateBirdAgeMonths(birth, today)).toBe(expected);
    },
  );

  it('sorts histories deterministically and exposes only public fields', () => {
    const passport = {
      id: 'passport-internal-id',
      code: 'B25543210',
      ownerFullName: 'Owner Name',
      ownerMobile: '09123456789',
      birdName: 'Rio',
      imagePath: 'private-image.webp',
      birthDate: '2025-05-10',
      gender: BirdPassportGender.FEMALE,
      species: 'Parrot',
      subspecies: 'Macaw',
      status: 'active',
      createdAt: new Date(),
      updatedAt: new Date(),
      otps: [{ codeHash: 'secret-hash', phone: '09123456789', attempts: 1 }],
      vaccineRecords: [
        {
          id: 'b',
          sortOrder: 1,
          vaccineName: 'B',
          vaccinationDate: '2026-02-01',
        },
        {
          id: 'a',
          sortOrder: 1,
          vaccineName: 'A',
          vaccinationDate: '2026-01-01',
        },
      ],
      feedingRecords: [
        { id: 'b', sortOrder: 2, ageRange: 'older', description: 'B' },
        { id: 'a', sortOrder: 1, ageRange: 'younger', description: 'A' },
      ],
      veterinaryVisits: [
        {
          id: 'a',
          sortOrder: 0,
          visitDate: '2026-01-01',
          clinicalNotes: 'healthy',
          veterinaryActions: 'none',
        },
      ],
    } as unknown as BirdPassport;
    const response = toPublicBirdPassport(passport);
    expect(response.vaccines.map((item) => item.vaccineName)).toEqual([
      'A',
      'B',
    ]);
    expect(response.feedings.map((item) => item.ageRange)).toEqual([
      'younger',
      'older',
    ]);
    expect(response).toMatchObject({
      code: 'B25543210',
      ownerFullName: 'Owner Name',
      birdName: 'Rio',
      birthDate: '2025-05-10',
      gender: BirdPassportGender.FEMALE,
      species: 'Parrot',
      subspecies: 'Macaw',
      hasImage: true,
    });
    const serialized = JSON.stringify(response);
    for (const forbidden of [
      'ownerMobile',
      'passport-internal-id',
      'private-image.webp',
      'createdAt',
      'updatedAt',
      'codeHash',
      'attempts',
      '09123456789',
      'status',
      '"id"',
    ]) {
      expect(serialized).not.toContain(forbidden);
    }
  });
});
