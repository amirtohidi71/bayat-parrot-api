import { isInternalSalesChatSourcePath } from './sales-chat-internal-path';

describe('isInternalSalesChatSourcePath', () => {
  it.each(['/product/BP123/example', '/account/orders', '/جستجو/طوطی'])(
    'accepts an internal application path: %s',
    (value) => {
      expect(isInternalSalesChatSourcePath(value)).toBe(true);
    },
  );

  it.each([
    '//evil.example',
    '/\\evil.example',
    '\\evil.example',
    'https://evil.example',
    '/https://evil.example',
    '/%5cevil.example',
    '/%255cevil.example',
    '/%2f%2fevil.example',
    '/%252f%252fevil.example',
    '/product/example\nother',
    '/product/example\tother',
    '/product/example?next=https://evil.example',
    '/product/example#https://evil.example',
  ])('rejects an unsafe or externally interpretable path: %s', (value) => {
    expect(isInternalSalesChatSourcePath(value)).toBe(false);
  });
});
