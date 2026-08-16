/* eslint-disable @typescript-eslint/require-await -- Jest mocks implement asynchronous storage and transaction interfaces. */
import { ConflictException, Logger, NotFoundException } from '@nestjs/common';
import {
  BirdPassport,
  BirdPassportStatus,
} from '../entities/bird-passport.entity';
import { BirdPassportImagesService } from './bird-passport-images.service';

function context(
  status = BirdPassportStatus.DRAFT,
  oldImage: string | null = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa.webp',
) {
  const row = Object.assign(new BirdPassport(), {
    id: 'passport-1',
    status,
    imagePath: oldImage,
  });
  const repository = {
    findOne: jest.fn().mockResolvedValue(row),
    save: jest.fn(async (value: BirdPassport) => value),
  };
  const manager = { getRepository: jest.fn(() => repository) };
  const dataSource = {
    transaction: jest.fn(
      async (callback: (value: { getRepository: jest.Mock }) => unknown) =>
        callback(manager),
    ),
    getRepository: jest.fn(() => repository),
  };
  const storage = {
    save: jest
      .fn()
      .mockResolvedValue('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb.webp'),
    delete: jest.fn().mockResolvedValue(undefined),
    read: jest.fn().mockResolvedValue({
      buffer: Buffer.from('webp'),
      mimeType: 'image/webp',
      size: 4,
    }),
  };
  return {
    service: new BirdPassportImagesService(
      dataSource as never,
      storage as never,
    ),
    row,
    repository,
    dataSource,
    storage,
  };
}

describe('BirdPassportImagesService', () => {
  it('reads an existing private image for admin use, including archived passports', async () => {
    const value = context(BirdPassportStatus.ARCHIVED);
    await expect(value.service.readImage('passport-1')).resolves.toMatchObject({
      mimeType: 'image/webp',
      size: 4,
    });
    expect(value.storage.read).toHaveBeenCalledWith(
      'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa.webp',
    );
  });

  it('rejects private read for a missing passport or missing image', async () => {
    const missingPassport = context();
    missingPassport.repository.findOne.mockResolvedValueOnce(null);
    await expect(
      missingPassport.service.readImage('missing'),
    ).rejects.toBeInstanceOf(NotFoundException);
    const missingImage = context(BirdPassportStatus.DRAFT, null);
    await expect(
      missingImage.service.readImage('passport-1'),
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  it('reads a public image only through an active matching passport', async () => {
    const value = context(BirdPassportStatus.ACTIVE);
    await expect(
      value.service.readActiveImage('passport-1', 'B25543210'),
    ).resolves.toMatchObject({ mimeType: 'image/webp', size: 4 });
    expect(value.repository.findOne).toHaveBeenCalledWith({
      where: {
        id: 'passport-1',
        code: 'B25543210',
        status: BirdPassportStatus.ACTIVE,
      },
      select: { id: true, imagePath: true },
    });
  });

  it('fails closed when an active public image binding is no longer valid', async () => {
    const value = context(BirdPassportStatus.ARCHIVED);
    value.repository.findOne.mockResolvedValueOnce(null);
    await expect(
      value.service.readActiveImage('passport-1', 'B25543210'),
    ).rejects.toBeInstanceOf(NotFoundException);
    expect(value.storage.read).not.toHaveBeenCalled();
  });

  it('saves first, row-locks, updates the relative imagePath and deletes old after commit', async () => {
    const value = context();
    const result = await value.service.replaceImage(
      'passport-1',
      Buffer.from('image'),
      'image/png',
    );
    expect(value.storage.save).toHaveBeenCalled();
    expect(value.repository.findOne).toHaveBeenCalledWith({
      where: { id: 'passport-1' },
      lock: { mode: 'pessimistic_write' },
    });
    expect(result.imagePath).toBe('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb.webp');
    expect(value.storage.delete).toHaveBeenCalledWith(
      'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa.webp',
    );
    expect(
      value.dataSource.transaction.mock.invocationCallOrder[0],
    ).toBeLessThan(value.storage.delete.mock.invocationCallOrder[0]);
  });

  it('removes the new image when the DB update fails', async () => {
    const value = context();
    value.repository.save.mockRejectedValueOnce(new Error('DB failed'));
    await expect(
      value.service.replaceImage('passport-1', Buffer.from('image')),
    ).rejects.toThrow('DB failed');
    expect(value.storage.delete).toHaveBeenCalledWith(
      'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb.webp',
    );
    expect(value.storage.delete).not.toHaveBeenCalledWith(
      'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa.webp',
    );
  });

  it('rejects archived replacement under the row lock and removes the new file', async () => {
    const value = context(BirdPassportStatus.ARCHIVED);
    await expect(
      value.service.replaceImage('passport-1', Buffer.from('image')),
    ).rejects.toBeInstanceOf(ConflictException);
    expect(value.storage.delete).toHaveBeenCalledWith(
      'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb.webp',
    );
    expect(value.repository.save).not.toHaveBeenCalled();
    expect(value.row.imagePath).toBe(
      'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa.webp',
    );
  });

  it('keeps the committed new image when deleting the old image fails', async () => {
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    const value = context();
    value.storage.delete.mockRejectedValueOnce(new Error('delete failed'));
    const result = await value.service.replaceImage(
      'passport-1',
      Buffer.from('image'),
    );
    expect(result.imagePath).toBe('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb.webp');
    expect(value.storage.delete).toHaveBeenCalledTimes(1);
  });

  it('serializes two replacements and never deletes the final winning image', async () => {
    const first = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb.webp';
    const second = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc.webp';
    const original = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa.webp';
    const database = { imagePath: original, status: BirdPassportStatus.DRAFT };
    const lockEvents: string[] = [];
    const deleteEvents: string[] = [];
    const repository = {
      findOne: jest.fn(async () => {
        lockEvents.push('pessimistic-write');
        return Object.assign(new BirdPassport(), {
          id: 'passport-1',
          status: database.status,
          imagePath: database.imagePath,
        });
      }),
      save: jest.fn(async (passport: BirdPassport) => {
        database.imagePath = passport.imagePath!;
        return passport;
      }),
    };
    const manager = { getRepository: jest.fn(() => repository) };
    let transactionTail = Promise.resolve<unknown>(undefined);
    const dataSource = {
      transaction: jest.fn(
        (callback: (value: typeof manager) => Promise<unknown>) => {
          const current = transactionTail.then(() => callback(manager));
          transactionTail = current.catch(() => undefined);
          return current;
        },
      ),
    };
    const storage = {
      save: jest
        .fn()
        .mockResolvedValueOnce(first)
        .mockResolvedValueOnce(second),
      delete: jest.fn(async (path: string) => {
        deleteEvents.push(path);
      }),
    };
    const service = new BirdPassportImagesService(
      dataSource as never,
      storage as never,
    );

    await Promise.all([
      service.replaceImage('passport-1', Buffer.from('first')),
      service.replaceImage('passport-1', Buffer.from('second')),
    ]);

    expect(lockEvents).toEqual(['pessimistic-write', 'pessimistic-write']);
    expect(repository.findOne).toHaveBeenCalledTimes(2);
    for (const [options] of repository.findOne.mock.calls as unknown as Array<
      [{ lock: { mode: string } }]
    >) {
      expect(options).toMatchObject({ lock: { mode: 'pessimistic_write' } });
    }
    expect(database.imagePath).toBe(second);
    expect(deleteEvents).toEqual(expect.arrayContaining([original, first]));
    expect(deleteEvents).not.toContain(second);
  });
});
