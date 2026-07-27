import {
  Injectable,
  HttpException,
  HttpStatus,
  ServiceUnavailableException,
  UnauthorizedException,
} from '@nestjs/common';
import { DataSource } from 'typeorm';
import { JwtService } from '@nestjs/jwt';
import * as bcrypt from 'bcrypt';
import * as crypto from 'crypto';
import { Otp } from './entities/otp.entity';
import { UsersService } from '../users/users.service';
import { SendOtpDto } from './dto/send-otp.dto';
import { VerifyOtpDto } from './dto/verify-otp.dto';
import { CompleteRegistrationDto } from './dto/complete-registration.dto';
import { SmsService } from '../common/sms/sms.service';
import { SmsError } from '../common/sms/sms.types';

const OTP_LENGTH = 5;
const OTP_EXPIRY_SECONDS = 120;
const OTP_COOLDOWN_SECONDS = 120;
const MAX_OTP_ATTEMPTS = 5;

type VerifyOtpOutcome =
  | { valid: false }
  | { valid: true; phone: string };

@Injectable()
export class AuthService {
  constructor(
    private readonly dataSource: DataSource,
    private readonly usersService: UsersService,
    private readonly jwtService: JwtService,
    private readonly smsService: SmsService,
  ) {}

  async sendOtp({ phone }: SendOtpDto): Promise<{ message: string }> {
    const code = crypto
      .randomInt(0, 10 ** OTP_LENGTH)
      .toString()
      .padStart(OTP_LENGTH, '0');
    const codeHash = await bcrypt.hash(code, 10);
    const expiresAt = new Date(Date.now() + OTP_EXPIRY_SECONDS * 1000);

    try {
      await this.dataSource.transaction(async (manager) => {
        await manager.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`auth-otp:${phone}`]);
        const otpRepository = manager.getRepository(Otp);
        const latestOtp = await otpRepository.findOne({
          where: { phone },
          order: { createdAt: 'DESC' },
          lock: { mode: 'pessimistic_write' },
        });
        const cooldownStartedAt = new Date(Date.now() - OTP_COOLDOWN_SECONDS * 1000);
        if (latestOtp && latestOtp.createdAt > cooldownStartedAt) {
          throw new HttpException(
            'Please wait before requesting another OTP',
            HttpStatus.TOO_MANY_REQUESTS,
          );
        }

        await otpRepository.delete({ phone, consumed: false });
        await otpRepository.save(
          otpRepository.create({ phone, codeHash, expiresAt, attempts: 0 }),
        );
        // Keeping delivery inside this transaction makes a provider failure roll back only
        // the OTP created by this request and serializes concurrent sends for the same phone.
        await this.smsService.sendOtp(phone, code);
      });
    } catch (error) {
      if (error instanceof SmsError) {
        throw new ServiceUnavailableException('Unable to send verification code');
      }
      throw error;
    }

    return { message: 'OTP code sent' };
  }

  async verifyOtp({ phone, code }: VerifyOtpDto) {
    const outcome = await this.dataSource.transaction<VerifyOtpOutcome>(async (manager) => {
      await manager.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`auth-otp:${phone}`]);
      const otpRepository = manager.getRepository(Otp);
      const otp = await otpRepository.findOne({
        where: { phone, consumed: false },
        order: { createdAt: 'DESC' },
        lock: { mode: 'pessimistic_write' },
      });

      if (!otp) {
        return { valid: false };
      }
      if (otp.expiresAt < new Date()) {
        otp.consumed = true;
        await otpRepository.save(otp);
        return { valid: false };
      }

      const codeMatches = await bcrypt.compare(code, otp.codeHash);
      if (!codeMatches) {
        otp.attempts += 1;
        if (otp.attempts >= MAX_OTP_ATTEMPTS) {
          otp.consumed = true;
        }
        await otpRepository.save(otp);
        return { valid: false };
      }

      otp.consumed = true;
      await otpRepository.save(otp);
      return { valid: true, phone: otp.phone };
    });

    if (!outcome.valid) {
      throw new UnauthorizedException('OTP code is invalid or expired');
    }

    const existingUser = await this.usersService.findByPhone(outcome.phone);
    if (existingUser?.profileCompleted) {
      return {
        ...this.buildToken(existingUser.id, existingUser.phone, existingUser.role),
        profileCompleted: true,
      };
    }

    const user = existingUser ?? (await this.usersService.createWithPhone(outcome.phone));

    return {
      ...this.buildToken(user.id, user.phone, user.role),
      profileCompleted: user.profileCompleted,
    };
  }

  async register(userId: string, completeRegistrationDto: CompleteRegistrationDto) {
    const { firstName, lastName } = completeRegistrationDto;
    return this.usersService.completeRegistration(userId, firstName, lastName);
  }

  private buildToken(id: string, phone: string, role: string) {
    const payload = { sub: id, phone, role };
    return {
      accessToken: this.jwtService.sign(payload),
    };
  }
}
