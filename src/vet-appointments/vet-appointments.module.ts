import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { TypeOrmModule } from '@nestjs/typeorm';
import { JwtModule } from '@nestjs/jwt';
import { ThrottlerModule } from '@nestjs/throttler';
import { VetDoctor } from './entities/doctor.entity';
import { VetAvailabilityWindow } from './entities/availability-window.entity';
import { VetAppointmentSlot } from './entities/appointment-slot.entity';
import { VetAppointment } from './entities/appointment.entity';
import { VetFreeConsultationClaim } from './entities/free-consultation-claim.entity';
import { VetAppointmentPayment } from './entities/appointment-payment.entity';
import { VetVideoRoom } from './entities/video-room.entity';
import { VetAppointmentEvent } from './entities/appointment-event.entity';
import { VetNotificationOutbox } from './entities/notification-outbox.entity';
import { VetBookingPolicy } from './policies/vet-booking.policy';
import { AdminModule } from '../admin/admin.module';
import { AdminVetAvailabilityController } from './admin-availability.controller';
import { VetAvailabilityService } from './availability.service';
import { CustomerVetBookingController } from './customer-booking.controller';
import { VetBookingService } from './vet-booking.service';
import { VetPaidHoldService } from './vet-paid-hold.service';
import { AdminVetManualAssignmentController } from './admin-manual-assignment.controller';
import { VetManualAssignmentService } from './vet-manual-assignment.service';
import {
  CustomerVetVideoController,
  DoctorVetVideoController,
} from './vet-video.controller';
import { VetDoctorAuthGuard } from './guards/vet-doctor-auth.guard';
import { VetDoctorLoginThrottlerGuard } from './guards/vet-doctor-login-throttler.guard';
import { VetDoctorAuthController } from './vet-doctor-auth.controller';
import { VetDoctorAuthService } from './vet-doctor-auth.service';
import { VetDoctorTokenService } from './vet-doctor-token.service';
import {
  InternalVetVideoProvider,
  VET_VIDEO_PROVIDER,
  VetVideoProvider,
} from './vet-video-provider';
import { VetVideoService } from './vet-video.service';
import {
  LIVEKIT_ROOM_TRANSPORT,
  LiveKitSdkRoomTransport,
  LiveKitVetVideoProvider,
} from './vet-livekit-provider';
import { CustomerVetAppointmentQueryController } from './customer-appointment-query.controller';
import { DoctorVetAppointmentQueryController } from './doctor-appointment-query.controller';
import { AdminVetAppointmentQueryController } from './admin-appointment-query.controller';
import { VetAppointmentQueryService } from './vet-appointment-query.service';

export function selectVetVideoProvider(
  config: ConfigService,
  livekit: LiveKitVetVideoProvider,
  internal: InternalVetVideoProvider,
): VetVideoProvider {
  const livekitValues = [
    config.get<string>('LIVEKIT_URL')?.trim(),
    config.get<string>('LIVEKIT_API_KEY')?.trim(),
    config.get<string>('LIVEKIT_API_SECRET')?.trim(),
  ];
  const complete = livekitValues.every(Boolean);
  const absent = livekitValues.every((value) => !value);
  const production =
    config.get<string>('NODE_ENV')?.trim().toLowerCase() === 'production';
  return complete || !absent || production ? livekit : internal;
}

export const VET_ENTITIES = [
  VetDoctor,
  VetAvailabilityWindow,
  VetAppointmentSlot,
  VetAppointment,
  VetFreeConsultationClaim,
  VetAppointmentPayment,
  VetVideoRoom,
  VetAppointmentEvent,
  VetNotificationOutbox,
];

@Module({
  imports: [
    TypeOrmModule.forFeature(VET_ENTITIES),
    AdminModule,
    JwtModule.register({}),
    ThrottlerModule.forRoot([
      { name: 'default', ttl: 15 * 60 * 1000, limit: 10 },
    ]),
  ],
  controllers: [
    AdminVetAvailabilityController,
    AdminVetManualAssignmentController,
    CustomerVetBookingController,
    CustomerVetVideoController,
    DoctorVetVideoController,
    VetDoctorAuthController,
    CustomerVetAppointmentQueryController,
    DoctorVetAppointmentQueryController,
    AdminVetAppointmentQueryController,
  ],
  providers: [
    VetBookingPolicy,
    VetAvailabilityService,
    VetBookingService,
    VetPaidHoldService,
    VetManualAssignmentService,
    VetDoctorAuthGuard,
    VetDoctorLoginThrottlerGuard,
    VetDoctorAuthService,
    VetDoctorTokenService,
    InternalVetVideoProvider,
    LiveKitVetVideoProvider,
    { provide: LIVEKIT_ROOM_TRANSPORT, useClass: LiveKitSdkRoomTransport },
    {
      provide: VET_VIDEO_PROVIDER,
      inject: [
        ConfigService,
        LiveKitVetVideoProvider,
        InternalVetVideoProvider,
      ],
      useFactory: selectVetVideoProvider,
    },
    VetVideoService,
    VetAppointmentQueryService,
  ],
  exports: [
    TypeOrmModule,
    VetBookingPolicy,
    VetAvailabilityService,
    VetBookingService,
    VetPaidHoldService,
    VetManualAssignmentService,
    VetVideoService,
    VetAppointmentQueryService,
  ],
})
export class VetAppointmentsModule {}
