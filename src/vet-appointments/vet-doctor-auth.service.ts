import { Injectable, UnauthorizedException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import * as bcrypt from 'bcrypt';
import { Repository } from 'typeorm';
import { VetDoctorLoginDto } from './dto/vet-doctor-login.dto';
import { VetDoctor } from './entities/doctor.entity';
import { VetDoctorTokenService } from './vet-doctor-token.service';

const INVALID_CREDENTIALS = 'Invalid username or password';
const DUMMY_PASSWORD_HASH =
  '$2b$10$PKiS5pw/tWYFhlcMa9TaI.RdZRtUeNJuuNSutT32NjRRq/Zc8N4zC';

@Injectable()
export class VetDoctorAuthService {
  constructor(
    @InjectRepository(VetDoctor)
    private readonly doctors: Repository<VetDoctor>,
    private readonly tokens: VetDoctorTokenService,
  ) {}

  async login({ username, password }: VetDoctorLoginDto) {
    const canonicalUsername = username.trim().toLowerCase();
    const doctor = await this.doctors
      .createQueryBuilder('doctor')
      .addSelect('doctor.passwordHash')
      .where('lower(doctor.username) = :username', {
        username: canonicalUsername,
      })
      .getOne();

    const passwordMatches = await bcrypt
      .compare(password, doctor?.passwordHash ?? DUMMY_PASSWORD_HASH)
      .catch(() => false);
    if (!doctor?.active || !passwordMatches) {
      throw new UnauthorizedException(INVALID_CREDENTIALS);
    }

    return {
      accessToken: this.tokens.issue(doctor.id),
      expiresIn: this.tokens.expiresIn,
      doctor: {
        id: doctor.id,
        displayName: doctor.displayName,
      },
    };
  }
}
