import {
  Controller,
  Get,
  Param,
  ParseUUIDPipe,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import { ListVetAppointmentsDto } from './dto/appointment-query.dto';
import type { VetDoctorTokenPayload } from './guards/vet-doctor-auth.guard';
import { VetDoctorAuthGuard } from './guards/vet-doctor-auth.guard';
import { VetAppointmentQueryService } from './vet-appointment-query.service';

@Controller('vet/doctor/appointments')
@UseGuards(VetDoctorAuthGuard)
export class DoctorVetAppointmentQueryController {
  constructor(private readonly appointments: VetAppointmentQueryService) {}

  @Get()
  list(
    @Req() request: { vetDoctor: VetDoctorTokenPayload },
    @Query() query: ListVetAppointmentsDto,
  ) {
    return this.appointments.listDoctor(request.vetDoctor.sub, query);
  }

  @Get(':appointmentId')
  detail(
    @Req() request: { vetDoctor: VetDoctorTokenPayload },
    @Param('appointmentId', new ParseUUIDPipe()) appointmentId: string,
  ) {
    return this.appointments.detailDoctor(request.vetDoctor.sub, appointmentId);
  }
}
