import { NestFactory } from '@nestjs/core';
import { AppModule } from '../app.module';
import { ProductsService } from '../products/products.service';

async function run() {
  const app = await NestFactory.createApplicationContext(AppModule);
  const productsService = app.get(ProductsService);

  const count = await productsService.publishAllPending();
  console.log(`Published ${count} pending product(s).`);

  await app.close();
}

run().catch((error) => {
  console.error(error);
  process.exit(1);
});
