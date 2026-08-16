import { constants } from 'fs';
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  open,
  readFile,
  readdir,
  rm,
  symlink,
  writeFile,
} from 'fs/promises';
import { tmpdir } from 'os';
import { join, resolve } from 'path';
import sharp from 'sharp';
import { validImage } from './bird-passport-image.test-fixtures';
import {
  BirdPassportImageStorageService,
  isAllowedProductionPrivateRoot,
} from './bird-passport-image-storage.service';

const FIRST_UUID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const SECOND_UUID = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const THIRD_UUID = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';

describe('BirdPassportImageStorageService', () => {
  let temporaryParent: string;
  let storageRoot: string;
  const originalNodeEnv = process.env.NODE_ENV;
  const originalStorage = process.env.BIRD_PASSPORT_PRIVATE_STORAGE_DIR;

  beforeEach(async () => {
    temporaryParent = await mkdtemp(join(tmpdir(), 'bird-passport-images-'));
    storageRoot = join(temporaryParent, 'private-root');
    process.env.NODE_ENV = 'test';
    process.env.BIRD_PASSPORT_PRIVATE_STORAGE_DIR = storageRoot;
  });

  afterEach(async () => {
    process.env.NODE_ENV = originalNodeEnv;
    if (originalStorage === undefined)
      delete process.env.BIRD_PASSPORT_PRIVATE_STORAGE_DIR;
    else process.env.BIRD_PASSPORT_PRIVATE_STORAGE_DIR = originalStorage;
    await rm(temporaryParent, { recursive: true, force: true });
  });

  it('stores only a lowercase UUID-v4 WebP identifier and canonical bytes', async () => {
    const service = new BirdPassportImageStorageService();
    const imagePath = await service.save(await validImage('png'), 'image/png');
    expect(imagePath).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.webp$/,
    );
    expect(imagePath).not.toContain(storageRoot);
    expect(
      (await sharp(await readFile(join(storageRoot, imagePath))).metadata())
        .format,
    ).toBe('webp');
    expect(
      (await readdir(storageRoot)).filter((name) => name.endsWith('.tmp')),
    ).toEqual([]);
  });

  it('returns safe internal metadata from the same private file', async () => {
    const service = new BirdPassportImageStorageService();
    const imagePath = await service.save(await validImage('webp'));
    const result = await service.read(imagePath);
    expect(result.mimeType).toBe('image/webp');
    expect(result.size).toBeGreaterThan(0);
    expect(result.buffer).toEqual(
      await readFile(resolve(storageRoot, imagePath)),
    );
    expect(result).not.toHaveProperty('absolutePath');
    expect(result).not.toHaveProperty('url');
  });

  it.each([
    'subdir/file.webp',
    '../file.webp',
    '..\\file.webp',
    'a/b/c.webp',
    'mixed\\path/file.webp',
    '/absolute.webp',
    'C:\\absolute.webp',
    '\\\\server\\share.webp',
    '%2e%2e%2ffile.webp',
    `${FIRST_UUID}.webp?x=1`,
    `${FIRST_UUID}.webp#fragment`,
    `${FIRST_UUID.toUpperCase()}.webp`,
  ])('rejects non-flat identifier %s', async (identifier) => {
    const service = new BirdPassportImageStorageService();
    await expect(service.read(identifier)).rejects.toThrow(
      'Invalid private image identifier',
    );
    await expect(service.delete(identifier)).rejects.toThrow(
      'Invalid private image identifier',
    );
  });

  it('never overwrites an existing UUID destination and retries with a new UUID', async () => {
    await mkdir(storageRoot, { recursive: true });
    const existingPath = join(storageRoot, `${FIRST_UUID}.webp`);
    const existing = Buffer.from('existing-private-file');
    await writeFile(existingPath, existing);
    class CollisionStorage extends BirdPassportImageStorageService {
      private readonly values = [
        FIRST_UUID,
        SECOND_UUID,
        THIRD_UUID,
        SECOND_UUID,
      ];
      protected randomUuid(): string {
        return this.values.shift() ?? THIRD_UUID;
      }
    }
    const result = await new CollisionStorage().save(await validImage('png'));
    expect(result).toBe(`${THIRD_UUID}.webp`);
    expect(await readFile(existingPath)).toEqual(existing);
    expect(
      (await readdir(storageRoot)).filter((name) => name.endsWith('.tmp')),
    ).toEqual([]);
  });

  it('cleans its temporary file after a publish failure', async () => {
    class InvalidUuidStorage extends BirdPassportImageStorageService {
      protected randomUuid(): string {
        return FIRST_UUID;
      }
    }
    await mkdir(storageRoot, { recursive: true });
    await writeFile(
      join(storageRoot, `${FIRST_UUID}.webp`),
      Buffer.from('existing'),
    );
    await expect(
      new InvalidUuidStorage().save(await validImage('png')),
    ).rejects.toThrow();
    expect(
      (await readdir(storageRoot)).filter((name) => name.endsWith('.tmp')),
    ).toEqual([]);
  });

  it('repairs and verifies existing directory permissions on POSIX', async () => {
    if (process.platform === 'win32') return;
    await mkdir(storageRoot, { recursive: true, mode: 0o777 });
    await chmod(storageRoot, 0o777);
    await new BirdPassportImageStorageService().save(await validImage('png'));
    expect((await lstat(storageRoot)).mode & 0o777).toBe(0o700);
  });

  it('creates final files with mode 0600 on POSIX', async () => {
    if (process.platform === 'win32') return;
    const imagePath = await new BirdPassportImageStorageService().save(
      await validImage('png'),
    );
    expect((await lstat(join(storageRoot, imagePath))).mode & 0o777).toBe(
      0o600,
    );
  });

  it('fails closed in production without an environment root or on non-Linux', async () => {
    process.env.NODE_ENV = 'production';
    delete process.env.BIRD_PASSPORT_PRIVATE_STORAGE_DIR;
    await expect(
      new BirdPassportImageStorageService().save(await validImage('png')),
    ).rejects.toThrow('not configured');
  });

  it('fails closed for a relative production root', async () => {
    process.env.NODE_ENV = 'production';
    process.env.BIRD_PASSPORT_PRIVATE_STORAGE_DIR = '.data/private';
    await expect(
      new BirdPassportImageStorageService().save(await validImage('png')),
    ).rejects.toThrow('not configured');
  });

  it('allows only the expected production shared/private subtree', () => {
    const base = '/opt/bayat-parrot/shared/private';
    expect(isAllowedProductionPrivateRoot(base, `${base}/bird-passports`)).toBe(
      true,
    );
    expect(
      isAllowedProductionPrivateRoot(
        base,
        '/opt/bayat-parrot/releases/r1/private',
      ),
    ).toBe(false);
    expect(
      isAllowedProductionPrivateRoot(base, '/opt/bayat-parrot/current/private'),
    ).toBe(false);
    expect(
      isAllowedProductionPrivateRoot(base, '/opt/bayat-parrot/shared/uploads'),
    ).toBe(false);
    expect(isAllowedProductionPrivateRoot(base, base)).toBe(false);
    expect(isAllowedProductionPrivateRoot(base, 'relative/private')).toBe(
      false,
    );
  });

  it('rejects public/uploads as a development root', async () => {
    process.env.BIRD_PASSPORT_PRIVATE_STORAGE_DIR = join(
      process.cwd(),
      'public',
      'uploads',
    );
    await expect(
      new BirdPassportImageStorageService().save(await validImage('png')),
    ).rejects.toThrow('not private');
  });

  const itPosix = process.platform === 'win32' ? it.skip : it;

  itPosix('rejects a configured root that is itself a symlink', async () => {
    const outside = join(temporaryParent, 'outside-root');
    await mkdir(outside);
    await symlink(outside, storageRoot, 'dir');
    await expect(
      new BirdPassportImageStorageService().save(await validImage('png')),
    ).rejects.toThrow('root is invalid');
  });

  itPosix(
    'does not follow a valid-looking image symlink during read or delete',
    async () => {
      await mkdir(storageRoot, { recursive: true });
      const outside = join(temporaryParent, 'outside.webp');
      await writeFile(outside, await validImage('webp'));
      const identifier = `${FIRST_UUID}.webp`;
      await symlink(outside, join(storageRoot, identifier), 'file');
      const service = new BirdPassportImageStorageService();
      await expect(service.read(identifier)).rejects.toThrow('unavailable');
      await expect(service.delete(identifier)).rejects.toThrow(
        'Invalid private image file',
      );
      expect(await readFile(outside)).toEqual(await validImage('webp'));
    },
  );

  itPosix(
    'opens private reads with O_NOFOLLOW and closes the descriptor',
    async () => {
      const service = new BirdPassportImageStorageService();
      const identifier = await service.save(await validImage('png'));
      const handle = await open(
        join(storageRoot, identifier),
        constants.O_RDONLY | constants.O_NOFOLLOW,
      );
      await handle.close();
      await expect(service.read(identifier)).resolves.toMatchObject({
        mimeType: 'image/webp',
      });
    },
  );
});
