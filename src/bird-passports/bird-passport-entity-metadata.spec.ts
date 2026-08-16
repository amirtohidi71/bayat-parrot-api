import { getMetadataArgsStorage } from 'typeorm';
import { BirdFeedingRecord } from './entities/bird-feeding-record.entity';
import { BirdPassportOtp } from './entities/bird-passport-otp.entity';
import { BirdPassport } from './entities/bird-passport.entity';
import { BirdVaccineRecord } from './entities/bird-vaccine-record.entity';
import { BirdVeterinaryVisit } from './entities/bird-veterinary-visit.entity';

describe('Bird Passport entity constraint metadata', () => {
  it.each([
    [BirdPassport, 'bird_passports_pkey'],
    [BirdVaccineRecord, 'bird_vaccine_records_pkey'],
    [BirdFeedingRecord, 'bird_feeding_records_pkey'],
    [BirdVeterinaryVisit, 'bird_veterinary_visits_pkey'],
    [BirdPassportOtp, 'bird_passport_otps_pkey'],
  ])('uses the migration PK name for %p', (entity, expectedName) => {
    const primary = getMetadataArgsStorage().columns.find(
      (column) => column.target === entity && column.propertyName === 'id',
    );
    expect(primary?.options.primaryKeyConstraintName).toBe(expectedName);
  });

  it.each([
    [BirdVaccineRecord, 'passport', 'FK_bird_vaccine_records_passport'],
    [BirdFeedingRecord, 'passport', 'FK_bird_feeding_records_passport'],
    [BirdVeterinaryVisit, 'passport', 'FK_bird_veterinary_visits_passport'],
    [BirdPassportOtp, 'birdPassport', 'FK_bird_passport_otps_passport'],
  ])(
    'uses the migration FK name for %p',
    (entity, propertyName, expectedName) => {
      const join = getMetadataArgsStorage().joinColumns.find(
        (column) =>
          column.target === entity && column.propertyName === propertyName,
      );
      expect(join?.foreignKeyConstraintName).toBe(expectedName);
    },
  );
});
