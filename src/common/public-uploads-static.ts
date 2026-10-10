import { isAbsolute, join, resolve } from 'node:path';
import type { NestExpressApplication } from '@nestjs/platform-express';

export const PRODUCTION_PUBLIC_UPLOADS_ROOT =
  '/opt/bayat-parrot/shared/uploads';

type PublicUploadsEnvironment = {
  NODE_ENV?: string;
  PUBLIC_UPLOADS_ROOT?: string;
};

export function resolvePublicUploadsRoot(
  environment: PublicUploadsEnvironment = process.env,
  workingDirectory = process.cwd(),
): string {
  const configuredRoot = environment.PUBLIC_UPLOADS_ROOT?.trim();
  if (configuredRoot) {
    if (!isAbsolute(configuredRoot))
      throw new Error('PUBLIC_UPLOADS_ROOT must be an absolute path');
    return resolve(configuredRoot);
  }
  return environment.NODE_ENV === 'production'
    ? PRODUCTION_PUBLIC_UPLOADS_ROOT
    : join(workingDirectory, 'public', 'uploads');
}

export const PUBLIC_UPLOADS_ROOT = resolvePublicUploadsRoot();
export const PUBLIC_UPLOADS_PREFIX = '/uploads';

export function configurePublicUploadsStatic(
  app: Pick<NestExpressApplication, 'useStaticAssets'>,
  root = PUBLIC_UPLOADS_ROOT,
): void {
  app.useStaticAssets(root, { prefix: PUBLIC_UPLOADS_PREFIX });
}
