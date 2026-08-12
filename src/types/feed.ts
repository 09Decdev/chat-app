/** Post item — matching content-service PostLikeCommentResponseDto (subset for FE display). */
export interface PostMedia {
  id: string;
  url: string | null;
  type: string;
  width?: number;
  height?: number;
}

export interface Post {
  id: string;
  authorId: string;
  communityId: string;
  title: string;
  content: string;
  layout?: string;
  media: PostMedia[];
  isPublished?: boolean;
  createdAt?: string;
  updatedAt?: string;
  publishedAt?: string | null;
  isPublic?: boolean;
  likes: number;
  comments: number;
  view: number;
  isLiked: boolean;
  isSaved: boolean;
  isPurchased: boolean;
  canInteract: boolean;
  hasAccess: boolean;
  isCommentDisabled?: boolean;
  isPremium: boolean;
  price?: number;
  priceGo?: number;
  premiumStatus?: string | null;
  saleStatus?: string | null;
  previewTitle?: string | null;
  previewDescription?: string | null;
  previewMedia?: PostMedia[];
  saleLimit?: number | null;
  soldCount?: number;
  saleStartAt?: string | null;
  saleEndAt?: string | null;
  averageRating?: number | null;
  totalReviews?: number;
  rejectedReason?: string | null;
  productId?: string | null;
  status: string;
  pinnedAt?: string | null;
}

export interface FeedPage {
  posts: Post[];
  nextCursor: string | null;
  hasNextPage: boolean;
  meta?: { total: number; page: number; limit: number; totalPages: number };
}

/** Body cho POST /post/:id/view — signal capture (P0a). Tất cả optional. */
export interface ViewSignal {
  dwellMs: number;
  completion?: number;
  scrollDepth?: number;
  /** ms-epoch lúc BẮT ĐẦU xem (post vào viewport) — backend cross-check AC-1.5. */
  clientStartedAt: number;
}
