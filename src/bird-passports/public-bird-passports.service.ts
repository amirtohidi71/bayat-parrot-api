import {
  ForbiddenException,
  Injectable,
  NotFoundException,
  UnauthorizedException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import * as bcrypt from 'bcrypt';
import { DataSource, MoreThanOrEqual, Repository } from 'typeorm';
import { PublicRequestBirdPassportOtpDto } from './dto/public-request-bird-passport-otp.dto';
import { PublicVerifyBirdPassportOtpDto } from './dto/public-verify-bird-passport-otp.dto';
import {
  BIRD_PASSPORT_OTP_PURPOSE,
  BirdPassportOtp,
} from './entities/bird-passport-otp.entity';
import {
  BirdPassport,
  BirdPassportStatus,
} from './entities/bird-passport.entity';
import { BirdPassportImagesService } from './images/bird-passport-images.service';
import { PublicBirdPassportOtpCandidateFactory } from './public-bird-passport-otp-candidate';
import { PublicBirdPassportOtpCleanupService } from './public-bird-passport-otp-cleanup.service';
import { toPublicBirdPassport } from './public-bird-passport-response';
import { PublicBirdPassportRequestTimingService } from './public-bird-passport-request-timing.service';
import { PublicBirdPassportSmsDispatchService } from './public-bird-passport-sms-dispatch.service';

export const PUBLIC_OTP_REQUEST_MESSAGE =
  'If the provided information is correct, a verification code will be sent.';
export const PUBLIC_OTP_FAILURE_MESSAGE = 'Verification failed.';
export const PUBLIC_OTP_OWNER_MOBILE_MISMATCH_CODE =
  'BIRD_PASSPORT_OWNER_MOBILE_MISMATCH';
export const PUBLIC_OTP_OWNER_MOBILE_MISMATCH_MESSAGE =
  'شماره موبایل با شماره ثبت‌شده برای این شناسنامه همخوانی ندارد.';

const OTP_TTL_SECONDS = 120;
const OTP_COOLDOWN_SECONDS = 120;
const OTP_WINDOW_SECONDS = 15 * 60;
const OTP_WINDOW_LIMIT = 5;
const MAX_OTP_ATTEMPTS = 5;
const DUMMY_BCRYPT_HASH =
  '$2b$10$92IXUNpkjO0rOQ5byMi.Ye4oKoEa3Ro9llC/.og/at2uheWG/igi.';

type PreparedOtp = {
  id: string;
  phone: string;
  rawCode: string;
};

type VerifyOutcome = { valid: false } | { valid: true; passportId: string };

@Injectable()
export class PublicBirdPassportsService {
  constructor(
    @InjectRepository(BirdPassport)
    private readonly passports: Repository<BirdPassport>,
    private readonly dataSource: DataSource,
    private readonly images: BirdPassportImagesService,
    private readonly candidates: PublicBirdPassportOtpCandidateFactory,
    private readonly timing: PublicBirdPassportRequestTimingService,
    private readonly dispatch: PublicBirdPassportSmsDispatchService,
    private readonly cleanup: PublicBirdPassportOtpCleanupService,
  ) {}

  async requestOtp(
    dto: PublicRequestBirdPassportOtpDto,
  ): Promise<{ message: string }> {
    const startedAt = this.timing.start();
    let prepared: PreparedOtp | null = null;
    try {
      prepared = await this.dataSource.transaction<PreparedOtp | null>(
        async (manager) => {
          const passport = await manager.getRepository(BirdPassport).findOne({
            where: {
              code: dto.code,
              status: BirdPassportStatus.ACTIVE,
            },
            select: { id: true, ownerMobile: true },
            lock: { mode: 'pessimistic_read' },
          });
          if (!passport) return null;
          if (passport.ownerMobile !== dto.ownerMobile) {
            throw new ForbiddenException({
              code: PUBLIC_OTP_OWNER_MOBILE_MISMATCH_CODE,
              message: PUBLIC_OTP_OWNER_MOBILE_MISMATCH_MESSAGE,
            });
          }

          await manager.query('SELECT pg_advisory_xact_lock(hashtext($1))', [
            `bird-passport-otp:${passport.id}:${dto.ownerMobile}`,
          ]);
          const repository = manager.getRepository(BirdPassportOtp);
          const now = new Date();
          const latest = await this.findLatestOtp(
            repository,
            passport.id,
            dto.ownerMobile,
          );
          if (
            latest &&
            latest.createdAt >
              new Date(now.getTime() - OTP_COOLDOWN_SECONDS * 1000)
          ) {
            return null;
          }

          const recentCount = await this.countRecentOtps(
            repository,
            passport.id,
            dto.ownerMobile,
            new Date(now.getTime() - OTP_WINDOW_SECONDS * 1000),
          );
          if (recentCount >= OTP_WINDOW_LIMIT) return null;

          const candidate = await this.candidates.create();
          await repository.update(
            {
              birdPassportId: passport.id,
              phone: dto.ownerMobile,
              purpose: BIRD_PASSPORT_OTP_PURPOSE,
              consumed: false,
            },
            { consumed: true },
          );
          const otp = await repository.save(
            repository.create({
              birdPassportId: passport.id,
              phone: dto.ownerMobile,
              purpose: BIRD_PASSPORT_OTP_PURPOSE,
              codeHash: candidate.codeHash,
              expiresAt: new Date(now.getTime() + OTP_TTL_SECONDS * 1000),
              attempts: 0,
              consumed: false,
            }),
          );
          return {
            id: otp.id,
            phone: passport.ownerMobile,
            rawCode: candidate.rawCode,
          };
        },
      );

      return { message: PUBLIC_OTP_REQUEST_MESSAGE };
    } finally {
      await this.timing.waitForFloor(startedAt);
      if (prepared) {
        this.dispatch.dispatch({
          otpId: prepared.id,
          phone: prepared.phone,
          rawCode: prepared.rawCode,
        });
      }
      this.cleanup.schedule();
    }
  }

  async verifyOtp(
    dto: PublicVerifyBirdPassportOtpDto,
  ): Promise<{ passportId: string }> {
    const outcome = await this.dataSource.transaction<VerifyOutcome>(
      async (manager) => {
        const passport = await manager.getRepository(BirdPassport).findOne({
          where: {
            code: dto.code,
            ownerMobile: dto.ownerMobile,
            status: BirdPassportStatus.ACTIVE,
          },
          select: { id: true },
          lock: { mode: 'pessimistic_read' },
        });
        if (!passport) {
          await this.compareOtp(dto.otp, DUMMY_BCRYPT_HASH);
          return { valid: false };
        }

        await manager.query('SELECT pg_advisory_xact_lock(hashtext($1))', [
          `bird-passport-otp:${passport.id}:${dto.ownerMobile}`,
        ]);
        const repository = manager.getRepository(BirdPassportOtp);
        const otp = await this.findLatestOtp(
          repository,
          passport.id,
          dto.ownerMobile,
        );
        if (
          !otp ||
          otp.consumed ||
          otp.expiresAt <= new Date() ||
          otp.attempts >= MAX_OTP_ATTEMPTS
        ) {
          await this.compareOtp(dto.otp, DUMMY_BCRYPT_HASH);
          return { valid: false };
        }

        const matches = await this.compareOtp(dto.otp, otp.codeHash);
        if (!matches) {
          otp.attempts += 1;
          if (otp.attempts >= MAX_OTP_ATTEMPTS) otp.consumed = true;
          await repository.save(otp);
          return { valid: false };
        }

        otp.consumed = true;
        await repository.save(otp);
        return { valid: true, passportId: passport.id };
      },
    );
    this.cleanup.schedule();

    if (!outcome.valid) {
      throw new UnauthorizedException(PUBLIC_OTP_FAILURE_MESSAGE);
    }
    return { passportId: outcome.passportId };
  }

  async getPublicPassport(passportId: string, code: string) {
    const passport = await this.passports.findOne({
      where: { id: passportId, code, status: BirdPassportStatus.ACTIVE },
      relations: {
        vaccineRecords: true,
        feedingRecords: true,
        veterinaryVisits: true,
      },
    });
    if (!passport) throw new NotFoundException('Bird passport not found');
    return toPublicBirdPassport(passport);
  }

  readPublicImage(passportId: string, code: string) {
    return this.images.readActiveImage(passportId, code);
  }

  private compareOtp(code: string, hash: string): Promise<boolean> {
    return bcrypt.compare(code, hash);
  }

  private async findLatestOtp(
    repository: Repository<BirdPassportOtp>,
    birdPassportId: string,
    phone: string,
  ): Promise<BirdPassportOtp | null> {
    const unconsumed = await repository.findOne({
      where: {
        birdPassportId,
        phone,
        purpose: BIRD_PASSPORT_OTP_PURPOSE,
        consumed: false,
      },
      order: { createdAt: 'DESC', id: 'DESC' },
      lock: { mode: 'pessimistic_write' },
    });
    const consumed = await repository.findOne({
      where: {
        birdPassportId,
        phone,
        purpose: BIRD_PASSPORT_OTP_PURPOSE,
        consumed: true,
      },
      order: { createdAt: 'DESC', id: 'DESC' },
      lock: { mode: 'pessimistic_write' },
    });
    if (!unconsumed) return consumed;
    if (!consumed) return unconsumed;
    const timeDifference =
      unconsumed.createdAt.getTime() - consumed.createdAt.getTime();
    if (timeDifference !== 0) return timeDifference > 0 ? unconsumed : consumed;
    return unconsumed.id > consumed.id ? unconsumed : consumed;
  }

  private async countRecentOtps(
    repository: Repository<BirdPassportOtp>,
    birdPassportId: string,
    phone: string,
    createdAfter: Date,
  ): Promise<number> {
    const common = {
      birdPassportId,
      phone,
      purpose: BIRD_PASSPORT_OTP_PURPOSE,
      createdAt: MoreThanOrEqual(createdAfter),
    };
    const unconsumed = await repository.count({
      where: { ...common, consumed: false },
    });
    const consumed = await repository.count({
      where: { ...common, consumed: true },
    });
    return unconsumed + consumed;
  }
}
