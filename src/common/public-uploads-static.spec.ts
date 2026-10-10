import { join, resolve } from 'node:path';
import {
  PRODUCTION_PUBLIC_UPLOADS_ROOT,
  resolvePublicUploadsRoot,
} from './public-uploads-static';

describe('public uploads root', () => {
  it('uses the durable shared uploads directory in production', () => {
    expect(
      resolvePublicUploadsRoot(
        { NODE_ENV: 'production' },
        '/opt/bayat-parrot/releases/20261010-001/backend',
      ),
    ).toBe(PRODUCTION_PUBLIC_UPLOADS_ROOT);
    expect(PRODUCTION_PUBLIC_UPLOADS_ROOT).toBe(
      '/opt/bayat-parrot/shared/uploads',
    );
  });

  it('keeps local development uploads inside the working tree', () => {
    const workingDirectory = resolve('local-backend');
    expect(
      resolvePublicUploadsRoot({ NODE_ENV: 'development' }, workingDirectory),
    ).toBe(join(workingDirectory, 'public', 'uploads'));
  });

  it('accepts only an explicit absolute root override', () => {
    const absoluteRoot = resolve('durable-uploads');
    expect(
      resolvePublicUploadsRoot(
        { NODE_ENV: 'production', PUBLIC_UPLOADS_ROOT: absoluteRoot },
        resolve('release-backend'),
      ),
    ).toBe(absoluteRoot);
    expect(() =>
      resolvePublicUploadsRoot({
        NODE_ENV: 'production',
        PUBLIC_UPLOADS_ROOT: 'relative/uploads',
      }),
    ).toThrow('PUBLIC_UPLOADS_ROOT must be an absolute path');
  });
});
