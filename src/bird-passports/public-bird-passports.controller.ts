import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Post,
  Req,
  Res,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { ConfigService } from '@nestjs/config';
import type { Request, Response } from 'express';
import { normalizeBirdPassportCode } from './bird-passport-code';
import {
  BIRD_PASSPORT_LOOKUP_COOKIE,
  BIRD_PASSPORT_LOOKUP_GRANT_SECONDS,
  BirdPassportLookupGrantService,
} from './bird-passport-lookup-grant.service';
import {
  BirdPassportGrantRequest,
  BirdPassportLookupGuard,
} from './bird-passport-lookup.guard';
import { PublicRequestBirdPassportOtpDto } from './dto/public-request-bird-passport-otp.dto';
import { PublicVerifyBirdPassportOtpDto } from './dto/public-verify-bird-passport-otp.dto';
import { PublicBirdPassportNoStoreInterceptor } from './public-bird-passport-no-store.interceptor';
import { PublicBirdPassportsService } from './public-bird-passports.service';
import { PublicBirdPassportThrottlerGuard } from './public-bird-passport-throttler.guard';

const RATE_WINDOW_MS = 15 * 60 * 1000;

@Controller('bird-passports/public')
@UseGuards(PublicBirdPassportThrottlerGuard)
@Throttle({ default: { limit: 120, ttl: RATE_WINDOW_MS } })
@UseInterceptors(PublicBirdPassportNoStoreInterceptor)
export class PublicBirdPassportsController {
  constructor(
    private readonly passports: PublicBirdPassportsService,
    private readonly grants: BirdPassportLookupGrantService,
    private readonly config: ConfigService,
  ) {}

  @Post('request-otp')
  @HttpCode(HttpStatus.ACCEPTED)
  @Throttle({ default: { limit: 10, ttl: RATE_WINDOW_MS } })
  requestOtp(@Body() dto: PublicRequestBirdPassportOtpDto) {
    return this.passports.requestOtp(dto);
  }

  @Post('verify-otp')
  @HttpCode(HttpStatus.OK)
  @Throttle({ default: { limit: 20, ttl: RATE_WINDOW_MS } })
  async verifyOtp(
    @Body() dto: PublicVerifyBirdPassportOtpDto,
    @Res({ passthrough: true }) response: Response,
  ) {
    const { passportId } = await this.passports.verifyOtp(dto);
    const token = this.grants.issue(passportId);
    response.cookie(BIRD_PASSPORT_LOOKUP_COOKIE, token, {
      httpOnly: true,
      sameSite: 'lax',
      secure:
        this.config.get<string>('NODE_ENV')?.trim().toLowerCase() ===
        'production',
      path: '/bird-passports/public',
      maxAge: BIRD_PASSPORT_LOOKUP_GRANT_SECONDS * 1000,
    });
    return { message: 'Verification succeeded.' };
  }

  @Get(':code/image')
  @UseGuards(BirdPassportLookupGuard)
  async image(
    @Param('code') inputCode: string,
    @Req() request: Request & BirdPassportGrantRequest,
    @Res() response: Response,
  ) {
    const code = normalizeBirdPassportCode(inputCode);
    const image = await this.passports.readPublicImage(
      request.birdPassportGrant!.passportId,
      code,
    );
    response.set({
      'Content-Type': image.mimeType,
      'Content-Length': String(image.size),
      'Cache-Control': 'private, no-store',
      'X-Content-Type-Options': 'nosniff',
    });
    response.send(image.buffer);
  }

  @Get(':code')
  @UseGuards(BirdPassportLookupGuard)
  detail(
    @Param('code') inputCode: string,
    @Req() request: Request & BirdPassportGrantRequest,
  ) {
    return this.passports.getPublicPassport(
      request.birdPassportGrant!.passportId,
      normalizeBirdPassportCode(inputCode),
    );
  }
}
