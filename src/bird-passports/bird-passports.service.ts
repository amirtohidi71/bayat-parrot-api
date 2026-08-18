import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import {
  DataSource,
  EntityManager,
  FindOptionsWhere,
  ObjectLiteral,
  Repository,
} from 'typeorm';
import { assertNotFutureDateOnly, assertValidDateOnly } from './date-only';
import { CreateBirdPassportDto } from './dto/create-bird-passport.dto';
import { CreateFeedingRecordDto } from './dto/create-feeding-record.dto';
import { CreateVaccineRecordDto } from './dto/create-vaccine-record.dto';
import { CreateVeterinaryVisitDto } from './dto/create-veterinary-visit.dto';
import { UpdateBirdPassportDto } from './dto/update-bird-passport.dto';
import { UpdateFeedingRecordDto } from './dto/update-feeding-record.dto';
import { UpdateVaccineRecordDto } from './dto/update-vaccine-record.dto';
import { UpdateVeterinaryVisitDto } from './dto/update-veterinary-visit.dto';
import { BirdFeedingRecord } from './entities/bird-feeding-record.entity';
import {
  BirdPassport,
  BirdPassportStatus,
} from './entities/bird-passport.entity';
import { BirdVaccineRecord } from './entities/bird-vaccine-record.entity';
import { BirdVeterinaryVisit } from './entities/bird-veterinary-visit.entity';
import { normalizeBirdPassportMobile } from './mobile-normalizer';
import { AdminListBirdPassportsDto } from './dto/admin-list-bird-passports.dto';
import {
  escapePostgresLikePattern,
  normalizeAdminBirdPassportSearch,
} from './bird-passport-search';
import {
  BIRD_PASSPORT_BIRD_NAME_MAX_LENGTH,
  BIRD_PASSPORT_OWNER_FULL_NAME_MAX_LENGTH,
} from './bird-passport-metadata';

const FIRST_CODE_NUMBER = 25543210;
const LAST_CODE_NUMBER = 99999999;

@Injectable()
export class BirdPassportsService {
  constructor(
    @InjectRepository(BirdPassport)
    private readonly passportsRepository: Repository<BirdPassport>,
    private readonly dataSource: DataSource,
  ) {}

  create(dto: CreateBirdPassportDto): Promise<BirdPassport> {
    assertNotFutureDateOnly(dto.birthDate, 'birthDate');
    const ownerFullName = this.requiredText(
      dto.ownerFullName,
      'ownerFullName',
      BIRD_PASSPORT_OWNER_FULL_NAME_MAX_LENGTH,
    );
    const ownerMobile = normalizeBirdPassportMobile(dto.ownerMobile);
    const birdName = this.requiredText(
      dto.birdName,
      'birdName',
      BIRD_PASSPORT_BIRD_NAME_MAX_LENGTH,
    );
    const species = this.requiredText(dto.species, 'species');
    const subspecies = this.requiredText(dto.subspecies, 'subspecies');
    return this.dataSource.transaction(async (manager) => {
      const rows: unknown = await manager.query(
        `SELECT nextval('public.bird_passport_code_seq')::text AS "nextValue"`,
      );
      const rawSequenceValue = readNextSequenceValue(rows);
      if (
        typeof rawSequenceValue !== 'string' ||
        !/^\d+$/.test(rawSequenceValue)
      ) {
        throw new Error(
          'Bird passport code sequence returned an invalid value',
        );
      }
      const sequenceValue = Number(rawSequenceValue);
      if (
        !Number.isSafeInteger(sequenceValue) ||
        sequenceValue < FIRST_CODE_NUMBER ||
        sequenceValue > LAST_CODE_NUMBER
      ) {
        throw new Error(
          'Bird passport code sequence returned an invalid value',
        );
      }
      const digits = String(sequenceValue).padStart(8, '0');
      if (!/^\d{8}$/.test(digits))
        throw new Error('Bird passport code must contain 8 digits');

      const repository = manager.getRepository(BirdPassport);
      return repository.save(
        repository.create({
          code: `B${digits}`,
          ownerFullName,
          ownerMobile,
          birdName,
          birthDate: dto.birthDate,
          species,
          subspecies,
          imagePath: null,
          status: BirdPassportStatus.DRAFT,
        }),
      );
    });
  }

  listPassports(): Promise<BirdPassport[]> {
    return this.passportsRepository.find({
      order: { createdAt: 'DESC' },
    });
  }

  async listPassportsAdmin(query: AdminListBirdPassportsDto): Promise<{
    items: BirdPassport[];
    total: number;
    page: number;
    limit: number;
  }> {
    const page = query.page ?? 1;
    const limit = query.limit ?? 20;
    const builder = this.passportsRepository
      .createQueryBuilder('passport')
      .orderBy('passport.createdAt', 'DESC')
      .addOrderBy('passport.id', 'DESC')
      .skip((page - 1) * limit)
      .take(limit);
    if (query.status)
      builder.andWhere('passport.status = :status', { status: query.status });
    const search = normalizeAdminBirdPassportSearch(query.search);
    if (search) {
      builder.andWhere(
        `(passport.code ILIKE :search ESCAPE '\\' OR passport.ownerFullName ILIKE :search ESCAPE '\\' OR passport.birdName ILIKE :search ESCAPE '\\' OR passport.species ILIKE :search ESCAPE '\\' OR passport.subspecies ILIKE :search ESCAPE '\\' OR passport.ownerMobile ILIKE :search ESCAPE '\\')`,
        { search: `%${escapePostgresLikePattern(search)}%` },
      );
    }
    const [items, total] = await builder.getManyAndCount();
    return { items, total, page, limit };
  }

  async getById(id: string): Promise<BirdPassport> {
    const passport = await this.passportsRepository.findOne({
      where: { id },
      relations: {
        vaccineRecords: true,
        feedingRecords: true,
        veterinaryVisits: true,
      },
    });
    if (!passport)
      throw new NotFoundException(`Bird passport with id ${id} not found`);
    return passport;
  }

  async getByCode(code: string): Promise<BirdPassport> {
    const passport = await this.passportsRepository.findOne({
      where: { code },
    });
    if (!passport)
      throw new NotFoundException(`Bird passport with code ${code} not found`);
    return passport;
  }

  async updatePassport(
    id: string,
    dto: UpdateBirdPassportDto,
  ): Promise<BirdPassport> {
    return this.withLockedEditablePassport(id, async (manager, passport) => {
      if (dto.ownerFullName !== undefined) {
        passport.ownerFullName = this.requiredText(
          dto.ownerFullName,
          'ownerFullName',
          BIRD_PASSPORT_OWNER_FULL_NAME_MAX_LENGTH,
        );
      }
      if (dto.ownerMobile !== undefined) {
        passport.ownerMobile = normalizeBirdPassportMobile(dto.ownerMobile);
      }
      if (dto.birdName !== undefined) {
        passport.birdName = this.requiredText(
          dto.birdName,
          'birdName',
          BIRD_PASSPORT_BIRD_NAME_MAX_LENGTH,
        );
      }
      if (dto.birthDate !== undefined) {
        assertNotFutureDateOnly(dto.birthDate, 'birthDate');
        passport.birthDate = dto.birthDate;
      }
      if (dto.species !== undefined) {
        passport.species = this.requiredText(dto.species, 'species');
      }
      if (dto.subspecies !== undefined) {
        passport.subspecies = this.requiredText(dto.subspecies, 'subspecies');
      }
      return manager.getRepository(BirdPassport).save(passport);
    });
  }

  async activatePassport(id: string): Promise<BirdPassport> {
    return this.withLockedEditablePassport(id, async (manager, passport) => {
      if (
        !passport.ownerFullName?.trim() ||
        !passport.ownerMobile?.trim() ||
        !passport.birdName?.trim() ||
        !passport.birthDate?.trim() ||
        !passport.species?.trim() ||
        !passport.subspecies?.trim() ||
        !passport.imagePath?.trim()
      ) {
        throw new BadRequestException(
          'Bird passport required information and image must be complete before activation',
        );
      }
      passport.status = BirdPassportStatus.ACTIVE;
      return manager.getRepository(BirdPassport).save(passport);
    });
  }

  async archivePassport(id: string): Promise<BirdPassport> {
    return this.dataSource.transaction(async (manager) => {
      const passport = await this.getLockedPassport(manager, id);
      if (passport.status === BirdPassportStatus.ARCHIVED) {
        throw new ConflictException('Bird passport is already archived');
      }
      passport.status = BirdPassportStatus.ARCHIVED;
      return manager.getRepository(BirdPassport).save(passport);
    });
  }

  addVaccine(
    passportId: string,
    dto: CreateVaccineRecordDto,
  ): Promise<BirdVaccineRecord> {
    assertValidDateOnly(dto.vaccinationDate, 'vaccinationDate');
    return this.addOrderedRecord(
      passportId,
      BirdVaccineRecord,
      'vaccine',
      (repository, sortOrder) =>
        repository.create({
          passportId,
          vaccineName: this.requiredText(dto.vaccineName, 'vaccineName'),
          vaccinationDate: dto.vaccinationDate,
          sortOrder,
        }),
    );
  }

  async updateVaccine(
    passportId: string,
    recordId: string,
    dto: UpdateVaccineRecordDto,
  ): Promise<BirdVaccineRecord> {
    return this.withLockedEditablePassport(passportId, async (manager) => {
      const repository = manager.getRepository(BirdVaccineRecord);
      const record = await this.getOwnedRecord(
        repository,
        passportId,
        recordId,
        'Vaccine',
      );
      if (dto.vaccineName !== undefined) {
        record.vaccineName = this.requiredText(dto.vaccineName, 'vaccineName');
      }
      if (dto.vaccinationDate !== undefined) {
        assertValidDateOnly(dto.vaccinationDate, 'vaccinationDate');
        record.vaccinationDate = dto.vaccinationDate;
      }
      return repository.save(record);
    });
  }

  deleteVaccine(passportId: string, recordId: string): Promise<void> {
    return this.deleteOwnedRecord(
      BirdVaccineRecord,
      passportId,
      recordId,
      'Vaccine',
    );
  }

  addFeeding(
    passportId: string,
    dto: CreateFeedingRecordDto,
  ): Promise<BirdFeedingRecord> {
    return this.addOrderedRecord(
      passportId,
      BirdFeedingRecord,
      'feeding',
      (repository, sortOrder) =>
        repository.create({
          passportId,
          ageRange: this.requiredText(dto.ageRange, 'ageRange'),
          description: this.requiredText(dto.description, 'description'),
          sortOrder,
        }),
    );
  }

  async updateFeeding(
    passportId: string,
    recordId: string,
    dto: UpdateFeedingRecordDto,
  ): Promise<BirdFeedingRecord> {
    return this.withLockedEditablePassport(passportId, async (manager) => {
      const repository = manager.getRepository(BirdFeedingRecord);
      const record = await this.getOwnedRecord(
        repository,
        passportId,
        recordId,
        'Feeding',
      );
      if (dto.ageRange !== undefined) {
        record.ageRange = this.requiredText(dto.ageRange, 'ageRange');
      }
      if (dto.description !== undefined) {
        record.description = this.requiredText(dto.description, 'description');
      }
      return repository.save(record);
    });
  }

  deleteFeeding(passportId: string, recordId: string): Promise<void> {
    return this.deleteOwnedRecord(
      BirdFeedingRecord,
      passportId,
      recordId,
      'Feeding',
    );
  }

  addVeterinaryVisit(
    passportId: string,
    dto: CreateVeterinaryVisitDto,
  ): Promise<BirdVeterinaryVisit> {
    assertValidDateOnly(dto.visitDate, 'visitDate');
    return this.addOrderedRecord(
      passportId,
      BirdVeterinaryVisit,
      'veterinary',
      (repository, sortOrder) =>
        repository.create({
          passportId,
          visitDate: dto.visitDate,
          clinicalNotes: this.requiredText(dto.clinicalNotes, 'clinicalNotes'),
          veterinaryActions: this.requiredText(
            dto.veterinaryActions,
            'veterinaryActions',
          ),
          sortOrder,
        }),
    );
  }

  async updateVeterinaryVisit(
    passportId: string,
    recordId: string,
    dto: UpdateVeterinaryVisitDto,
  ): Promise<BirdVeterinaryVisit> {
    return this.withLockedEditablePassport(passportId, async (manager) => {
      const repository = manager.getRepository(BirdVeterinaryVisit);
      const record = await this.getOwnedRecord(
        repository,
        passportId,
        recordId,
        'Veterinary visit',
      );
      if (dto.visitDate !== undefined) {
        assertValidDateOnly(dto.visitDate, 'visitDate');
        record.visitDate = dto.visitDate;
      }
      if (dto.clinicalNotes !== undefined) {
        record.clinicalNotes = this.requiredText(
          dto.clinicalNotes,
          'clinicalNotes',
        );
      }
      if (dto.veterinaryActions !== undefined) {
        record.veterinaryActions = this.requiredText(
          dto.veterinaryActions,
          'veterinaryActions',
        );
      }
      return repository.save(record);
    });
  }

  deleteVeterinaryVisit(passportId: string, recordId: string): Promise<void> {
    return this.deleteOwnedRecord(
      BirdVeterinaryVisit,
      passportId,
      recordId,
      'Veterinary visit',
    );
  }

  private async addOrderedRecord<
    T extends ObjectLiteral & { sortOrder: number },
  >(
    passportId: string,
    entity: new () => T,
    recordType: string,
    create: (repository: Repository<T>, sortOrder: number) => T,
  ): Promise<T> {
    return this.dataSource.transaction(async (manager) => {
      await this.getEditablePassportInTransaction(manager, passportId);
      const repository = manager.getRepository(entity);
      await manager.query('SELECT pg_advisory_xact_lock(hashtext($1))', [
        `bird-passport:${passportId}:${recordType}:sort`,
      ]);
      const latest = await repository.findOne({
        where: { passportId } as unknown as FindOptionsWhere<T>,
        order: { sortOrder: 'DESC' } as never,
      });
      const sortOrder = (latest?.sortOrder ?? -1) + 1;
      return repository.save(create(repository, sortOrder));
    });
  }

  private async getEditablePassportInTransaction(
    manager: EntityManager,
    passportId: string,
  ): Promise<BirdPassport> {
    const passport = await this.getLockedPassport(manager, passportId);
    if (passport.status === BirdPassportStatus.ARCHIVED) {
      throw new ConflictException('Archived bird passports are read-only');
    }
    return passport;
  }

  private async getLockedPassport(
    manager: EntityManager,
    passportId: string,
  ): Promise<BirdPassport> {
    const passport = await manager.getRepository(BirdPassport).findOne({
      where: { id: passportId },
      lock: { mode: 'pessimistic_write' },
    });
    if (!passport) {
      throw new NotFoundException(
        `Bird passport with id ${passportId} not found`,
      );
    }
    return passport;
  }

  private withLockedEditablePassport<T>(
    passportId: string,
    mutation: (manager: EntityManager, passport: BirdPassport) => Promise<T>,
  ): Promise<T> {
    return this.dataSource.transaction(async (manager) => {
      const passport = await this.getEditablePassportInTransaction(
        manager,
        passportId,
      );
      return mutation(manager, passport);
    });
  }

  private async getOwnedRecord<T extends ObjectLiteral>(
    repository: Repository<T>,
    passportId: string,
    recordId: string,
    label: string,
  ): Promise<T> {
    const record = await repository.findOne({
      where: { id: recordId, passportId } as unknown as FindOptionsWhere<T>,
    });
    if (!record)
      throw new NotFoundException(
        `${label} record not found for this bird passport`,
      );
    return record;
  }

  private deleteOwnedRecord<T extends ObjectLiteral>(
    entity: new () => T,
    passportId: string,
    recordId: string,
    label: string,
  ): Promise<void> {
    return this.withLockedEditablePassport(passportId, async (manager) => {
      const repository = manager.getRepository(entity);
      const record = await this.getOwnedRecord(
        repository,
        passportId,
        recordId,
        label,
      );
      await repository.remove(record);
    });
  }

  private requiredText(
    value: string,
    field: string,
    maxLength?: number,
  ): string {
    const normalized = value.trim();
    if (!normalized) throw new BadRequestException(`${field} is required`);
    if (maxLength !== undefined && normalized.length > maxLength) {
      throw new BadRequestException(
        `${field} must not exceed ${maxLength} characters`,
      );
    }
    return normalized;
  }
}

function readNextSequenceValue(rows: unknown): unknown {
  if (!Array.isArray(rows) || rows.length === 0) return undefined;
  const first: unknown = rows[0];
  if (typeof first !== 'object' || first === null || !('nextValue' in first)) {
    return undefined;
  }
  return (first as Record<string, unknown>).nextValue;
}
