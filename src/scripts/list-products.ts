import { NestFactory } from '@nestjs/core';
import { AppModule } from '../app.module';
import { ProductsService } from '../products/products.service';

async function run() {
  const app = await NestFactory.createApplicationContext(AppModule);
  const productsService = app.get(ProductsService);

  const products = await productsService.findAllForAdmin();
  console.log(`Total products: ${products.length}`);
  products.forEach((p) => {
    console.log(`- id: ${p.id} | name: ${p.name} | status: ${p.status} | categorySlug: ${p.categorySlug} | species: ${p.species}`);
  });

  await app.close();
}

run().catch((error) => {
  console.error(error);
  process.exit(1);
});