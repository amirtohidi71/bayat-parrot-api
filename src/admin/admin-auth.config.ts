import { ConfigService } from '@nestjs/config';

const normalizeUsername = (value: string) => value.trim().toLowerCase();

export function configuredAdminUsernames(
  configService: ConfigService,
): string[] {
  return (configService.get<string>('ADMIN_USERS') ?? '')
    .split(',')
    .map((username) => username.trim())
    .filter(Boolean);
}

export function resolveConfiguredAdminUsername(
  configService: ConfigService,
  value: unknown,
): string | undefined {
  if (typeof value !== 'string') return undefined;

  const normalized = normalizeUsername(value);
  if (!normalized) return undefined;

  return configuredAdminUsernames(configService).find(
    (username) => normalizeUsername(username) === normalized,
  );
}

export function assertAdminAuthConfiguration(
  configService: ConfigService,
): void {
  const ownerUsername = configService.get<string>('GOD_ADMIN_USERNAME');
  if (!ownerUsername?.trim()) return;

  if (resolveConfiguredAdminUsername(configService, ownerUsername)) {
    throw new Error('Invalid admin authentication configuration');
  }
}
