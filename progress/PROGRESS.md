# بک‌اند بیات پروت — وضعیت پروژه

آخرین به‌روزرسانی: 2026-07-05

## تکنولوژی‌ها

- **NestJS 11** (Express adapter)
- **TypeORM 1.0.0** + **PostgreSQL** (`pg`)
- **Auth:** `@nestjs/jwt` + `@nestjs/passport` + `passport-jwt` (OTP-based, نه ایمیل/پسورد)
- **Validation:** `class-validator` + `class-transformer` (`ValidationPipe` گلوبال در `main.ts`)
- **bcrypt** — هش کردن کد OTP (نه پسورد کاربر، چون پسوردی وجود ندارد)
- **@nestjs/config** — خواندن `.env` (`ConfigModule.forRoot({ isGlobal: true })`)
- **@nestjs/swagger** + **swagger-ui-express** — مستندات API
- **TypeScript 5.7**, ESLint + Prettier
- **moment-jalaali** — تولید تاریخ شمسی برای `orderNumber`

## دیتابیس

- PostgreSQL، نام دیتابیس: `bayat_parrot`
- اتصال از طریق متغیرهای `.env` (`DB_HOST`, `DB_PORT`, `DB_USERNAME`, `DB_PASSWORD`, `DB_NAME`)
- در حالت توسعه `synchronize: true` فعال است (schema به‌صورت خودکار از روی entity ها ساخته/آپدیت می‌شود) — **قبل از پروداکشن باید به migration واقعی تبدیل شود.**
- جدول‌های فعلی: `users`, `otps`, `categories`, `products`, `orders`, `order_items`
- `products` فیلدهای زیاد و چند enum دارد (`status`, `categorySlug`, `gender`, `ageStage`) — همه‌ی ستون‌های جدید/الزامی (`sku`, `categorySlug`, ...) در سطح DB nullable نگه داشته شدند تا `synchronize` روی رکوردهای قبلی کرش نکند؛ الزامی بودن‌شان فقط در DTO (سطح اعتبارسنجی) اعمال می‌شود. مشخصات فنی محصول در فیلد `specifications` از نوع `jsonb` ذخیره می‌شود: آرایه‌ای از `{ label, value }` که برای همه دسته‌ها عمومی است.
- `orders.orderNumber` (unique، nullable در DB به همان دلیل بالا) فرمت `BP-YYYYMMDDXXXX` بر اساس تاریخ شمسی دارد (مثال: `BP-140504070001`، بدون خط‌فاصله بین تاریخ و شمارنده)؛ شمارنده‌ی ۴ رقمی هر روز از `0001` شروع می‌شود. تولید آن در `OrdersService.saveOrderWithOrderNumber` با شمارش سفارش‌های همان روز + retry روی خطای unique-violation (کد پستگرس `23505`) انجام می‌شود تا زیر بار همزمان هم شماره‌ی تکراری ساخته نشود. سفارش‌های قدیمی‌تر از این فیچر مقدار `orderNumber = null` دارند.

## API های ساخته‌شده

### Auth (`/auth`) — احراز هویت با OTP
| متد | مسیر | توضیح |
|---|---|---|
| POST | `/auth/send-otp` | ارسال کد OTP ۵ رقمی به شماره موبایل (فعلاً فقط لاگ می‌شود، SMS واقعی وصل نیست) |
| POST | `/auth/verify-otp` | تأیید کد، ساخت/پیدا کردن کاربر، صدور JWT (اعتبار ۴۸ ساعت) |
| POST | `/auth/register` | تکمیل ثبت‌نام (نام/نام‌خانوادگی) — نیاز به JWT |

`AuthService.verifyOtp` چندین لاگ دیباگ دارد که برای troubleshooting کمک می‌کنند: مقدار/نوع دقیق `phone`/`code` دریافتی، حالت «رکورد OTP پیدا نشد»، حالت «منقضی شده»، نتیجه‌ی `bcrypt.compare`، و یک `console.log('verifyOtp final response: ...')` که دقیقاً همان object نهایی که به فرانت برمی‌گردد را نشان می‌دهد (شامل `accessToken` و `profileCompleted`). همچنین `main.ts` خطاهای اعتبارسنجی DTO (۴۰۰) را قبل از throw کردن لاگ می‌کند — قبلاً این خطاها کاملاً نامرئی بودند.

### Users (`/users`) — همه نیاز به JWT
| متد | مسیر | توضیح |
|---|---|---|
| GET | `/users/profile` | پروفایل کاربر جاری |
| PATCH | `/users/profile` | ویرایش پروفایل (نام، نام‌خانوادگی، ایمیل) |
| GET | `/users/loyalty-points` | امتیاز باشگاه مشتریان |
| GET | `/users` | لیست همه کاربران |
| GET | `/users/:id` | جزئیات یک کاربر |

### Legacy category API module
ماژول API قدیمی دسته‌بندی‌ها هنوز در بک‌اند وجود دارد، اما صفحه مستقل دسته‌بندی‌ها در فرانت از Roadmap حذف شده است. به دلیل وجود Mega Menu، صفحات کامل دسته‌بندی، جستجوی پیشرفته و معماری فعلی فروشگاه، صفحه مستقل دسته‌بندی‌ها ارزش افزوده‌ای برای تجربه کاربری یا سئو ایجاد نمی‌کند.

### Products (`/products`) — فقط محصولات با status=published نشان داده می‌شوند
| متد | مسیر | توضیح |
|---|---|---|
| POST | `/products` | ایجاد محصول (مسیر عمومی قدیمی، بدون guard — مدیریت رسمی محصولات از طریق Admin Panel است) |
| GET | `/products` | لیست published با فیلتر (`category` به‌جای categorySlug, `species`, `gender`, `ageStage`, `color`, `minPrice`, `maxPrice`, `sort`) + pagination (`page`, `limit`) |
| GET | `/products/search` | جستجو (`q`) روی محصولات published + همان فیلترها |
| GET / PATCH / DELETE | `/products/:id` | GET فقط برای published؛ `:id` می‌تواند UUID داخلی یا `sku` باشد (`findOne` با regex تشخیص می‌دهد کدام است) — قبلاً فقط UUID قبول می‌شد و لینک‌های فرانت با sku ۴۰۴ می‌گرفتند (در غیر این صورت 404) |

Product entity فیلدهای کامل: `sku` (فرمت `BP\d+`), `name`, `description`, `shortDescription`, `specifications[]` (`jsonb`، ساختار `{ label, value }`)، `price`, `discountPercent`, `discountPrice`, `stock`, `status` (`draft`/`pending`/`published`، پیش‌فرض `draft`), `categorySlug` (enum: `buy-parrot`/`parrot-food`/`parrot-serlak`/`parrot-supplements`/`parrot-toys`/`parrot-accessories`/`parrot-cage`), `subCategory`, `species`, `subspecies`, `gender`, `ageStage` (`serlaki`/`dane-khor`/`pish-molid`/`molid`), `colors[]`, `brand`, `weight`, `productType`, `size`, `material`, `tagPair`/`tagHandTame`/`tagCustom`/`tagLuxury`/`tagHealthGuarantee`/`tagFastShipping`/`tagFreeShipping`/`tagCarryCage` (boolean), `isAmazingOffer`, `amazingOfferEndsAt`, `images[]`.

**جستجوی کلمه‌به‌کلمه:** `GET /products/search` (و فیلتر عمومی) هر کلمه از عبارت جستجو را جداگانه با `ILIKE` روی `name`/`description` چک می‌کند (نه کل عبارت به‌صورت یک رشته‌ی پیوسته) — یعنی جستجوی «غذای طوطی آرا» بدون کلمه‌ی «مخصوص» هم محصول «غذای مخصوص طوطی آرا» را پیدا می‌کند.

**`lastEditedByName`:** فیلد اختیاری روی `Product` که نام آخرین ادمین ویرایش‌کننده را نگه می‌دارد؛ به `CreateProductDto`/`UpdateProductDto` اضافه شد.

در `ProductsService` قبل از ذخیره محصول، `specifications` normalize می‌شود: ردیف‌های کاملاً خالی حذف می‌شوند و اگر چیزی باقی نماند مقدار `null` ذخیره می‌شود. این منطق برای `create` و `update` یکسان است و به دسته محصول وابسته نیست.

**Regression check 2026-07-05:** مسیر عمومی محصول در فرانت با SKU canonical شد؛ بک‌اند همچنان `GET /products/:id` را با UUID و SKU پشتیبانی می‌کند. نمونه محصول واقعی `BP140504100001` با `categorySlug=buy-parrot`، `species=african-grey`، `status=published`، `discountPrice=115000000` و `specifications` واقعی تست شد. موجودی در ثبت سفارش داخل transaction با lock بدبینانه کم می‌شود و در صورت کمبود موجودی خطا می‌دهد.

رابطه‌ی قبلی Product↔Category (جدول `categories`) حذف شد و جایش `categorySlug` (enum ثابت) نشست؛ ماژول `categories` مستقل باقی مانده ولی دیگر به محصولات وصل نیست.

### Orders (`/orders`) — همه نیاز به JWT
| متد | مسیر | توضیح |
|---|---|---|
| POST | `/orders` | ثبت سفارش (آیتم‌ها + آدرس + `postalCode`) — `orderNumber` ساخته می‌شود، `paymentStatus` پیش‌فرض `pending`، و در SMS placeholder از `orderNumber` استفاده می‌شود |
| GET | `/orders` | سفارش‌های کاربر جاری |
| GET | `/orders/:id` | جزئیات سفارش (فقط مالک سفارش یا ادمین) |
| PATCH | `/orders/:id/status` | تغییر وضعیت — فقط نقش `admin` (`pending/processing/shipped/delivered`) |

Order entity فیلدهای جدید: `postalCode` (الزامی در DTO ثبت سفارش)، `paymentStatus` (enum `success`/`failed`/`pending`، پیش‌فرض `pending`)، `paymentDate` (nullable — فعلاً هیچ‌جا ست نمی‌شود چون درگاه پرداخت وصل نیست).

### Admin Panel (`/admin-panel`) — احراز هویت جدا، چندکاربره با username + password
`ADMIN_USERS` در `.env` لیست نام‌کاربری‌های مجاز را نگه می‌دارد (comma-separated)، و هر کدام یک متغیر `ADMIN_PASSWORD_<USERNAME>` (uppercase) دارد. `POST /admin-panel/login` حالا **هم `username` هم `password`** می‌گیرد (قبلاً فقط پسورد بود و حدس می‌زد مال کدوم کاربره) — جفت دقیق باید مطابقت داشته باشد، وگرنه `401`. مقایسه‌ی username نسبت به حروف بزرگ/کوچک حساس نیست؛ نام‌کاربری canonical (همان‌طور که در `ADMIN_USERS` نوشته شده) هم در پاسخ (`username`) و هم داخل JWT (`payload.username`) برمی‌گردد.

| متد | مسیر | توضیح |
|---|---|---|
| POST | `/admin-panel/login` | ورود با `username` + `password`؛ صدور JWT مخصوص پنل (۴ ساعت اعتبار) |
| GET | `/admin-panel/orders` | همه سفارش‌ها با خریدار، آدرس کامل، `postalCode`، `paymentStatus`، محصولات، مبلغ، `orderNumber`، و `createdAtJalaali` (تاریخ شمسی فرمت‌شده، کنار `createdAt` خام) — به‌علاوه `id` خام چون PATCH .../status هنوز با UUID کار می‌کند |
| PATCH | `/admin-panel/orders/:id/status` | تغییر وضعیت سفارش |
| GET | `/admin-panel/sales` | گزارش فروش: تعداد سفارش، مبلغ کل، تفکیک بر اساس محصول |
| POST | `/admin-panel/products` | افزودن محصول — همیشه با `status=pending` ساخته می‌شود (صرف‌نظر از مقدار ورودی) |
| GET | `/admin-panel/products` | لیست همه‌ی محصولات؛ پارامتر اختیاری `status` برای فیلتر (`draft`/`pending`/`published`) |
| GET | `/admin-panel/products/pending` | فقط محصولات `pending` |
| GET | `/admin-panel/products/lookup/:identifier` | پیدا کردن محصول با UUID یا sku (`findOneByIdOrSku`) — برای صفحه ویرایش وقتی فقط sku در دسترس است |
| GET | `/admin-panel/products/:id` | جزئیات یک محصول خاص (برای صفحه ویرایش) |
| PATCH | `/admin-panel/products/:id` | ویرایش محصول (همه‌ی فیلدها، شامل `status`) |
| DELETE | `/admin-panel/products/:id` | حذف محصول |
| POST | `/admin-panel/products/:id/images` | آپلود تصویر محصول (multipart، فیلد `image`)؛ حداکثر ۵مگابایت، فرمت‌های `jpg/jpeg/png/webp` |

### آپلود و سرو تصویر محصول
- آپلود با `@nestjs/platform-express` (`FileInterceptor`) + `multer` (`diskStorage`)، تنظیمات در `src/admin/config/product-image-upload.config.ts`.
- فایل‌ها در `public/uploads/` با نام `${uuid}${پسوند}` ذخیره می‌شوند؛ آدرس (`/uploads/<filename>`) به آرایه‌ی `images` محصول در دیتابیس اضافه می‌شود.
- سرو فایل‌های استاتیک با `app.useStaticAssets` در `main.ts` روی مسیر `GET /uploads/:filename`.
- `public/uploads/*` در `.gitignore` نادیده گرفته می‌شود (فقط `.gitkeep` track می‌شود) — یعنی فایل‌های آپلودی روی هر محیط دیگر (staging/prod) از صفر شروع می‌شوند؛ برای نگه‌داری دائمی باید به storage خارجی (S3 یا مشابه) منتقل شود.

### Scripts انتشار محصول و پشتیبان‌گیری
- `npm run publish-all-pending` — همه‌ی محصولات `pending` را `published` می‌کند.
- `npm run publish-product -- --id=BP30171000` — یک محصول خاص را با `sku` پیدا و `published` می‌کند.
- `npm run db:backup` — از دیتابیس PostgreSQL یک فایل SQL در پوشه‌ی `backups/` می‌گیرد؛ نام فایل شامل timestamp است (مثال: `bayat_parrot_2026-06-30T14-00-00-000Z.sql`). از `pg_dump` در مسیر ثابت نصب PostgreSQL 17 روی ویندوز استفاده می‌کند (`C:\Program Files\PostgreSQL\17\bin\pg_dump.exe`)؛ اسکریپت در `src/scripts/db-backup.ts`. `backups/` در `.gitignore` است، این فایل‌ها روی گیت‌هاب پوش نمی‌شوند — باید جداگانه (مثلاً گوگل‌درایو) نگه‌داری شوند.
- `src/scripts/list-products.ts` — اسکریپت کمکی جدید: همه‌ی محصولات را با `id`/`name`/`status`/`categorySlug`/`species` در ترمینال چاپ می‌کند؛ برای دیباگ سریع بدون نیاز به کوئری مستقیم دیتابیس.
- هر اسکریپت از طریق `ts-node -r tsconfig-paths/register` اجرا می‌شود.

### مستندات API
- Swagger UI: `http://localhost:3001/api`
- کنترلرها/DTOها هنوز دکوریتورهای `@ApiTags`/`@ApiProperty` ندارند — مستندات فعلاً فقط ساختار خام روت‌ها را نشان می‌دهد.

## چیزهایی که مونده

- **SMS واقعی:** `SmsService` (`src/common/sms/sms.service.ts`) فعلاً فقط لاگ می‌کند؛ باید به یک provider واقعی (مثل Kavenegar یا sms.ir) وصل شود — هم برای OTP و هم برای تایید سفارش.
- **اتصال به فرانت:** فرانت به این بک‌اند وصل شده و در محیط توسعه محلی کار می‌کند؛ دیپلوی روی هاست ابری (آروان‌کلود) هنوز انجام نشده.
- **Migration واقعی TypeORM:** الان `synchronize: true` است؛ قبل از پروداکشن باید migration نوشته و سوییچ شود.
- **تست خودکار:** اسکلت Jest وجود دارد ولی برای فیچرهای جدید (auth/orders/admin/products) تستی نوشته نشده.
- **Rate limiting روی OTP:** الان محدودیتی روی تعداد درخواست send-otp برای یک شماره وجود ندارد.
- **Pagination روی `/users` و `/admin-panel/orders`:** فعلاً همه رکوردها بدون صفحه‌بندی برمی‌گردند.
- **پرداخت:** هیچ درگاه پرداختی وصل نشده؛ `paymentStatus`/`paymentDate` روی Order وجود دارند ولی چیزی آن‌ها را به‌جز مقدار پیش‌فرض `pending` تغییر نمی‌دهد — باید موقع وصل‌کردن درگاه پرداخت، آپدیت این فیلدها وصل شود (و احتمالاً یک endpoint ادمین برای ثبت دستی پرداخت).
- **آدرس کاربر:** آدرس و کدپستی فقط در لحظه‌ی ثبت سفارش (فیلد متنی آزاد) گرفته می‌شوند، دفترچه آدرس ذخیره‌شده برای کاربر وجود ندارد.
- **آپلود تصویر محصول روی دیسک محلی است:** `POST /admin-panel/products/:id/images` کار می‌کند (multer + استاتیک سرو از `public/uploads`)، اما روی هاست‌های ephemeral (مثل اکثر PaaS ها) فایل‌ها با هر دیپلوی از بین می‌روند. قبل از پروداکشن باید به storage خارجی (S3 یا مشابه) منتقل شود.
- **مسیر عمومی `POST/PATCH/DELETE /products` بدون guard است:** از قبل بدون محافظت بود؛ حالا که گردش‌کار تأیید ادمین (`pending` → `published`) اضافه شده، این مسیر می‌تواند مستقیماً محصول با `status=published` بسازد و گردش‌کار تأیید را دور بزند. باید قبل از پروداکشن گارد بشود یا حذف شود (مدیریت رسمی محصولات الان از طریق `/admin-panel/products` انجام می‌شود).
- **پسوردهای ادمین پلین‌تکست در `.env` هستند:** الان قوی و رندوم‌اند (نه دیگه برابر نام‌کاربری)، ولی هنوز هش نشده‌اند و در فایل env ساده ذخیره می‌شوند — قابل‌قبول برای dev، ولی برای پروداکشن بهتره هش (bcrypt) بشن یا به یک identity provider واقعی منتقل شوند.
- **دیپلوی روی آروان‌کلود:** هنوز انجام نشده — دامنه خریداری شده ولی هنوز NS به آروان تغییر نکرده؛ حساب آروان‌کلود ساخته شده.

## نکات شناخته‌شده محیط dev (ویندوز)

- **`npm run start:dev` گاهی پروسه‌ی قدیمی خودش رو کامل kill نمی‌کند:** روی ویندوز، وقتی `nest start --watch` بعد از تغییر فایل می‌خواد ری‌استارت کنه، گاهی `taskkill` پروسه‌ی قبلی رو واقعاً نمی‌بندد (خطای `ERROR: The process "X" not found`) و کل دستور با `EADDRINUSE` روی پورت ۳۰۰۱ کرش می‌کند، درحالی‌که پروسه‌ی قبلی (orphan) همچنان زنده می‌ماند و به درخواست‌ها با **کد قدیمی** پاسخ می‌دهد. اگه رفتار سرور با کد فعلی همخوانی نداشت یا غیرمنتظره بود، اول چک کن چند پروسه‌ی `node` مرتبط با `bayat-parrot-api` زنده‌ست (`Get-CimInstance Win32_Process -Filter "Name='node.exe'"`) — اگه بیشتر از یک جفت (`nest.js start --watch` + `dist/main`) بود، باید orphan ها رو بست و `npm run start:dev` رو تازه بالا آورد. **راه سریع‌تر:** `netstat -ano | findstr :3001` → `taskkill /PID <عدد> /F` → دوباره `npm run start:dev`.
- **تغییر `.env` هیچ‌وقت hot-reload رو trigger نمی‌کنه:** `nest start --watch` فقط فایل‌های `.ts` رو واچ می‌کنه، نه `.env`. بعد از هر تغییر در `.env` (مثل اضافه‌کردن `ADMIN_USERS`) باید پروسه‌ی dev server رو کامل kill کرد و دوباره `npm run start:dev` زد، وگرنه مقدار قدیمی env همچنان در حافظه‌ی پروسه می‌مونه و رفتار سرور با `.env` فعلی هم‌خوانی نداره.
