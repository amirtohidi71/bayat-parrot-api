import { join } from 'node:path';
import type { NestExpressApplication } from '@nestjs/platform-express';

export const PUBLIC_UPLOADS_ROOT = join(process.cwd(), 'public', 'uploads');
export const PUBLIC_UPLOADS_PREFIX = '/uploads';

export function configurePublicUploadsStatic(
  app: Pick<NestExpressApplication, 'useStaticAssets'>,
  root = PUBLIC_UPLOADS_ROOT,
): void {
  app.useStaticAssets(root, { prefix: PUBLIC_UPLOADS_PREFIX });
}
