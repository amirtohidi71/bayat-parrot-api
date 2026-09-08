import {
  Controller,
  ForbiddenException,
  Param,
  ParseUUIDPipe,
  Post,
  Req,
  UseGuards,
} from '@nestjs/common';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import type { AuthenticatedUser } from '../auth/decorators/current-user.decorator';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import type { VetDoctorTokenPayload } from './guards/vet-doctor-auth.guard';
import { VetDoctorAuthGuard } from './guards/vet-doctor-auth.guard';
import { VetVideoService } from './vet-video.service';

@Controller('vet/appointments')
@UseGuards(JwtAuthGuard)
export class CustomerVetVideoController {
  constructor(private readonly video: VetVideoService) {}

  @Post(':appointmentId/video-room/join')
  join(
    @CurrentUser() user: AuthenticatedUser,
    @Param('appointmentId', new ParseUUIDPipe()) appointmentId: string,
  ) {
    if (user.role !== 'customer')
      throw new ForbiddenException('Customer access required');
    return this.video.joinCustomer(appointmentId, user.id);
  }
}

@Controller('vet/doctor/appointments')
@UseGuards(VetDoctorAuthGuard)
export class DoctorVetVideoController {
  constructor(private readonly video: VetVideoService) {}

  @Post(':appointmentId/video-room/join')
  join(
    @Req() request: { vetDoctor: VetDoctorTokenPayload },
    @Param('appointmentId', new ParseUUIDPipe()) appointmentId: string,
  ) {
    return this.video.joinDoctor(appointmentId, request.vetDoctor.sub);
  }
}
