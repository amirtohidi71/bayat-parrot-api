export function resolveDatabaseSynchronize(
  nodeEnvironment: string | undefined,
  configuredOverride: string | undefined,
): boolean {
  const production = nodeEnvironment?.trim().toLowerCase() === 'production';
  if (configuredOverride === undefined) return !production;

  const normalizedOverride = configuredOverride.trim().toLowerCase();
  if (normalizedOverride === 'true') return !production;
  if (normalizedOverride === 'false') return false;

  throw new Error('DB_SYNCHRONIZE must be true or false');
}
