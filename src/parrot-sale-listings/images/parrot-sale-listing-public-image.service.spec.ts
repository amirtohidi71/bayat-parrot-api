import { mkdtemp, readFile, rm } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { ParrotSaleListingPublicImageService } from './parrot-sale-listing-public-image.service';

describe('ParrotSaleListingPublicImageService', () => {
  let root: string;
  let service: ParrotSaleListingPublicImageService;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'parrot-listing-public-'));
    service = new ParrotSaleListingPublicImageService(root);
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it('publishes private sanitized bytes only under the dedicated public namespace', async () => {
    const bytes = Buffer.from('sanitized-webp');
    const [publicPath] = await service.publish([bytes]);
    expect(publicPath).toMatch(
      /^\/uploads\/parrot-sale-listings\/[0-9a-f-]{36}\.webp$/,
    );
    expect(
      await readFile(
        join(root, ...publicPath.replace('/uploads/', '').split('/')),
      ),
    ).toEqual(bytes);
  });

  it('removes only paths issued from the dedicated namespace', async () => {
    const [publicPath] = await service.publish([Buffer.from('image')]);
    await service.remove(['/uploads/other/file.webp', publicPath]);
    await expect(
      readFile(join(root, ...publicPath.replace('/uploads/', '').split('/'))),
    ).rejects.toMatchObject({ code: 'ENOENT' });
  });
});
