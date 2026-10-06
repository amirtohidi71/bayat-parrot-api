import {
  Inject,
  Injectable,
  InternalServerErrorException,
} from '@nestjs/common';
import { randomUUID } from 'crypto';
import { link, lstat, mkdir, open, rm } from 'fs/promises';
import { resolve } from 'path';
import {
  PUBLIC_UPLOADS_PREFIX,
  PUBLIC_UPLOADS_ROOT,
} from '../../common/public-uploads-static';

export const PARROT_SALE_LISTING_PUBLIC_UPLOADS_ROOT = Symbol(
  'PARROT_SALE_LISTING_PUBLIC_UPLOADS_ROOT',
);

const PUBLIC_DIRECTORY = 'parrot-sale-listings';
const PUBLIC_PATH =
  /^\/uploads\/parrot-sale-listings\/[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.webp$/;
const MAX_UUID_ATTEMPTS = 3;

@Injectable()
export class ParrotSaleListingPublicImageService {
  constructor(
    @Inject(PARROT_SALE_LISTING_PUBLIC_UPLOADS_ROOT)
    private readonly uploadsRoot: string,
  ) {}

  async publish(buffers: readonly Buffer[]): Promise<string[]> {
    const published: string[] = [];
    try {
      for (const buffer of buffers)
        published.push(await this.publishOne(buffer));
      return published;
    } catch (error) {
      await this.remove(published);
      throw error;
    }
  }

  async remove(publicPaths: readonly string[]): Promise<void> {
    await Promise.all(
      publicPaths.map(async (publicPath) => {
        if (!PUBLIC_PATH.test(publicPath)) return;
        const filename = publicPath.slice(publicPath.lastIndexOf('/') + 1);
        const path = resolve(this.uploadsRoot, PUBLIC_DIRECTORY, filename);
        const entry = await lstat(path).catch(() => null);
        if (!entry) return;
        if (!entry.isFile() || entry.isSymbolicLink())
          throw new InternalServerErrorException('Invalid public image file');
        await rm(path);
      }),
    );
  }

  private async publishOne(buffer: Buffer): Promise<string> {
    const directory = resolve(this.uploadsRoot, PUBLIC_DIRECTORY);
    await mkdir(directory, { recursive: true, mode: 0o755 });
    for (let attempt = 0; attempt < MAX_UUID_ATTEMPTS; attempt++) {
      const filename = `${randomUUID()}.webp`;
      const destination = resolve(directory, filename);
      const temporary = resolve(directory, `.${randomUUID()}.tmp`);
      let linked = false;
      try {
        const handle = await open(temporary, 'wx', 0o644);
        try {
          await handle.writeFile(buffer);
          await handle.sync();
        } finally {
          await handle.close();
        }
        await link(temporary, destination);
        linked = true;
        await rm(temporary);
        return `${PUBLIC_UPLOADS_PREFIX}/${PUBLIC_DIRECTORY}/${filename}`;
      } catch (error) {
        await rm(temporary, { force: true }).catch(() => undefined);
        if (linked)
          await rm(destination, { force: true }).catch(() => undefined);
        if ((error as NodeJS.ErrnoException).code === 'EEXIST') continue;
        throw new InternalServerErrorException(
          'Could not publish parrot sale listing image',
        );
      }
    }
    throw new InternalServerErrorException(
      'Could not allocate public parrot sale listing image identifier',
    );
  }
}

export const parrotSaleListingPublicUploadsProvider = {
  provide: PARROT_SALE_LISTING_PUBLIC_UPLOADS_ROOT,
  useValue: PUBLIC_UPLOADS_ROOT,
};
