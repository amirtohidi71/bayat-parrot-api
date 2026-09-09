import { Body, Controller, Header, Post, UseGuards } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { VetDoctorLoginDto } from './dto/vet-doctor-login.dto';
import { VetDoctorLoginThrottlerGuard } from './guards/vet-doctor-login-throttler.guard';
import { VetDoctorAuthService } from './vet-doctor-auth.service';

@Controller('vet/doctor/auth')
@UseGuards(VetDoctorLoginThrottlerGuard)
export class VetDoctorAuthController {
  constructor(private readonly auth: VetDoctorAuthService) {}

  @Post('login')
  @Throttle({ default: { limit: 10, ttl: 15 * 60 * 1000 } })
  @Header('Cache-Control', 'no-store')
  login(@Body() dto: VetDoctorLoginDto) {
    return this.auth.login(dto);
  }
}
