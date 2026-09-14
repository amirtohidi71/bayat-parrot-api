import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import * as bcrypt from 'bcrypt';
import { QueryFailedError, Repository } from 'typeorm';
import {
  CreateAdminVetDoctorDto,
  UpdateAdminVetDoctorDto,
} from './dto/admin-vet-doctor.dto';
import { VetDoctor } from './entities/doctor.entity';

const BCRYPT_ROUNDS = 10;
const POSTGRES_UNIQUE_VIOLATION = '23505';
const MAX_POSTGRES_BIGINT = 9_223_372_036_854_775_807n;

export type AdminVetDoctorListItem = {
  id: string;
  displayName: string;
  mobile: string;
  username: string;
  active: boolean;
  consultationFeeMinor: string;
  currency: string;
};

@Injectable()
export class VetDoctorDirectoryService {
  constructor(
    @InjectRepository(VetDoctor)
    private readonly doctors: Repository<VetDoctor>,
  ) {}

  async list(): Promise<AdminVetDoctorListItem[]> {
    const doctors = await this.doctors.find({
      select: {
        id: true,
        displayName: true,
        mobile: true,
        username: true,
        active: true,
        consultationFeeMinor: true,
        currency: true,
      },
      order: { displayName: 'ASC' },
    });
    return doctors.map((doctor) => this.response(doctor));
  }

  async create(input: CreateAdminVetDoctorDto) {
    this.fee(input.consultationFeeMinor);
    const doctor = this.doctors.create({
      displayName: input.displayName,
      mobile: input.mobile,
      username: input.username,
      passwordHash: await bcrypt.hash(input.password, BCRYPT_ROUNDS),
      consultationFeeMinor: input.consultationFeeMinor,
      currency: input.currency,
      active: input.active ?? true,
    });
    try {
      return this.response(await this.doctors.save(doctor));
    } catch (error) {
      this.rethrowWriteError(error);
    }
  }

  async update(id: string, input: UpdateAdminVetDoctorDto) {
    if (Object.keys(input).length === 0)
      throw new BadRequestException('At least one doctor field is required');
    if (input.consultationFeeMinor !== undefined)
      this.fee(input.consultationFeeMinor);
    const doctor = await this.doctor(id);
    if (input.displayName !== undefined) doctor.displayName = input.displayName;
    if (input.mobile !== undefined) doctor.mobile = input.mobile;
    if (input.username !== undefined) doctor.username = input.username;
    if (input.consultationFeeMinor !== undefined)
      doctor.consultationFeeMinor = input.consultationFeeMinor;
    if (input.currency !== undefined) doctor.currency = input.currency;
    if (input.active !== undefined) doctor.active = input.active;
    if (input.password !== undefined)
      doctor.passwordHash = await bcrypt.hash(input.password, BCRYPT_ROUNDS);
    try {
      return this.response(await this.doctors.save(doctor));
    } catch (error) {
      this.rethrowWriteError(error);
    }
  }

  async activate(id: string) {
    return this.setActive(id, true);
  }

  async deactivate(id: string) {
    return this.setActive(id, false);
  }

  private async setActive(id: string, active: boolean) {
    const doctor = await this.doctor(id);
    doctor.active = active;
    try {
      return this.response(await this.doctors.save(doctor));
    } catch (error) {
      this.rethrowWriteError(error);
    }
  }

  private async doctor(id: string) {
    const doctor = await this.doctors.findOne({ where: { id } });
    if (!doctor) throw new NotFoundException('Vet doctor not found');
    return doctor;
  }

  private fee(value: string) {
    if (
      !/^(0|[1-9][0-9]{0,18})$/.test(value) ||
      BigInt(value) > MAX_POSTGRES_BIGINT
    )
      throw new BadRequestException('Consultation fee is out of range');
  }

  private response(doctor: VetDoctor): AdminVetDoctorListItem {
    return {
      id: doctor.id,
      displayName: doctor.displayName,
      mobile: doctor.mobile,
      username: doctor.username,
      active: doctor.active,
      consultationFeeMinor: String(doctor.consultationFeeMinor),
      currency: doctor.currency,
    };
  }

  private rethrowWriteError(error: unknown): never {
    const queryError = error as QueryFailedError & {
      code?: string;
      driverError?: { code?: string; constraint?: string };
    };
    const code = queryError.code ?? queryError.driverError?.code;
    if (
      error instanceof QueryFailedError &&
      code === POSTGRES_UNIQUE_VIOLATION
    ) {
      const constraint = queryError.driverError?.constraint;
      if (constraint === 'UQ_vet_doctors_username_ci')
        throw new ConflictException('Vet doctor username already exists');
      if (constraint === 'UQ_vet_doctors_mobile')
        throw new ConflictException('Vet doctor mobile already exists');
      throw new ConflictException(
        'Vet doctor username or mobile already exists',
      );
    }
    throw error;
  }
}
