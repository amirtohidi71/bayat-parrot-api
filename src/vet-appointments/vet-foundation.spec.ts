import { ConfigService } from '@nestjs/config';
import { DataSource } from 'typeorm';
import { randomBytes, randomUUID } from 'node:crypto';
import { VetBookingPolicy } from './policies/vet-booking.policy';
import { VetFreeScope } from './vet-appointment.enums';
import { VET_ENTITIES } from './vet-appointments.module';
import { VET_TEST_ENTITIES } from '../../test/vet-test-entities';
import {
  encryptVetField,
  decryptVetField,
} from './security/vet-field-encryption';

class MetadataSource extends DataSource {
  buildForTest() {
    return this.buildMetadatas();
  }
}

describe('Vet foundation metadata and policy', () => {
  it('builds all nine SQL-owned entities with explicit PostgreSQL timestamps and correct FK targets', async () => {
    const source = new MetadataSource({
      type: 'postgres',
      entities: VET_TEST_ENTITIES,
      synchronize: false,
    });
    await source.buildForTest();
    expect(VET_ENTITIES).toHaveLength(9);
    for (const entity of VET_ENTITIES) {
      const metadata = source.getMetadata(entity);
      expect(metadata.synchronize).toBe(false);
      expect(metadata.primaryColumns.map((c) => c.type)).toEqual(['uuid']);
      for (const column of metadata.columns.filter(
        (c) =>
          c.propertyName.endsWith('At') || c.propertyName === 'providerEndDate',
      )) {
        expect(column.type).toBe('timestamptz');
      }
      for (const foreignKey of metadata.foreignKeys) {
        expect(foreignKey.onDelete).toBe('RESTRICT');
        expect(foreignKey.referencedColumns.length).toBe(
          foreignKey.columns.length,
        );
      }
      for (const column of metadata.columns.filter((c) =>
        /Ciphertext|passwordHash|recipientPhoneSnapshot/.test(c.propertyName),
      )) {
        expect(column.isSelect).toBe(false);
      }
    }
  });

  it('defaults to OWNER and cannot enable payments through environment configuration', () => {
    const policy = new VetBookingPolicy(
      new ConfigService({ VET_PAYMENTS_ENABLED: true }),
    );
    expect(policy.firstFreeScope).toBe(VetFreeScope.OWNER);
    expect(policy.paymentsAvailable).toBe(false);
    expect(policy.paymentUnavailableResult()).toEqual({
      code: 'VET_PAYMENT_COMING_SOON',
      message: 'پرداخت آنلاین به‌زودی فعال می‌شود',
      paymentRequired: true,
      paymentAvailable: false,
      appointmentId: null,
      holdExpiresAt: null,
    });
  });

  it('can select PASSPORT for a future verified passport flow', () => {
    expect(
      new VetBookingPolicy(
        new ConfigService({ VET_FIRST_FREE_SCOPE: 'PASSPORT' }),
      ).firstFreeScope,
    ).toBe(VetFreeScope.PASSPORT);
  });

  it.each([
    { VET_FIRST_FREE_SCOPE: 'owner' },
    { VET_FIRST_FREE_SCOPE: '' },
    { VET_FIRST_FREE_SCOPE: 'PER_BIRD' },
    { VET_FIRST_FREE_POLICY_VERSION: '' },
    { VET_FIRST_FREE_POLICY_VERSION: 'unsafe policy' },
  ])('fails closed on invalid policy configuration %p', (config) => {
    expect(() => new VetBookingPolicy(new ConfigService(config))).toThrow();
  });
});

describe('Vet sensitive-field encryption', () => {
  it('uses randomized authenticated encryption bound to appointment and field', () => {
    const key = randomBytes(32);
    const context = `${randomUUID()}:nationalId`;
    const value = '0012345678';
    const first = encryptVetField(value, key, context);
    const second = encryptVetField(value, key, context);
    expect(first).not.toBe(second);
    expect(first).not.toContain(value);
    expect(first).toMatch(
      /^v1:[A-Za-z0-9_-]{16}:[A-Za-z0-9_-]{22}:[A-Za-z0-9_-]{14}$/,
    );
    expect(decryptVetField(first, key, context)).toBe(value);
    expect(() =>
      decryptVetField(first, key, `${randomUUID()}:nationalId`),
    ).toThrow('Unable to decrypt vet field');
    expect(() =>
      decryptVetField(first, key, context.replace('nationalId', 'hostUrl')),
    ).toThrow();
    expect(() => decryptVetField(first, randomBytes(32), context)).toThrow();
    const parts = first.split(':');
    parts[3] = (parts[3][0] === 'A' ? 'B' : 'A') + parts[3].slice(1);
    expect(() => decryptVetField(parts.join(':'), key, context)).toThrow();
  });

  it('rejects invalid keys, missing context and plaintext envelopes without leaking input', () => {
    expect(() => encryptVetField('private', Buffer.alloc(8), 'field')).toThrow(
      '32-byte',
    );
    expect(() => encryptVetField('private', randomBytes(32), '')).toThrow(
      'field context',
    );
    expect(() =>
      decryptVetField('private-national-id', randomBytes(32), 'field'),
    ).toThrow('Invalid vet encrypted field');
  });
});
