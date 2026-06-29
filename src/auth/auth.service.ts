import { Injectable, Logger, UnauthorizedException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { JwtService } from '@nestjs/jwt';
import * as bcrypt from 'bcrypt';
import { Otp } from './entities/otp.entity';
import { UsersService } from '../users/users.service';
import { SendOtpDto } from './dto/send-otp.dto';
import { VerifyOtpDto } from './dto/verify-otp.dto';
import { CompleteRegistrationDto } from './dto/complete-registration.dto';
import { SmsService } from '../common/sms/sms.service';

const OTP_LENGTH = 5;
const OTP_EXPIRY_SECONDS = 120;

@Injectable()
export class AuthService {
  private readonly logger = new Logger(AuthService.name);

  constructor(
    @InjectRepository(Otp)
    private readonly otpsRepository: Repository<Otp>,
    private readonly usersService: UsersService,
    private readonly jwtService: JwtService,
    private readonly smsService: SmsService,
  ) {}

  async sendOtp({ phone }: SendOtpDto): Promise<{ message: string }> {
    const code = Math.floor(Math.random() * 10 ** OTP_LENGTH)
      .toString()
      .padStart(OTP_LENGTH, '0');
    const codeHash = await bcrypt.hash(code, 10);
    const expiresAt = new Date(Date.now() + OTP_EXPIRY_SECONDS * 1000);

    await this.otpsRepository.delete({ phone, consumed: false });
    await this.otpsRepository.save(this.otpsRepository.create({ phone, codeHash, expiresAt }));

    await this.smsService.send(phone, `کد تایید بیات پروت: ${code}`);

    return { message: 'OTP code sent' };
  }

  async verifyOtp({ phone, code }: VerifyOtpDto) {
    this.logger.debug(
      `verifyOtp called with phone=${JSON.stringify(phone)} (type=${typeof phone}) code=${JSON.stringify(code)} (type=${typeof code}, length=${code?.length})`,
    );

    const otp = await this.otpsRepository.findOne({
      where: { phone, consumed: false },
      order: { createdAt: 'DESC' },
    });

    if (!otp) {
      this.logger.debug(`verifyOtp phone=${phone}: no unconsumed OTP row found for this phone`);
      throw new UnauthorizedException('OTP code is invalid or expired');
    }

    if (otp.expiresAt < new Date()) {
      this.logger.debug(
        `verifyOtp phone=${phone}: OTP expired at ${otp.expiresAt.toISOString()} (now=${new Date().toISOString()})`,
      );
      throw new UnauthorizedException('OTP code is invalid or expired');
    }

    const codeMatches = await bcrypt.compare(code, otp.codeHash);
    this.logger.debug(
      `verifyOtp phone=${phone} receivedCode=${code} storedHash=${otp.codeHash} expiresAt=${otp.expiresAt.toISOString()} matches=${codeMatches}`,
    );
    if (!codeMatches) {
      throw new UnauthorizedException('OTP code is invalid or expired');
    }

    otp.consumed = true;
    await this.otpsRepository.save(otp);

    const existingUser = await this.usersService.findByPhone(phone);
    if (existingUser?.profileCompleted) {
      this.logger.log(
        `verifyOtp phone=${phone}: existing user ${existingUser.id} already has profileCompleted=true, returning token directly (skipping register)`,
      );
      const result = {
        ...this.buildToken(existingUser.id, existingUser.phone, existingUser.role),
        profileCompleted: true,
      };
      console.log('verifyOtp final response:', JSON.stringify(result));
      return result;
    }

    const user = existingUser ?? (await this.usersService.createWithPhone(phone));

    const result = {
      ...this.buildToken(user.id, user.phone, user.role),
      profileCompleted: user.profileCompleted,
    };
    console.log('verifyOtp final response:', JSON.stringify(result));
    return result;
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
