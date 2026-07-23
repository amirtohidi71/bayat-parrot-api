import {
  ExecutionContext,
  ForbiddenException,
  UnauthorizedException,
} from '@nestjs/common';
import { AdminService } from './admin.service';
import { GodAdminService } from './god-admin.service';
import {
  GOD_ADMIN_PANEL_SCOPE,
  GOD_ADMIN_ROLE,
  GodAdminAuthGuard,
} from './guards/god-admin-auth.guard';
import { Product, ProductStatus } from '../products/entities/product.entity';
import { ProductsService } from '../products/products.service';
import { ProductsController } from '../products/products.controller';

describe('Product publication access', () => {
  const editorUsernames = ['editor_one', 'editor_two', 'editor_three'];
  const editorPasswords = Object.fromEntries(
    editorUsernames.map((username, index) => [username, `test-editor-credential-${index + 1}`]),
  );
  const ownerUsername = ['owner', 'fixture'].join('-');
  const ownerPassword = ['owner', 'credential', 'fixture'].join('-');
  const invalidPassword = ['invalid', 'credential', 'fixture'].join('-');
  const signedToken = ['signed', 'test', 'token'].join('-');
  const configValues: Record<string, string> = {
    ADMIN_USERS: Object.keys(editorPasswords).join(','),
    GOD_ADMIN_USERNAME: ownerUsername,
    GOD_ADMIN_PASSWORD: ownerPassword,
  };
  editorUsernames.forEach((username) => {
    configValues[`ADMIN_PASSWORD_${username.toUpperCase()}`] = editorPasswords[username];
  });

  const configService = {
    get: jest.fn((key: string) => configValues[key]),
  };
  const jwtService = {
    sign: jest.fn(() => signedToken),
    verify: jest.fn(),
  };
  const productsService = {
    create: jest.fn(),
    update: jest.fn(),
    findAllForAdmin: jest.fn(),
    findPending: jest.fn(),
    findOneForAdmin: jest.fn(),
    publishPendingById: jest.fn(),
    findAllPublished: jest.fn(),
  };

  const adminService = new AdminService(
    configService as never,
    jwtService as never,
    {} as never,
    productsService as never,
    {} as never,
  );
  const godAdminService = new GodAdminService(
    configService as never,
    jwtService as never,
    productsService as never,
  );

  beforeEach(() => {
    jest.clearAllMocks();
  });

  it.each(Object.entries(editorPasswords))('keeps editor login working for %s', (username, password) => {
    expect(adminService.login({ username, password })).toMatchObject({
      accessToken: signedToken,
      username,
    });
  });

  it('forces editor-created products to pending even when published is requested', () => {
    adminService.createProduct({ status: ProductStatus.PUBLISHED } as never, 'editor-user');

    expect(productsService.create).toHaveBeenCalledWith(
      expect.objectContaining({ status: ProductStatus.PENDING }),
    );
  });

  it('rejects editor publication with Forbidden', () => {
    expect(() => adminService.updateProduct('product-id', { status: ProductStatus.PUBLISHED }))
      .toThrow(ForbiddenException);
    expect(productsService.update).not.toHaveBeenCalled();
  });

  it('allows an editor to update ordinary product fields', () => {
    adminService.updateProduct('product-id', { name: 'Updated name' }, 'editor-user');

    expect(productsService.update).toHaveBeenCalledWith(
      'product-id',
      expect.objectContaining({ name: 'Updated name', lastEditedByName: 'editor-user' }),
    );
  });

  it('keeps the shared pending list available to editors', () => {
    adminService.getPendingProducts();
    expect(productsService.findPending).toHaveBeenCalledTimes(1);
  });

  it('allows god admin login only with credentials from config', () => {
    expect(godAdminService.login({ username: ownerUsername.toUpperCase(), password: ownerPassword }))
      .toMatchObject({ username: ownerUsername, role: GOD_ADMIN_ROLE });
    expect(jwtService.sign).toHaveBeenCalledWith(
      {
        scope: GOD_ADMIN_PANEL_SCOPE,
        role: GOD_ADMIN_ROLE,
        username: ownerUsername,
      },
      { expiresIn: '4h' },
    );
    expect(() => godAdminService.login({ username: ownerUsername, password: invalidPassword }))
      .toThrow(UnauthorizedException);
  });

  it('publishes through the owner service', () => {
    godAdminService.publishProduct('product-id');
    expect(productsService.publishPendingById).toHaveBeenCalledWith('product-id');
  });

  it('rejects an editor token on god-admin endpoints with Forbidden', () => {
    jwtService.verify.mockReturnValue({ scope: 'admin-panel', username: editorUsernames[0] });
    const guard = new GodAdminAuthGuard(jwtService as never);

    expect(() => guard.canActivate(createContext('Bearer editor-token'))).toThrow(ForbiddenException);
  });

  it('accepts only a signed owner payload on god-admin endpoints', () => {
    jwtService.verify.mockReturnValue({
      scope: GOD_ADMIN_PANEL_SCOPE,
      role: GOD_ADMIN_ROLE,
      username: ownerUsername,
    });
    const guard = new GodAdminAuthGuard(jwtService as never);

    expect(guard.canActivate(createContext('Bearer owner-token'))).toBe(true);
    expect(() => guard.canActivate(createContext())).toThrow(UnauthorizedException);
  });

  it('removes public product mutations while preserving the published GET', () => {
    const controllerPrototype = ProductsController.prototype as unknown as Record<string, unknown>;
    expect(controllerPrototype.create).toBeUndefined();
    expect(controllerPrototype.update).toBeUndefined();
    expect(controllerPrototype.remove).toBeUndefined();

    const controller = new ProductsController(productsService as never);
    controller.findAll({});
    expect(productsService.findAllPublished).toHaveBeenCalledWith({});
  });
});

function createContext(authorization?: string): ExecutionContext {
  const request = { headers: authorization ? { authorization } : {} };
  return {
    switchToHttp: () => ({
      getRequest: () => request,
    }),
  } as ExecutionContext;
}

describe('ProductsService owner publication', () => {
  it('changes only a pending product status to published', async () => {
    const repository = { save: jest.fn(async (product: Product) => product) };
    const service = new ProductsService(repository as never, {} as never, {} as never);
    const product = { id: 'product-id', name: 'Product', status: ProductStatus.PENDING } as Product;
    jest.spyOn(service, 'findOne').mockResolvedValue(product);

    await expect(service.publishPendingById(product.id)).resolves.toBe(product);
    expect(product.status).toBe(ProductStatus.PUBLISHED);
    expect(repository.save).toHaveBeenCalledWith(product);
  });

  it('does not publish a product that is not pending', async () => {
    const repository = { save: jest.fn() };
    const service = new ProductsService(repository as never, {} as never, {} as never);
    jest.spyOn(service, 'findOne').mockResolvedValue({
      id: 'product-id',
      status: ProductStatus.DRAFT,
    } as Product);

    await expect(service.publishPendingById('product-id')).rejects.toThrow(
      'Only pending products can be published',
    );
    expect(repository.save).not.toHaveBeenCalled();
  });
});
