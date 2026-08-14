import {
  access,
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import sharp from 'sharp';
import { ProductReviewVideoStorageService } from './product-review-video-storage.service';

jest.mock('node:fs/promises', () => {
  const actual =
    jest.requireActual<typeof import('node:fs/promises')>('node:fs/promises');
  return {
    ...actual,
    chmod: jest.fn(actual.chmod),
    writeFile: jest.fn(actual.writeFile),
  };
});

const chmodMock = jest.mocked(chmod);
const writeFileMock = jest.mocked(writeFile);

function box(type: string, payload: Uint8Array = Buffer.alloc(0)): Buffer {
  const header = Buffer.alloc(8);
  header.writeUInt32BE(8 + payload.length, 0);
  header.write(type, 4, 4, 'ascii');
  return Buffer.concat([header, payload]);
}

function mp4(): Buffer {
  return Buffer.concat([
    box(
      'ftyp',
      Buffer.concat([
        Buffer.from('isom'),
        Buffer.alloc(4),
        Buffer.from('mp42'),
      ]),
    ),
    box(
      'moov',
      box(
        'trak',
        box(
          'mdia',
          box(
            'hdlr',
            Buffer.concat([
              Buffer.alloc(8),
              Buffer.from('vide'),
              Buffer.alloc(12),
            ]),
          ),
        ),
      ),
    ),
    box('mdat', Buffer.from([1])),
  ]);
}

function upload(
  fieldname: 'video' | 'cover',
  path: string,
  originalname: string,
  mimetype: string,
): Express.Multer.File {
  return { fieldname, path, originalname, mimetype } as Express.Multer.File;
}

describe('ProductReviewVideoStorageService', () => {
  let root: string;
  let staging: string;
  let service: ProductReviewVideoStorageService;

  beforeEach(async () => {
    jest.clearAllMocks();
    root = await mkdtemp(join(tmpdir(), 'review-video-storage-'));
    staging = join(root, '.staging');
    await mkdir(staging, { recursive: true });
    service = new ProductReviewVideoStorageService(root);
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it('promotes validated media with server-generated names and sanitized WebP cover', async () => {
    const videoPath = join(staging, 'video.upload');
    const coverPath = join(staging, 'cover.upload');
    await writeFile(videoPath, mp4());
    await writeFile(
      coverPath,
      await sharp({
        create: {
          width: 20,
          height: 20,
          channels: 3,
          background: '#123456',
        },
      })
        .png()
        .toBuffer(),
    );
    const prepared = await service.prepareCreate(
      upload('video', videoPath, 'client-name.mp4', 'video/mp4'),
      upload('cover', coverPath, 'client-name.png', 'image/png'),
    );
    expect(prepared).toMatchObject({ videoMimeType: 'video/mp4' });
    expect(prepared.videoPath).toMatch(
      /^product-review-videos\/videos\/[0-9a-f-]{36}\.mp4$/i,
    );
    expect(prepared.coverPath).toMatch(
      /^product-review-videos\/covers\/[0-9a-f-]{36}\.webp$/i,
    );
    await expect(
      access(join(root, ...prepared.videoPath.split('/'))),
    ).resolves.toBeUndefined();
    const coverFile = join(root, ...prepared.coverPath.split('/'));
    const videoFile = join(root, ...prepared.videoPath.split('/'));
    expect(chmodMock).toHaveBeenCalledWith(videoFile, 0o644);
    expect(writeFileMock).toHaveBeenCalledWith(coverFile, expect.any(Buffer), {
      flag: 'wx',
      mode: 0o644,
    });
    expect((await sharp(await readFile(coverFile)).metadata()).format).toBe(
      'webp',
    );
    await expect(access(videoPath)).rejects.toBeDefined();
    await expect(access(coverPath)).rejects.toBeDefined();
  });

  it('removes promoted media through validated storage keys', async () => {
    const videoPath = join(staging, 'video.upload');
    const coverPath = join(staging, 'cover.upload');
    await writeFile(videoPath, mp4());
    await writeFile(
      coverPath,
      await sharp({
        create: {
          width: 8,
          height: 8,
          channels: 3,
          background: '#ffffff',
        },
      })
        .webp()
        .toBuffer(),
    );
    const prepared = await service.prepareCreate(
      upload('video', videoPath, 'video.mp4', 'video/mp4'),
      upload('cover', coverPath, 'cover.webp', 'image/webp'),
    );
    await service.removeStored(prepared);
    await expect(
      access(join(root, ...prepared.videoPath.split('/'))),
    ).rejects.toBeDefined();
    await expect(
      access(join(root, ...prepared.coverPath.split('/'))),
    ).rejects.toBeDefined();
  });

  it('cleans staged and partially prepared files when cover validation fails', async () => {
    const videoPath = join(staging, 'video.upload');
    const coverPath = join(staging, 'cover.upload');
    await writeFile(videoPath, mp4());
    await writeFile(coverPath, Buffer.from('invalid image'));
    await expect(
      service.prepareCreate(
        upload('video', videoPath, 'video.mp4', 'video/mp4'),
        upload('cover', coverPath, 'cover.png', 'image/png'),
      ),
    ).rejects.toThrow('Review video cover content is invalid');
    await expect(access(videoPath)).rejects.toBeDefined();
    await expect(access(coverPath)).rejects.toBeDefined();
    expect(
      await readdir(join(root, 'product-review-videos', 'videos')),
    ).toEqual([]);
  });

  it('fails safely and removes the finalized video when chmod fails', async () => {
    const videoPath = join(staging, 'video.upload');
    await writeFile(videoPath, mp4());
    chmodMock.mockRejectedValueOnce(new Error('simulated chmod failure'));

    await expect(
      service.prepareReplacement({
        video: [upload('video', videoPath, 'video.mp4', 'video/mp4')],
      }),
    ).rejects.toThrow('Could not store product review video media');

    await expect(access(videoPath)).rejects.toBeDefined();
    expect(
      await readdir(join(root, 'product-review-videos', 'videos')),
    ).toEqual([]);
  });
});
