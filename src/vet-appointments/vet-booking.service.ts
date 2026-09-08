import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  HttpException,
  Injectable,
  InternalServerErrorException,
  NotFoundException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { randomBytes, randomUUID } from 'node:crypto';
import { isUUID } from 'class-validator';
import { DataSource, EntityManager, QueryFailedError } from 'typeorm';
import { normalizeBirdPassportCode } from '../bird-passports/bird-passport-code';
import { normalizeBirdPassportMobile } from '../bird-passports/mobile-normalizer';
import {
  BirdPassport,
  BirdPassportStatus,
} from '../bird-passports/entities/bird-passport.entity';
import { User, UserRole } from '../users/entities/user.entity';
import { BookVetAppointmentDto } from './dto/booking-request.dto';
import { VetBookingResponseDto } from './dto/booking-response.dto';
import { VetAppointmentEvent } from './entities/appointment-event.entity';
import { VetAppointmentSlot } from './entities/appointment-slot.entity';
import { VetAppointment } from './entities/appointment.entity';
import { VetAvailabilityWindow } from './entities/availability-window.entity';
import { VetDoctor } from './entities/doctor.entity';
import { VetFreeConsultationClaim } from './entities/free-consultation-claim.entity';
import {
  VetActorType,
  VetAppointmentStatus,
  VetAvailabilityStatus,
  VetFreeScope,
  VetPricingKind,
  VetSlotStatus,
} from './vet-appointment.enums';
import { VetBookingPolicy } from './policies/vet-booking.policy';
import { encryptVetField } from './security/vet-field-encryption';

type BookingInput = BookVetAppointmentDto & { passportCode?: string };

@Injectable()
export class VetBookingService {
  constructor(
    private readonly source: DataSource,
    private readonly config: ConfigService,
    private readonly policy: VetBookingPolicy,
  ) {}

  async book(customerUserId: string, raw: BookVetAppointmentDto) {
    const input = this.input(customerUserId, raw);
    const retry = await this.existing(
      this.source.manager,
      customerUserId,
      input,
    );
    if (retry) return retry;

    for (let attempt = 0; ; attempt++) {
      try {
        return await this.source.transaction(
          'READ COMMITTED',
          async (manager) =>
            this.bookInTransaction(manager, customerUserId, input),
        );
      } catch (error) {
        if (error instanceof HttpException) throw error;
        const code = this.postgresCode(error);
        if (['40P01', '40001', '55P03'].includes(code ?? '') && attempt < 2)
          continue;

        // The database retry key is final authority. A concurrent identical
        // request may have committed while this transaction waited on it.
        if (code === '23505') {
          const existing = await this.existing(
            this.source.manager,
            customerUserId,
            input,
          );
          if (existing) return existing;
        }
        if (
          [
            '23505',
            '23P01',
            '23514',
            '23503',
            '40P01',
            '40001',
            '55P03',
            '57014',
          ].includes(code ?? '')
        )
          throw new ConflictException(
            'Booking conflicts with current scheduling state',
          );
        if (['22007', '22008', '22P02', '22003'].includes(code ?? ''))
          throw new BadRequestException('Invalid booking input');
        throw new InternalServerErrorException('Booking operation failed');
      }
    }
  }

  private async bookInTransaction(
    manager: EntityManager,
    customerUserId: string,
    input: BookingInput,
  ) {
    await manager.query("SET LOCAL lock_timeout = '5s'");
    await manager.query("SET LOCAL statement_timeout = '15s'");

    const initialUser = await manager.getRepository(User).findOne({
      select: {
        id: true,
        phone: true,
        firstName: true,
        lastName: true,
        nationalId: true,
        profileCompleted: true,
        role: true,
      },
      where: { id: customerUserId },
    });
    if (!initialUser) throw new NotFoundException('Customer not found');
    if (initialUser.role !== UserRole.CUSTOMER)
      throw new ForbiddenException('Customer access required');
    this.customerProfile(initialUser);

    const initialPassport = input.passportCode
      ? await manager.getRepository(BirdPassport).findOne({
          select: {
            id: true,
            code: true,
            ownerMobile: true,
            ownerFullName: true,
            birdName: true,
            species: true,
            status: true,
          },
          where: { code: input.passportCode },
        })
      : null;
    if (input.passportCode && !initialPassport)
      throw new NotFoundException('Bird passport not found');
    if (initialPassport) this.authorizePassport(initialPassport, initialUser);
    if (
      this.policy.firstFreeScope === VetFreeScope.PASSPORT &&
      !initialPassport
    )
      throw new BadRequestException(
        'A bird passport is required for this booking policy',
      );

    const subjectId =
      this.policy.firstFreeScope === VetFreeScope.OWNER
        ? customerUserId
        : initialPassport!.id;
    await manager.query(
      'SELECT pg_advisory_xact_lock(hashtextextended($1, 0))',
      [
        `vet:booking:entitlement:${this.policy.version}:${this.policy.firstFreeScope}:${subjectId.toLowerCase()}`,
      ],
    );

    const retry = await this.existing(manager, customerUserId, input);
    if (retry) return retry;

    // Scheduling protocol is entitlement advisory lock, then slot row lock.
    const slot = await manager.getRepository(VetAppointmentSlot).findOne({
      where: { id: input.slotId },
      lock: { mode: 'pessimistic_write' },
    });
    if (!slot) throw new NotFoundException('Vet appointment slot not found');
    const [{ now }] = await manager.query<Array<{ now: Date }>>(
      'SELECT transaction_timestamp() AS now',
    );
    if (
      slot.status !== VetSlotStatus.AVAILABLE ||
      slot.startsAt.getTime() <= now.getTime()
    )
      throw new ConflictException('Vet appointment slot is unavailable');

    const user = await manager.getRepository(User).findOne({
      select: {
        id: true,
        phone: true,
        firstName: true,
        lastName: true,
        nationalId: true,
        profileCompleted: true,
        role: true,
      },
      where: { id: customerUserId },
      lock: { mode: 'pessimistic_read' },
    });
    if (!user) throw new NotFoundException('Customer not found');
    if (user.role !== UserRole.CUSTOMER)
      throw new ForbiddenException('Customer access required');
    const ownerFullName = this.customerProfile(user);

    const passport = initialPassport
      ? await manager.getRepository(BirdPassport).findOne({
          select: {
            id: true,
            code: true,
            ownerMobile: true,
            ownerFullName: true,
            birdName: true,
            species: true,
            status: true,
          },
          where: { id: initialPassport.id },
          lock: { mode: 'pessimistic_read' },
        })
      : null;
    if (initialPassport && !passport)
      throw new NotFoundException('Bird passport not found');
    if (passport) {
      if (passport.code !== input.passportCode)
        throw new ConflictException('Bird passport changed during booking');
      this.authorizePassport(passport, user);
      this.bookablePassport(passport);
    }

    const doctor = await manager.getRepository(VetDoctor).findOne({
      select: {
        id: true,
        displayName: true,
        active: true,
        consultationFeeMinor: true,
        currency: true,
      },
      where: { id: slot.doctorId },
      lock: { mode: 'pessimistic_read' },
    });
    if (!doctor) throw new NotFoundException('Vet doctor not found');
    if (!doctor.active) throw new ConflictException('Vet doctor is inactive');
    // Read and validate the fee even though the first eligible booking is free.
    if (!/^\d+$/.test(String(doctor.consultationFeeMinor)))
      throw new InternalServerErrorException('Vet doctor pricing is invalid');

    const window = await manager.getRepository(VetAvailabilityWindow).findOne({
      select: { id: true, status: true },
      where: { id: slot.availabilityWindowId },
    });
    if (!window || window.status !== VetAvailabilityStatus.ACTIVE)
      throw new ConflictException('Vet appointment slot is unavailable');

    const claim = await manager
      .getRepository(VetFreeConsultationClaim)
      .findOne({
        where:
          this.policy.firstFreeScope === VetFreeScope.OWNER
            ? {
                policyVersion: this.policy.version,
                subjectType: VetFreeScope.OWNER,
                ownerUserId: customerUserId,
              }
            : {
                policyVersion: this.policy.version,
                subjectType: VetFreeScope.PASSPORT,
                birdPassportId: passport!.id,
              },
      });
    if (claim)
      throw new ConflictException(this.policy.paymentUnavailableResult());

    const appointmentId = randomUUID();
    const confirmedAt = new Date(now);
    const appointment = manager.getRepository(VetAppointment).create({
      id: appointmentId,
      publicReference: `V${randomBytes(8).toString('hex').toUpperCase()}`,
      bookingRequestId: input.bookingRequestId,
      customerUserId,
      slotId: slot.id,
      doctorId: doctor.id,
      birdPassportId: passport?.id ?? null,
      status: VetAppointmentStatus.CONFIRMED,
      pricingKind: VetPricingKind.FREE,
      feeAmountMinor: '0',
      currency: doctor.currency,
      pricingRuleVersion: this.policy.version,
      holdExpiresAt: null,
      ownerFullNameSnapshot: ownerFullName,
      ownerMobileSnapshot: normalizeBirdPassportMobile(user.phone),
      doctorNameSnapshot: doctor.displayName.trim(),
      passportCodeSnapshot: passport?.code ?? null,
      birdNameSnapshot: passport?.birdName?.trim() ?? null,
      birdSpeciesSnapshot: passport?.species?.trim() ?? null,
      passportOwnerFullNameSnapshot: passport?.ownerFullName?.trim() ?? null,
      nationalIdCiphertext: encryptVetField(
        user.nationalId,
        this.encryptionKey(),
        `${appointmentId}:nationalId`,
      ),
      nationalIdLast4: user.nationalId.slice(-4),
      confirmedAt,
      completedAt: null,
      cancelledAt: null,
      cancelledByType: null,
      cancelledById: null,
      cancellationReason: null,
    });
    await manager.getRepository(VetAppointment).insert(appointment);
    await manager.getRepository(VetFreeConsultationClaim).insert({
      policyVersion: this.policy.version,
      subjectType: this.policy.firstFreeScope,
      ownerUserId:
        this.policy.firstFreeScope === VetFreeScope.OWNER
          ? customerUserId
          : null,
      birdPassportId:
        this.policy.firstFreeScope === VetFreeScope.PASSPORT
          ? passport!.id
          : null,
      appointmentId,
    });
    await manager.getRepository(VetAppointmentEvent).insert({
      appointmentId,
      eventType: 'CONFIRMED',
      eventKey: 'booking-confirmed',
      actorType: VetActorType.CUSTOMER,
      actorId: customerUserId,
      previousStatus: null,
      newStatus: VetAppointmentStatus.CONFIRMED,
      metadata: {},
    });
    return VetBookingResponseDto.from(appointment, slot);
  }

  private async existing(
    manager: EntityManager,
    customerUserId: string,
    input: BookingInput,
  ) {
    const appointment = await manager.getRepository(VetAppointment).findOneBy({
      customerUserId,
      bookingRequestId: input.bookingRequestId,
    });
    if (!appointment) return null;
    if (
      appointment.pricingKind !== VetPricingKind.FREE ||
      appointment.slotId !== input.slotId ||
      appointment.passportCodeSnapshot !== (input.passportCode ?? null)
    )
      throw new ConflictException(
        'Booking request identifier was already used',
      );
    if (!appointment.slotId)
      throw new ConflictException(
        'Booking request identifier was already used',
      );
    const slot = await manager.getRepository(VetAppointmentSlot).findOneBy({
      id: appointment.slotId,
    });
    if (!slot) throw new ConflictException('Original booking is unavailable');
    return VetBookingResponseDto.from(appointment, slot);
  }

  private input(
    customerUserId: string,
    input: BookVetAppointmentDto,
  ): BookingInput {
    if (
      !isUUID(customerUserId) ||
      !isUUID(input?.bookingRequestId) ||
      !isUUID(input?.slotId)
    )
      throw new BadRequestException('Invalid booking identifier');
    return {
      bookingRequestId: input.bookingRequestId.toLowerCase(),
      slotId: input.slotId.toLowerCase(),
      ...(input.passportCode
        ? { passportCode: normalizeBirdPassportCode(input.passportCode) }
        : {}),
    };
  }

  private customerProfile(user: User): string {
    const firstName = user.firstName?.trim() ?? '';
    const lastName = user.lastName?.trim() ?? '';
    const fullName = `${firstName} ${lastName}`;
    if (
      !user.profileCompleted ||
      !firstName ||
      !lastName ||
      fullName.length > 150 ||
      !/^09[0-9]{9}$/.test(user.phone) ||
      !/^[0-9]{10}$/.test(user.nationalId ?? '')
    )
      throw new BadRequestException('Customer profile is incomplete');
    return fullName;
  }

  private authorizePassport(passport: BirdPassport, user: User): void {
    if (
      normalizeBirdPassportMobile(passport.ownerMobile) !==
      normalizeBirdPassportMobile(user.phone)
    )
      throw new ForbiddenException('Bird passport does not belong to customer');
  }

  private bookablePassport(passport: BirdPassport): void {
    if (
      passport.status !== BirdPassportStatus.ACTIVE ||
      !passport.ownerFullName?.trim() ||
      !passport.birdName?.trim() ||
      !passport.species?.trim() ||
      passport.ownerFullName.trim().length > 150 ||
      passport.birdName.trim().length > 100 ||
      passport.species.trim().length > 150
    )
      throw new ConflictException('Bird passport is not bookable');
  }

  private encryptionKey(): Buffer {
    const encoded = (
      this.config.get<string>('VET_FIELD_ENCRYPTION_KEY') ??
      this.config.get<string>('VET_FIELD_ENCRYPTION_KEY_BASE64') ??
      ''
    ).trim();
    let key: Buffer;
    if (/^[0-9a-fA-F]{64}$/.test(encoded)) key = Buffer.from(encoded, 'hex');
    else if (/^[A-Za-z0-9+/_-]+={0,2}$/.test(encoded))
      key = Buffer.from(encoded, 'base64');
    else key = Buffer.alloc(0);
    if (key.length !== 32)
      throw new InternalServerErrorException(
        'Vet booking encryption is not configured',
      );
    return key;
  }

  private postgresCode(error: unknown): string | undefined {
    return error instanceof QueryFailedError
      ? (error.driverError as { code?: string }).code
      : undefined;
  }
}
