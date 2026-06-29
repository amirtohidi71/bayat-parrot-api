import { NestFactory } from '@nestjs/core';
import { AppModule } from '../app.module';
import { ProductsService } from '../products/products.service';

function getSkuArg(): string {
  const arg = process.argv.find((a) => a.startsWith('--id='));
  if (!arg) {
    throw new Error('Usage: npm run publish-product -- --id=BP30171000');
  }
  return arg.slice('--id='.length);
}

async function run() {
  const sku = getSkuArg();
  const app = await NestFactory.createApplicationContext(AppModule);
  const productsService = app.get(ProductsService);

  const product = await productsService.publishBySku(sku);
  console.log(`Published product ${product.sku} (${product.name}).`);

  await app.close();
}

run().catch((error) => {
  console.error(error);
  process.exit(1);
});
