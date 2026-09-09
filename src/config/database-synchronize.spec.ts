import { resolveDatabaseSynchronize } from './database-synchronize';

describe('resolveDatabaseSynchronize', () => {
  it.each([
    ['development', 'false', false],
    ['development', 'true', true],
    ['production', 'true', false],
    ['production', 'false', false],
  ])(
    'resolves NODE_ENV=%s and DB_SYNCHRONIZE=%s to %s',
    (environment, override, expected) => {
      expect(resolveDatabaseSynchronize(environment, override)).toBe(expected);
    },
  );

  it.each([
    ['development', true],
    ['production', false],
  ])(
    'preserves existing behavior when the override is absent in %s',
    (environment, expected) => {
      expect(resolveDatabaseSynchronize(environment, undefined)).toBe(expected);
    },
  );

  it.each(['1', 'yes', 'enabled', '', ' true-ish '])(
    'rejects non-boolean override %p',
    (override) => {
      expect(() => resolveDatabaseSynchronize('development', override)).toThrow(
        'DB_SYNCHRONIZE must be true or false',
      );
    },
  );

  it('rejects an invalid override in production instead of loosely parsing it', () => {
    expect(() => resolveDatabaseSynchronize('production', 'yes')).toThrow(
      'DB_SYNCHRONIZE must be true or false',
    );
  });
});
