import { Product } from '../products/entities/product.entity';
import { ParrotSaleListing } from './entities/parrot-sale-listing.entity';

const imageResponse = (value: ParrotSaleListing) =>
  [...(value.images ?? [])]
    .sort((left, right) => left.position - right.position)
    .map((image) => ({ id: image.id, position: image.position }));

const candidateResponse = (value: ParrotSaleListing) => ({
  id: value.id,
  status: value.status,
  name: value.name,
  description: value.description,
  species: value.species,
  subspecies: value.subspecies,
  gender: value.gender,
  ageStage: value.ageStage,
  colors: value.colors,
  tagPair: value.tagPair,
  tagHandTame: value.tagHandTame,
  quantity: value.quantity,
  productId: value.productId,
  rejectionReason: value.rejectionReason,
  resubmissionOfId: value.resubmissionOfId,
  images: imageResponse(value),
  createdAt: value.createdAt,
  updatedAt: value.updatedAt,
});

export const parrotSaleListingSellerResponse = (value: ParrotSaleListing) => ({
  ...candidateResponse(value),
  requestedPrice: value.requestedPrice,
});

export const parrotSaleListingAdminResponse = (value: ParrotSaleListing) => ({
  ...candidateResponse(value),
  sellerUserId: value.sellerUserId,
  seller: {
    id: value.seller.id,
    phone: value.seller.phone,
    firstName: value.seller.firstName ?? null,
    lastName: value.seller.lastName ?? null,
    role: value.seller.role,
    profileCompleted: value.seller.profileCompleted,
  },
  requestedPrice: value.requestedPrice,
  approvedPrice: value.approvedPrice,
  internalAdminNote: value.internalAdminNote,
  reviewedBy: value.reviewedBy,
  reviewedAt: value.reviewedAt,
});

const productSummaryResponse = (value: Product) => ({
  id: value.id,
  sku: value.sku,
  name: value.name,
  price: value.price,
  stock: value.stock,
  status: value.status,
  isSellerListing: value.isSellerListing,
});

const linkedProductResponse = (value: ParrotSaleListing) =>
  value.product ? productSummaryResponse(value.product) : null;

export const parrotSaleListingApprovalResponse = (value: {
  listing: ParrotSaleListing;
  product: Product;
}) => ({
  listing: parrotSaleListingAdminResponse(value.listing),
  product: productSummaryResponse(value.product),
});

export const parrotSaleListingGodAdminDetailResponse = (
  value: ParrotSaleListing,
) => ({
  ...parrotSaleListingAdminResponse(value),
  linkedProduct: linkedProductResponse(value),
});

export const parrotSaleListingGodAdminSummaryResponse = (
  value: ParrotSaleListing,
) => ({
  id: value.id,
  status: value.status,
  title: value.name,
  species: value.species,
  subspecies: value.subspecies,
  quantity: value.quantity,
  requestedPrice: value.requestedPrice,
  seller: {
    id: value.seller.id,
    phone: value.seller.phone,
    firstName: value.seller.firstName ?? null,
    lastName: value.seller.lastName ?? null,
    role: value.seller.role,
  },
  createdAt: value.createdAt,
  imageCount: value.images?.length ?? 0,
});
