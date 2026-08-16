import sharp from 'sharp';

export async function validImage(
  format: 'jpeg' | 'png' | 'webp',
  width = 32,
  height = 32,
): Promise<Buffer> {
  const pipeline = sharp({
    create: {
      width,
      height,
      channels: 3,
      background: { r: 20, g: 120, b: 200 },
    },
  });
  if (format === 'jpeg') return pipeline.jpeg().toBuffer();
  if (format === 'png') return pipeline.png().toBuffer();
  return pipeline.webp().toBuffer();
}
