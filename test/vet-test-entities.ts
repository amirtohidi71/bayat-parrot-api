// Shared explicit metadata closure for foundation tests; no connection or side effects.
import { User } from '../src/users/entities/user.entity';
import { Product } from '../src/products/entities/product.entity';
import { ProductReview } from '../src/products/entities/product-review.entity';
import { ProductReviewVideo } from '../src/products/entities/product-review-video.entity';
import { BirdPassport } from '../src/bird-passports/entities/bird-passport.entity';
import { BirdPassportOtp } from '../src/bird-passports/entities/bird-passport-otp.entity';
import { BirdFeedingRecord } from '../src/bird-passports/entities/bird-feeding-record.entity';
import { BirdVaccineRecord } from '../src/bird-passports/entities/bird-vaccine-record.entity';
import { BirdVeterinaryVisit } from '../src/bird-passports/entities/bird-veterinary-visit.entity';
import { VET_ENTITIES } from '../src/vet-appointments/vet-appointments.module';

export const VET_TEST_ENTITIES = [
  ...VET_ENTITIES,
  User,
  Product,
  ProductReview,
  ProductReviewVideo,
  BirdPassport,
  BirdPassportOtp,
  BirdFeedingRecord,
  BirdVaccineRecord,
  BirdVeterinaryVisit,
];
