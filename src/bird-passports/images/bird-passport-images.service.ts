import {
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { DataSource } from 'typeorm';
import {
  BirdPassport,
  BirdPassportStatus,
} from '../entities/bird-passport.entity';
import { BirdPassportImageStorageService } from './bird-passport-image-storage.service';

@Injectable()
export class BirdPassportImagesService {
  private readonly logger = new Logger(BirdPassportImagesService.name);

  constructor(
    private readonly dataSource: DataSource,
    private readonly storage: BirdPassportImageStorageService,
  ) {}

  async readImage(passportId: string) {
    const passport = await this.dataSource.getRepository(BirdPassport).findOne({
      where: { id: passportId },
      select: { id: true, imagePath: true },
    });
    if (!passport) throw new NotFoundException('Bird passport not found');
    if (!passport.imagePath)
      throw new NotFoundException('Bird passport image not found');
    return this.storage.read(passport.imagePath);
  }

  async readActiveImage(passportId: string, code: string) {
    const passport = await this.dataSource.getRepository(BirdPassport).findOne({
      where: { id: passportId, code, status: BirdPassportStatus.ACTIVE },
      select: { id: true, imagePath: true },
    });
    if (!passport) throw new NotFoundException('Bird passport not found');
    if (!passport.imagePath)
      throw new NotFoundException('Bird passport image not found');
    return this.storage.read(passport.imagePath);
  }

  async replaceImage(
    passportId: string,
    buffer: Buffer,
    suppliedMimeType?: string,
  ): Promise<BirdPassport> {
    const newImagePath = await this.storage.save(buffer, suppliedMimeType);
    let oldImagePath: string | null = null;
    let committed = false;
    try {
      const passport = await this.dataSource.transaction(async (manager) => {
        const repository = manager.getRepository(BirdPassport);
        const locked = await repository.findOne({
          where: { id: passportId },
          lock: { mode: 'pessimistic_write' },
        });
        if (!locked) throw new NotFoundException('Bird passport not found');
        if (locked.status === BirdPassportStatus.ARCHIVED)
          throw new ConflictException('Archived bird passports are read-only');
        oldImagePath = locked.imagePath;
        locked.imagePath = newImagePath;
        return repository.save(locked);
      });
      committed = true;
      if (oldImagePath && oldImagePath !== newImagePath) {
        await this.storage.delete(oldImagePath).catch(() => {
          this.logger.warn('Previous bird passport image could not be removed');
        });
      }
      return passport;
    } catch (error) {
      if (!committed)
        await this.storage.delete(newImagePath).catch(() => undefined);
      throw error;
    }
  }
}
