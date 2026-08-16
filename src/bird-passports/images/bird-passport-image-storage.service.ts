import { Injectable, InternalServerErrorException } from '@nestjs/common';
import { randomUUID } from 'crypto';
import { constants } from 'fs';
import {
  access,
  chmod,
  link,
  lstat,
  mkdir,
  open,
  realpath,
  rm,
  stat,
} from 'fs/promises';
import { isAbsolute, posix, relative, resolve, sep } from 'path';
import { sanitizeBirdPassportImage } from './bird-passport-image-validator';
import { PrivateBirdPassportImage } from './bird-passport-image.types';

const PRIVATE_IMAGE_IDENTIFIER =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.webp$/;
const MAX_UUID_ATTEMPTS = 3;
const PRODUCTION_PRIVATE_BASE = '/opt/bayat-parrot/shared/private';

@Injectable()
export class BirdPassportImageStorageService {
  private readonly configuredRoot: string | null;
  private readonly production: boolean;

  constructor() {
    this.production = process.env.NODE_ENV === 'production';
    const configured = process.env.BIRD_PASSPORT_PRIVATE_STORAGE_DIR?.trim();
    this.configuredRoot =
      configured && (!this.production || isAbsolute(configured))
        ? resolve(configured)
        : this.production
          ? null
          : resolve(process.cwd(), '.data', 'private', 'bird-passports');
  }

  async save(buffer: Buffer, suppliedMimeType?: string): Promise<string> {
    const sanitized = await sanitizeBirdPassportImage(buffer, suppliedMimeType);
    const root = await this.prepareRoot();
    for (let attempt = 0; attempt < MAX_UUID_ATTEMPTS; attempt++) {
      const imagePath = `${this.randomUuid()}.webp`;
      const destination = this.resolveIdentifier(root, imagePath);
      const temporary = this.resolveTemporary(
        root,
        `.${this.randomUuid()}.tmp`,
      );
      let published = false;
      try {
        await this.writePrivateTemporary(temporary, sanitized.buffer);
        await link(temporary, destination);
        published = true;
        await this.verifyPrivateFile(destination);
        await rm(temporary);
        return imagePath;
      } catch (error) {
        await rm(temporary, { force: true }).catch(() => undefined);
        if (published)
          await rm(destination, { force: true }).catch(() => undefined);
        if ((error as NodeJS.ErrnoException).code === 'EEXIST') continue;
        throw new InternalServerErrorException(
          'Could not store bird passport image',
        );
      }
    }
    throw new InternalServerErrorException(
      'Could not allocate bird passport image identifier',
    );
  }

  protected randomUuid(): string {
    return randomUUID();
  }

  async read(imagePath: string): Promise<PrivateBirdPassportImage> {
    const root = await this.prepareRoot();
    const candidate = this.resolveIdentifier(root, imagePath);
    if (process.platform === 'win32') {
      const entry = await lstat(candidate).catch(() => null);
      if (!entry?.isFile() || entry.isSymbolicLink()) throw unavailable();
    }
    const noFollow = process.platform === 'win32' ? 0 : constants.O_NOFOLLOW;
    const handle = await open(candidate, constants.O_RDONLY | noFollow).catch(
      () => {
        throw unavailable();
      },
    );
    try {
      const fileStat = await handle.stat();
      if (!fileStat.isFile()) throw unavailable();
      const data = await handle.readFile();
      await sanitizeBirdPassportImage(data, 'image/webp');
      return {
        buffer: data,
        mimeType: 'image/webp',
        size: data.length,
      };
    } finally {
      await handle.close();
    }
  }

  async delete(imagePath: string): Promise<void> {
    const root = await this.prepareRoot();
    const candidate = this.resolveIdentifier(root, imagePath);
    const entry = await lstat(candidate).catch(() => null);
    if (!entry) return;
    if (!entry.isFile() || entry.isSymbolicLink())
      throw new InternalServerErrorException('Invalid private image file');
    await rm(candidate);
  }

  private async writePrivateTemporary(
    path: string,
    buffer: Buffer,
  ): Promise<void> {
    const handle = await open(path, 'wx', 0o600);
    try {
      await handle.writeFile(buffer);
      await handle.sync();
    } finally {
      await handle.close();
    }
    await this.verifyPrivateFile(path);
  }

  private async prepareRoot(): Promise<string> {
    if (!this.configuredRoot)
      throw new InternalServerErrorException(
        'Private image storage is not configured',
      );
    if (this.production && process.platform !== 'linux')
      throw new InternalServerErrorException(
        'Private image storage requires Linux in production',
      );

    await mkdir(this.configuredRoot, { recursive: true, mode: 0o700 });
    const rootEntry = await lstat(this.configuredRoot);
    if (!rootEntry.isDirectory() || rootEntry.isSymbolicLink())
      throw new InternalServerErrorException(
        'Private image storage root is invalid',
      );
    const root = await realpath(this.configuredRoot);
    if (root !== this.configuredRoot)
      throw new InternalServerErrorException(
        'Private image storage root is invalid',
      );

    if (this.production) {
      const base = await realpath(PRODUCTION_PRIVATE_BASE).catch(() => null);
      if (!base || !isAllowedProductionPrivateRoot(base, root))
        throw new InternalServerErrorException(
          'Private image storage root is outside shared private area',
        );
    } else {
      const publicUploads = resolve(process.cwd(), 'public', 'uploads');
      if (root === publicUploads || this.isStrictlyInside(publicUploads, root))
        throw new InternalServerErrorException(
          'Private image storage is not private',
        );
    }

    if (process.platform !== 'win32') {
      await chmod(root, 0o700);
      const mode = (await stat(root)).mode & 0o777;
      if (mode !== 0o700)
        throw new InternalServerErrorException(
          'Private image storage permissions are unsafe',
        );
    }
    await access(root, constants.R_OK | constants.W_OK);
    return root;
  }

  private resolveIdentifier(root: string, imagePath: string): string {
    if (!PRIVATE_IMAGE_IDENTIFIER.test(imagePath))
      throw new InternalServerErrorException(
        'Invalid private image identifier',
      );
    return resolve(root, imagePath);
  }

  private resolveTemporary(root: string, name: string): string {
    if (!/^\.[0-9a-f-]{36}\.tmp$/.test(name))
      throw new InternalServerErrorException(
        'Invalid private temporary identifier',
      );
    return resolve(root, name);
  }

  private isStrictlyInside(parent: string, candidate: string): boolean {
    const difference = relative(parent, candidate);
    return (
      !!difference &&
      difference !== '..' &&
      !difference.startsWith(`..${sep}`) &&
      !isAbsolute(difference)
    );
  }

  private async verifyPrivateFile(path: string): Promise<void> {
    const entry = await lstat(path);
    if (!entry.isFile() || entry.isSymbolicLink())
      throw new InternalServerErrorException('Private image file is invalid');
    if (process.platform !== 'win32' && (entry.mode & 0o777) !== 0o600)
      throw new InternalServerErrorException(
        'Private image file permissions are unsafe',
      );
  }
}

function unavailable(): InternalServerErrorException {
  return new InternalServerErrorException('Bird passport image is unavailable');
}

export function isAllowedProductionPrivateRoot(
  base: string,
  root: string,
): boolean {
  const difference = posix.relative(base, root);
  return (
    posix.isAbsolute(base) &&
    posix.isAbsolute(root) &&
    !!difference &&
    difference !== '..' &&
    !difference.startsWith('../') &&
    !posix.isAbsolute(difference)
  );
}
