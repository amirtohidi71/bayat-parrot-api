import {
  Controller,
  Get,
  Param,
  ParseUUIDPipe,
  Query,
  UseGuards,
} from '@nestjs/common';
import { AdminAuthGuard } from '../admin/guards/admin-auth.guard';
import { AdminListVetAppointmentsDto } from './dto/appointment-query.dto';
import { VetAppointmentQueryService } from './vet-appointment-query.service';

@Controller('admin/vet/appointments')
@UseGuards(AdminAuthGuard)
export class AdminVetAppointmentQueryController {
  constructor(private readonly appointments: VetAppointmentQueryService) {}

  @Get()
  list(@Query() query: AdminListVetAppointmentsDto) {
    return this.appointments.listAdmin(query);
  }

  @Get(':appointmentId')
  detail(@Param('appointmentId', new ParseUUIDPipe()) appointmentId: string) {
    return this.appointments.detailAdmin(appointmentId);
  }
}
