--
-- PostgreSQL database dump
--

-- Dumped from database version 17.4
-- Dumped by pg_dump version 17.4

SET statement_timeout = 0;
SET lock_timeout = 0;
SET idle_in_transaction_session_timeout = 0;
SET transaction_timeout = 0;
SET client_encoding = 'UTF8';
SET standard_conforming_strings = on;
SELECT pg_catalog.set_config('search_path', '', false);
SET check_function_bodies = false;
SET xmloption = content;
SET client_min_messages = warning;
SET row_security = off;

--
-- Name: uuid-ossp; Type: EXTENSION; Schema: -; Owner: -
--

CREATE EXTENSION IF NOT EXISTS "uuid-ossp" WITH SCHEMA public;


--
-- Name: EXTENSION "uuid-ossp"; Type: COMMENT; Schema: -; Owner: 
--

COMMENT ON EXTENSION "uuid-ossp" IS 'generate universally unique identifiers (UUIDs)';


--
-- Name: orders_paymentstatus_enum; Type: TYPE; Schema: public; Owner: postgres
--

CREATE TYPE public.orders_paymentstatus_enum AS ENUM (
    'success',
    'failed',
    'pending'
);


ALTER TYPE public.orders_paymentstatus_enum OWNER TO postgres;

--
-- Name: orders_status_enum; Type: TYPE; Schema: public; Owner: postgres
--

CREATE TYPE public.orders_status_enum AS ENUM (
    'pending',
    'processing',
    'shipped',
    'delivered'
);


ALTER TYPE public.orders_status_enum OWNER TO postgres;

--
-- Name: products_agestage_enum; Type: TYPE; Schema: public; Owner: postgres
--

CREATE TYPE public.products_agestage_enum AS ENUM (
    'serlaki',
    'dane-khor',
    'pish-molid',
    'molid'
);


ALTER TYPE public.products_agestage_enum OWNER TO postgres;

--
-- Name: products_categoryslug_enum; Type: TYPE; Schema: public; Owner: postgres
--

CREATE TYPE public.products_categoryslug_enum AS ENUM (
    'buy-parrot',
    'parrot-food',
    'parrot-serlak',
    'parrot-supplements',
    'parrot-toys',
    'parrot-accessories',
    'parrot-cage'
);


ALTER TYPE public.products_categoryslug_enum OWNER TO postgres;

--
-- Name: products_gender_enum; Type: TYPE; Schema: public; Owner: postgres
--

CREATE TYPE public.products_gender_enum AS ENUM (
    'male',
    'female',
    'unknown'
);


ALTER TYPE public.products_gender_enum OWNER TO postgres;

--
-- Name: products_status_enum; Type: TYPE; Schema: public; Owner: postgres
--

CREATE TYPE public.products_status_enum AS ENUM (
    'draft',
    'pending',
    'published'
);


ALTER TYPE public.products_status_enum OWNER TO postgres;

--
-- Name: users_role_enum; Type: TYPE; Schema: public; Owner: postgres
--

CREATE TYPE public.users_role_enum AS ENUM (
    'admin',
    'customer'
);


ALTER TYPE public.users_role_enum OWNER TO postgres;

SET default_tablespace = '';

SET default_table_access_method = heap;

--
-- Name: categories; Type: TABLE; Schema: public; Owner: postgres
--

CREATE TABLE public.categories (
    id uuid DEFAULT public.uuid_generate_v4() NOT NULL,
    name character varying NOT NULL,
    description character varying
);


ALTER TABLE public.categories OWNER TO postgres;

--
-- Name: order_items; Type: TABLE; Schema: public; Owner: postgres
--

CREATE TABLE public.order_items (
    id uuid DEFAULT public.uuid_generate_v4() NOT NULL,
    "orderId" uuid NOT NULL,
    "productId" uuid NOT NULL,
    quantity integer NOT NULL,
    price numeric(10,2) NOT NULL
);


ALTER TABLE public.order_items OWNER TO postgres;

--
-- Name: orders; Type: TABLE; Schema: public; Owner: postgres
--

CREATE TABLE public.orders (
    id uuid DEFAULT public.uuid_generate_v4() NOT NULL,
    "userId" uuid NOT NULL,
    status public.orders_status_enum DEFAULT 'pending'::public.orders_status_enum NOT NULL,
    total numeric(10,2) DEFAULT '0'::numeric NOT NULL,
    "createdAt" timestamp without time zone DEFAULT now() NOT NULL,
    "updatedAt" timestamp without time zone DEFAULT now() NOT NULL,
    address character varying,
    "orderNumber" character varying,
    "postalCode" character varying,
    "paymentStatus" public.orders_paymentstatus_enum DEFAULT 'pending'::public.orders_paymentstatus_enum NOT NULL,
    "paymentDate" timestamp without time zone
);


ALTER TABLE public.orders OWNER TO postgres;

--
-- Name: otps; Type: TABLE; Schema: public; Owner: postgres
--

CREATE TABLE public.otps (
    id uuid DEFAULT public.uuid_generate_v4() NOT NULL,
    phone character varying NOT NULL,
    "codeHash" character varying NOT NULL,
    "expiresAt" timestamp without time zone NOT NULL,
    consumed boolean DEFAULT false NOT NULL,
    "createdAt" timestamp without time zone DEFAULT now() NOT NULL
);


ALTER TABLE public.otps OWNER TO postgres;

--
-- Name: products; Type: TABLE; Schema: public; Owner: postgres
--

CREATE TABLE public.products (
    id uuid DEFAULT public.uuid_generate_v4() NOT NULL,
    name character varying NOT NULL,
    description character varying,
    price numeric(15,2) NOT NULL,
    stock integer DEFAULT 0 NOT NULL,
    "createdAt" timestamp without time zone DEFAULT now() NOT NULL,
    "updatedAt" timestamp without time zone DEFAULT now() NOT NULL,
    species character varying,
    gender public.products_gender_enum,
    sku character varying,
    "shortDescription" character varying,
    "discountPercent" integer,
    status public.products_status_enum DEFAULT 'draft'::public.products_status_enum NOT NULL,
    "categorySlug" public.products_categoryslug_enum,
    "subCategory" character varying,
    subspecies character varying,
    "ageStage" public.products_agestage_enum,
    colors text[],
    brand character varying,
    "productType" character varying,
    size character varying,
    material character varying,
    "tagPair" boolean DEFAULT false NOT NULL,
    "tagHandTame" boolean DEFAULT false NOT NULL,
    "tagCustom" boolean DEFAULT false NOT NULL,
    "tagLuxury" boolean DEFAULT false NOT NULL,
    "tagHealthGuarantee" boolean DEFAULT false NOT NULL,
    "tagFastShipping" boolean DEFAULT false NOT NULL,
    images text[],
    weight character varying,
    "tagFreeShipping" boolean DEFAULT false NOT NULL,
    "tagCarryCage" boolean DEFAULT false NOT NULL,
    "deletedAt" timestamp without time zone,
    "isAmazingOffer" boolean DEFAULT false NOT NULL,
    "discountPrice" numeric(15,2),
    "amazingOfferEndsAt" timestamp with time zone,
    specifications jsonb,
    "lastEditedByName" character varying,
    "boughtTogetherProductIds" uuid[] DEFAULT '{}'::uuid[] NOT NULL
);


ALTER TABLE public.products OWNER TO postgres;

--
-- Name: users; Type: TABLE; Schema: public; Owner: postgres
--

CREATE TABLE public.users (
    id uuid DEFAULT public.uuid_generate_v4() NOT NULL,
    email character varying,
    role public.users_role_enum DEFAULT 'customer'::public.users_role_enum NOT NULL,
    "createdAt" timestamp without time zone DEFAULT now() NOT NULL,
    "updatedAt" timestamp without time zone DEFAULT now() NOT NULL,
    phone character varying NOT NULL,
    "firstName" character varying,
    "lastName" character varying,
    "profileCompleted" boolean DEFAULT false NOT NULL,
    "loyaltyPoints" integer DEFAULT 0 NOT NULL
);


ALTER TABLE public.users OWNER TO postgres;

--
-- Data for Name: categories; Type: TABLE DATA; Schema: public; Owner: postgres
--

COPY public.categories (id, name, description) FROM stdin;
4bf647a0-566f-4741-99b2-e21cad8ee8f7	Birds	\N
\.


--
-- Data for Name: order_items; Type: TABLE DATA; Schema: public; Owner: postgres
--

COPY public.order_items (id, "orderId", "productId", quantity, price) FROM stdin;
74e8b3bb-be40-4284-b7b5-ed069378fb36	82fad2b0-bf44-44b7-96e4-c27fed414d94	0e673407-d637-49c3-9e02-96b4df951631	2	120.00
94d95c17-5fe3-4acc-a8ef-a3ff7893ba60	270f681a-2339-4cc2-bac0-6a8d71111e37	0e673407-d637-49c3-9e02-96b4df951631	1	120.00
d27f9e2c-f20b-47a3-9db5-bdaa9da15d39	e1a959ac-7983-432b-a93f-e8391bb38b77	f3fe201b-68b0-4c16-a243-43980583a15b	1	5000000.00
0f5ff1a4-fafe-456b-aeeb-19f709372f29	e615e1a6-4dbd-4991-b7b4-392d684647b9	f3fe201b-68b0-4c16-a243-43980583a15b	1	5000000.00
1c782d43-df08-45ec-b5b9-4d6455144c3e	9191709c-a3ee-4b06-b711-198a1251173a	f3fe201b-68b0-4c16-a243-43980583a15b	1	5000000.00
b44ba551-f1a3-4a6c-837a-60399f99841a	b838cbd3-d1f5-4ddf-95f0-9a4f75d727fa	f3fe201b-68b0-4c16-a243-43980583a15b	1	5000000.00
\.


--
-- Data for Name: orders; Type: TABLE DATA; Schema: public; Owner: postgres
--

COPY public.orders (id, "userId", status, total, "createdAt", "updatedAt", address, "orderNumber", "postalCode", "paymentStatus", "paymentDate") FROM stdin;
82fad2b0-bf44-44b7-96e4-c27fed414d94	c92c29d4-9dd7-403a-a1db-768d5a8d7a82	pending	240.00	2026-06-27 13:57:02.862829	2026-06-27 13:57:37.79623	\N	\N	\N	pending	\N
270f681a-2339-4cc2-bac0-6a8d71111e37	c92c29d4-9dd7-403a-a1db-768d5a8d7a82	shipped	120.00	2026-06-27 15:59:34.568655	2026-06-27 16:00:01.334145	?????? ?????? ?????? ???? ??	\N	\N	pending	\N
e1a959ac-7983-432b-a93f-e8391bb38b77	c92c29d4-9dd7-403a-a1db-768d5a8d7a82	pending	5000000.00	2026-06-28 16:35:37.642628	2026-06-28 16:35:37.642628	???	BP-14050407-0001	\N	pending	\N
e615e1a6-4dbd-4991-b7b4-392d684647b9	c92c29d4-9dd7-403a-a1db-768d5a8d7a82	pending	5000000.00	2026-06-28 16:35:37.830299	2026-06-28 16:35:37.830299	???	BP-14050407-0002	\N	pending	\N
b838cbd3-d1f5-4ddf-95f0-9a4f75d727fa	c92c29d4-9dd7-403a-a1db-768d5a8d7a82	pending	5000000.00	2026-06-28 17:11:43.699522	2026-07-02 17:07:51.042751	test	BP-140504070004	123	pending	\N
9191709c-a3ee-4b06-b711-198a1251173a	c92c29d4-9dd7-403a-a1db-768d5a8d7a82	delivered	5000000.00	2026-06-28 16:49:41.204253	2026-07-02 17:07:55.462218	??? ????	BP-14050407-0003	1234567890	pending	\N
\.


--
-- Data for Name: otps; Type: TABLE DATA; Schema: public; Owner: postgres
--

COPY public.otps (id, phone, "codeHash", "expiresAt", consumed, "createdAt") FROM stdin;
e8beb3b9-cff7-440a-a413-743ccaba3e0f	09121234567	$2b$10$6MJkne9WZMdsr5MsBOY9fu4hfrlX7gwsLr8N/BrG.WAcE88izuHqq	2026-06-27 13:54:16.076	t	2026-06-27 13:52:16.165946
74267e7f-e304-46f3-baef-a88007c625a3	09121234567	$2b$10$oT6UuTr28Vye8gkLLjFhMeRNBdRkFpWQTXrj90FvUkLSswYtf1oB.	2026-06-27 13:59:36.275	t	2026-06-27 13:57:36.326798
ede0df98-2915-4b53-877f-788d3bb1859f	09121234567	$2b$10$WcrIrn2engbxSmRf2d.Ql.mAGgJ9SCH88oySIp5fIQEHVhbHKk8Gy	2026-06-27 16:00:57.448	t	2026-06-27 15:58:57.515284
0f807278-9149-4e59-9420-c5c4c17794f4	09178096289	$2b$10$y0uGSyFmQX6BK79LQb0jTOx4dn.qGmUZcIPHplWzLXbOtQURi576.	2026-06-27 17:10:05.469	t	2026-06-27 17:08:05.666465
0414ef63-93f3-4d59-8522-f0b922c590e3	09178096289	$2b$10$EiWuvgTsla/KNUtBaDAK6eJslvWOhIGluGFpuqzYVbvp3Dzwmhg2u	2026-06-27 17:14:31.191	t	2026-06-27 17:12:31.263316
7508debe-3ea3-417f-888f-7a7912a6cebd	09178096289	$2b$10$XXlQdBbCfVexu6HX2uZQhOLkz8RxEHeLGyWpuzIwMkPEEfVFCexJe	2026-06-27 17:16:50.579	t	2026-06-27 17:14:50.65036
65af61be-72d3-4c1f-bbf6-b861a7410f63	09178096289	$2b$10$YjCgyet/LQ.zixZBu9doEON1/B1ryk.VW6GONBbidHL8KLDF6UGOW	2026-06-27 17:20:02.293	t	2026-06-27 17:18:02.356885
acea6dc5-6a56-4761-8521-ccc362bdaba9	09178096289	$2b$10$TJCVlP8jy.xcHbgydZ6AFuqwsAjRui5LWTcZFpIWfKdBdwcJ5Vmdy	2026-06-27 17:26:28.961	t	2026-06-27 17:24:29.024162
6f263503-f6de-4a0e-ada8-dd6fed13fbff	09178096289	$2b$10$e1Y9NGMDWujYXiQNWYD24.HNL9nWU/qvy.c/vE5wtIyVvmocL8/lW	2026-06-27 17:28:32.585	t	2026-06-27 17:26:32.646157
7f5ea71c-4a6d-4952-88ba-45f44e144cc6	09178096289	$2b$10$zLaClonHSEtvEn1NNUmLGeADrDnx9zFQ4mFa9axy/MxVqmmYP1.gi	2026-06-27 17:33:18.706	t	2026-06-27 17:31:18.772829
0fc56a09-0056-495b-b30f-802bfe4a704d	09121234567	$2b$10$5HcpGhS8D/omHF96pxmQn.ceqCvvBMf.k9WMKtyKDEb8.gswnvFqi	2026-06-27 17:41:23.301	t	2026-06-27 17:39:23.356321
7dc92c1a-8f76-43e4-b8f9-c9fb58c50f00	09178096289	$2b$10$wCb2swnUU7YOHS2YZSLy4.e94p9qelO04aJha4Ra0c81yIreJgZE.	2026-06-27 17:42:23.151	t	2026-06-27 17:40:23.217842
387a5c14-6cc5-4fa0-8545-ced59e2f5d14	09178096289	$2b$10$anNPMAmC8L0wIGdcQF7DUe93tHqhsjk9vSiWmU2wTsamVuI7qgq2S	2026-06-27 17:51:38.077	t	2026-06-27 17:49:38.142695
7bd2b630-ec9f-4421-8f0f-ba617a2de6ff	09178096289	$2b$10$.UuVxpMcwCNx9QQRnslLUOXXdcy472nEenp0sD1At29zOsfn8ITKi	2026-06-27 18:00:33.912	t	2026-06-27 17:58:33.99142
f0a9fc81-808e-4322-8917-648786b375ad	09178096289	$2b$10$UQ.914yTSlDBdPFZWcH9V.SFQ/7XCKU.G1HqFZin56s/jVqWCz.MC	2026-06-27 18:02:21.344	t	2026-06-27 18:00:21.402217
99b7b98f-a322-4508-a4f9-ccbb1f93dd23	09121234567	$2b$10$FnT9xoTJ5TFfArpKwJ/CbeZfW/fAe8IkD0nXQpzF3djIdaJG5uVNi	2026-06-28 10:49:58.259	t	2026-06-28 10:47:58.294512
1673ea88-5803-4708-b123-64028e75df60	09121234567	$2b$10$OHIk1.P5yrxpIPGRVEtzD.VT/nw382gKv2zvMpyD0f.YD2eCtqNee	2026-06-28 16:36:41.4	t	2026-06-28 16:34:41.458912
b89e55a5-e4a3-4858-b9f9-282e0369e635	09121234567	$2b$10$Mmu7lnE5Z7shGeQ26nMbbeVymX1NKf.08NYGBoRIFZUX0/xSr6P8e	2026-06-28 16:51:18.267	t	2026-06-28 16:49:18.331546
c184f240-3f38-4d3e-880d-7b54788895c2	09121234567	$2b$10$Gw8JFnqrgsUFegrxZD9aXuwkDdy6ElvKMJmnEed36XjTnkA.rmaaa	2026-06-28 17:13:17.979	t	2026-06-28 17:11:18.04481
e173d50a-06b5-4db3-b045-38d82a8b4154	09121234567	$2b$10$ASPh4FrWJP2JvtMahflmDeN9c8ouEesbCpI.E/XbHNlKJwq2RZTOq	2026-06-29 11:28:51.187	t	2026-06-29 11:26:51.254583
b3c31b6c-71cb-4cde-8646-5d3d6a2adfff	09178096289	$2b$10$hMA7fBfLiMQmZ2MbxQ7WT.yk4KH9fKQHOjSEPhfpkrBBg4UwkVWn2	2026-06-29 11:40:27.409	t	2026-06-29 11:38:27.501128
ed85e930-c191-498d-bf8c-50658eb1a358	09121234567	$2b$10$uRlSGHbim4qyy1GBow4JxOO372lPHhLtbEsIAgcqwt08BLK4eeWeq	2026-06-29 11:46:16.369	t	2026-06-29 11:44:16.498804
7cb69e29-a8c0-4299-ab00-37e1c20d1484	09178096289	$2b$10$oPgoKgRVxhSg1ALA1sZpxeHkcIqYOFiKqaTsMCsh3om7vONOitIt.	2026-06-29 11:56:43.891	t	2026-06-29 11:54:44.042952
47b140d0-3f19-4ea7-bf5b-51e831932159	09178096289	$2b$10$BmFcI6xClmPqaocDnW9Eue9cM5L10GrmQczvfPpKMZ7olHU0iwdiq	2026-06-29 12:02:01.908	t	2026-06-29 12:00:01.985762
2213cbf5-666e-427b-8999-f6175fb51cc8	09121234656	$2b$10$motgJHb7bXYiSVFWjR5ohun5y4JhCnMFlSBPFhoUVjasXPRRKDMP.	2026-06-29 12:10:53.889	t	2026-06-29 12:08:53.965235
762fb879-04d5-4195-baf8-080ac7c03744	09121234567	$2b$10$9EoZ6eTI2pkqGQq5eTCi7uy0aJKhiV8/aMjjr26cqJxIqaJNKrzx2	2026-06-29 12:17:47.612	t	2026-06-29 12:15:47.676753
4060d67b-b874-4790-86c5-aaedcd4ee693	09121234567	$2b$10$JvlTKwV3VIjb7laU.sTj/OKo6ovkwGoo4D6RtWsqkGgCBm9nwKcoq	2026-06-29 15:53:17.701	t	2026-06-29 15:51:17.916587
4ae9aca6-19ed-4954-9a2e-993bb8d2bc71	09178096289	$2b$10$CEi6EWWnb1aWnSgmhuGPy./MxHnKJfEIIyRf.Rj1LO3Q2Jw604m1.	2026-06-29 15:55:26.301	t	2026-06-29 15:53:26.428221
df930428-13ae-43d4-802c-f319d416d20f	09178096289	$2b$10$dU4WfJBYv3Ldfqx1IS8wdeyF28FJE594HrjqizwQmNeb1NpdxBt8u	2026-06-29 16:06:47.463	t	2026-06-29 16:04:47.660497
198aa072-6f5d-4fdd-a49d-a3eac4545658	09178096289	$2b$10$54iGbXIn7SkVBOsQfzfRJuYsz7hQoaCeWpMy2yT4W3Uq35xuPmts6	2026-06-29 16:26:25.881	t	2026-06-29 16:24:25.967452
c3fb8cb9-7435-4b5b-9226-37f65b3feb9d	09120000000	$2b$10$QvVIXOTN0VTbL56f.9hM3OzVt0hFO6gD3rWFo2IWMdUboi/9HVMiG	2026-06-29 16:54:14.075	f	2026-06-29 16:52:14.194328
03ccdb3d-c1b1-40c1-ad87-2f51a8298716	09178096289	$2b$10$1BL3Mm/uIpyy7mtBElNxJ.Xk3NBf0H8ByS2irfLUiR4lZ1ndybOGC	2026-06-29 17:11:21.841	t	2026-06-29 17:09:21.983081
1ee4e1ac-c853-49a4-b281-269a3c2fc9d3	09178096289	$2b$10$KlvzGw54ReRjQtfiie8YqODGLnVFW4AnO8F9/vcTQMCPyTO9oJHeG	2026-06-29 17:12:08.404	t	2026-06-29 17:10:08.472586
\.


--
-- Data for Name: products; Type: TABLE DATA; Schema: public; Owner: postgres
--

COPY public.products (id, name, description, price, stock, "createdAt", "updatedAt", species, gender, sku, "shortDescription", "discountPercent", status, "categorySlug", "subCategory", subspecies, "ageStage", colors, brand, "productType", size, material, "tagPair", "tagHandTame", "tagCustom", "tagLuxury", "tagHealthGuarantee", "tagFastShipping", images, weight, "tagFreeShipping", "tagCarryCage", "deletedAt", "isAmazingOffer", "discountPrice", "amazingOfferEndsAt", specifications, "lastEditedByName", "boughtTogetherProductIds") FROM stdin;
f3fe201b-68b0-4c16-a243-43980583a15b	African Grey Parrot	\N	5000000.00	0	2026-06-28 12:04:42.367324	2026-07-01 14:41:53.351386	african-grey	male	BP30171000	\N	\N	published	buy-parrot	\N	\N	molid	{grey,red}	\N	\N	\N	\N	f	f	f	f	t	f	{/uploads/b10dab0b-c2df-4d01-9303-8b72afbef3ab.png}	\N	f	f	2026-07-01 14:41:53.351386	f	\N	\N	\N	\N	{}
b93d8586-d6d9-4d22-9f0d-0ee77abc9aa7	غذای مخصوص طوطی آرا وزن1کیلو	غذای مخصوص طوطی آرا با فرمول کامل و متعادل، حاوی انواع دانه‌ها، آجیل و میوه‌های خشک مرغوب که تمام نیازهای تغذیه‌ای پرنده شما را تأمین می‌کند. این غذا سرشار از پروتئین، ویتامین‌ها و مواد معدنی ضروری است که به سلامت پر و پوست، تقویت سیستم ایمنی و افزایش انرژی طوطی کمک می‌کند.\nفرموله شده توسط متخصصان تغذیه پرندگان، بدون مواد نگهدارنده مضر و رنگ مصنوعی. مناسب برای طوطی‌های آرا، کاکادو و سایر طوطی‌سانان بزرگ.\nنحوه نگهداری: در جای خشک و خنک و دور از نور مستقیم آفتاب نگهداری شود. پس از باز کردن بسته‌بندی، درب آن را محکم ببندید.\nوزن: ۱ کیلوگرم	1500000.00	9	2026-06-30 16:37:26.47616	2026-07-05 11:25:59.459554	\N	\N	BP140504090004	\N	7	published	parrot-food	\N	\N	\N	\N	bayat-parrot	macaw	\N	\N	f	f	f	f	f	t	{/uploads/f6422a3c-f0c6-4d4a-b490-3b61516a7f51.webp,/uploads/b2ba701c-9fe7-4186-afe7-7d205a718e5c.webp}	1kg	t	f	\N	t	1400000.00	2026-07-10 23:59:00+03:30	[{"label": "برند", "value": "بیات پروت"}, {"label": "وزن", "value": "1 کیلوگرم"}, {"label": "نوع غذا", "value": "غذای مخلوط"}, {"label": "مناسب برای", "value": "طوطی آرا یا ماکائو"}, {"label": "نوع غذا", "value": "پلت، میوه خشک، 4 نوع ارزن، کافشه، تخم کتان، بادام زمینی و سویا"}, {"label": "نحوه خشک کردن میوه", "value": "فریز درای"}, {"label": "نوع میوه", "value": "موز، کیوی، توت فرنگی، سیب و انجیر"}, {"label": "مدت تاریخ انقضا", "value": "6 ماه"}, {"label": "کشور تولید کننده", "value": "ایران"}]	pahlevan	{}
dd8ae9ca-24dd-4ad4-a75f-303065321bd8	قفس طوطی افرا مناسب تمامی طوطی سانان	قفس افرا ترکیبی از استحکام فلز و زیبایی چوب است که علاوه بر ایجاد فضای امن برای پرنده، جلوه‌ای زیبا و طبیعی به محیط خانه می‌دهد. این قفس با طراحی کاربردی و تهویه مناسب ساخته شده تا پرنده در فضایی راحت، سالم و ایمن زندگی کند و در عین حال نگهداری و نظافت آن برای صاحب پرنده ساده باشد.\n\nبدنه فلزی مقاوم در کنار جزئیات چوبی، ظاهر این قفس را از قفس‌های معمولی متمایز کرده و آن را به گزینه‌ای مناسب برای استفاده در خانه، آپارتمان و محیط‌های داخلی تبدیل می‌کند.\n\n \n\nویژگی‌های اصلی قفس افرا\nبدنه فلزی مقاوم با دوام بالا برای استفاده طولانی‌مدت\nترکیب فلز و چوب برای ظاهری زیبا و دکوراتیو\nطراحی تاشو برای حمل و نگهداری آسان\nدارای تهویه مناسب برای گردش هوای بهتر داخل قفس\nقابلیت شست‌وشو برای حفظ بهداشت محیط پرنده\nمناسب برای استفاده در فضای خانه و آپارتمان\nطراحی کاربردی برای راحتی پرنده و صاحب آن\nبه همراه دو عدد ظرف استیل برای آب و غذا\n \n\nقفس افرا مناسب برای چه پرندگانی؟\nقفس افرا برای نگهداری پرندگان کوچک تا متوسط مناسب است، از جمله:\n\nمرغ عشق\nعروس هلندی\nکوتوله برزیلی\nطوطی گرینچیک\nطوطی راهب\nملنگو\nفنچ و قناری\nسایر طوطی‌سانان کوچک و متوسط\n \n\nقفس افرا مناسب برای چه افرادی؟\nافرادی که به دنبال قفسی مقاوم و کاربردی هستند\nکسانی که قفس قابل شست‌وشو و بهداشتی می‌خواهند\nصاحبان پرندگانی در تمام سنین\nافرادی که به ترکیب زیبایی چوب و استحکام فلز در دکور خانه اهمیت می‌دهند\nقفس افرا انتخابی کاربردی و زیبا برای ایجاد محیطی امن، سالم و راحت برای پرنده شماست.	19600000.00	10	2026-07-05 15:08:54.181042	2026-07-05 15:11:11.352933	\N	\N	BP140504140001	\N	0	pending	parrot-cage	\N	\N	\N	\N	\N	\N	medium	metal	f	f	f	t	t	t	{/uploads/fbf6f34e-a8e5-4281-9de2-c11dc1e473ce.webp,/uploads/703356f6-1436-435b-b9e3-9e5b3940888e.webp,/uploads/01b22ec3-6d5a-46a0-8579-6e213a9e2dda.webp}	\N	f	f	\N	f	\N	\N	[{"label": "ابعاد", "value": "طول 45 * عرض 45* ارتفاع 67 سانتی متر"}, {"label": "طراحی ویژه", "value": "برای کاهش استرس و جیغ زدن پرنده"}, {"label": "رنگ", "value": "مشکی"}, {"label": "نوع رنگ", "value": "کوره  و براق"}, {"label": "طراحی فاصله میله", "value": "مناسب برای همه طوطی ها"}, {"label": "کاربری محیطی", "value": "مناسب برای فضاهای کوچک"}, {"label": "نوع غذاخوری", "value": "کاسه استیل درب‌دار"}, {"label": "قابلیت نصب لانه تخم گذاری", "value": "دارد"}, {"label": "امکان خرید اقساطی", "value": "دارد"}, {"label": "پایه", "value": "امکان نصب انواع پایه"}, {"label": "مناسب برای طوطی", "value": "مرغ عشق، عروس هلندی، کوتوله برزیلی، طوطی گرینچیک، طوطی راهب، ملنگو، فنچ و قناری"}]	pahlevan	{}
0e673407-d637-49c3-9e02-96b4df951631	Cockatiel	\N	120.00	5	2026-06-27 13:54:09.076635	2026-07-01 14:42:20.368	cockatiel	male	\N	\N	\N	draft	\N	\N	\N	\N	\N	\N	\N	\N	\N	f	f	f	f	f	f	\N	\N	f	f	2026-07-01 14:42:20.368	f	\N	\N	\N	\N	{}
f3ed8cd4-deef-4785-bc56-0625c85ddefe	طوطی کاسکو نر تازه دانه خور	طوطی کاسکو آفریقایی (African Grey) یکی از باهوش‌ترین پرندگان جهان و بی‌رقیب‌ترین سخنگو در میان تمام طوطی‌سانان است. این پرنده‌ی نجیب با پرهای خاکستری دودی، صورت سفید و دم قرمز شاخص، ظاهری آرام و متین دارد که آن را از سایر طوطی‌ها متمایز می‌کند.\nهوش کاسکو واقعاً کم‌نظیر است؛ پژوهش‌ها نشان داده‌اند که این پرنده توانایی درک مفاهیم، شمارش، تشخیص رنگ‌ها و اشکال، و حتی بیان احساسات را دارد. کاسکو صرفاً کلمات را تکرار نمی‌کند، بلکه آن‌ها را در موقعیت درست به کار می‌برد و می‌تواند صدها واژه و جمله را یاد بگیرد. هوش این پرنده را معادل کودکی پنج‌ساله می‌دانند.\nکاسکو پرنده‌ای حساس و عاطفی است که با صاحب خود پیوندی عمیق و ماندگار برقرار می‌کند. این طوطی به توجه روزانه، تعامل مداوم و محرک‌های ذهنی فراوان نیاز دارد؛ در غیر این صورت ممکن است دچار افسردگی یا رفتارهایی مانند کندن پر شود. فراهم کردن اسباب‌بازی‌های فکری، زمان بازی و محیطی آرام برای سلامت روحی آن ضروری است.\nطول عمر کاسکو به ۵۰ تا ۶۰ سال و گاه بیشتر می‌رسد، بنابراین نگهداری از آن یک تعهد بلندمدت و جدی محسوب می‌شود. تغذیه‌ی مناسب شامل دانه‌های باکیفیت، میوه و سبزیجات تازه، نقش مهمی در سلامت و درخشندگی پرهای آن دارد. کاسکوی سالم، اهلی و آموزش‌دیده، همدمی وفادار، باهوش و سرگرم‌کننده برای سالیان طولانی خواهد بود که جای خالی هیچ حیوان خانگی دیگری را حس نخواهید کرد.	140000000.00	1	2026-07-01 13:46:30.741133	2026-07-04 16:40:35.388299	african-grey	male	BP140504100001	\N	18	published	buy-parrot	\N	red-tail	dane-khor	{gray}	\N	\N	\N	\N	f	t	f	f	t	t	{/uploads/e5025809-5f14-4ab8-823c-4f3d58cf0369.png,/uploads/ea963f2e-1478-4e1e-b49b-9a0b3696ae88.png,/uploads/f6ea56a3-365c-414d-b43e-316bc6902cad.png}	\N	t	t	\N	f	115000000.00	\N	[{"label": "گونه", "value": "کاسکو یا افریکن گری"}, {"label": "زیرگونه", "value": "دم قرمز یا کنگو"}, {"label": "جنسیت", "value": "نر"}, {"label": "سن", "value": "4 ماهه"}, {"label": "مرحله رشد", "value": "پیش دانه خور"}, {"label": "رنگ", "value": "خاکستری"}, {"label": "وزن", "value": "200 گرم"}, {"label": "دستی", "value": "دارد"}, {"label": "سخنگو", "value": "دراد"}, {"label": "شناسنامه", "value": "دارد"}, {"label": "حلقه پا", "value": "دارد"}]	pahlevan	{}
b4582239-d065-4c28-a2a5-dc8a1b27c918	قفس 1032مسافرتی پرندگان همراه با لوازم	قفس ۱۰۳۲ مسافرتی پرندگان همراه با لوازم یه گزینه کاربردی و مطمئنه برای وقتی که می‌خوای پرنده‌ات رو با خیال راحت جابه‌جا کنی؛ چه برای سفر، چه دامپزشکی یا حتی جابه‌جایی‌های کوتاه داخل شهر.\n\nطراحی سبک، دسته‌دار و خوش‌ابعاد این قفس باعث میشه هم حملش راحت باشه، هم پرنده توی مسیر احساس آرامش بیشتری داشته باشه.\n\nاین قفس برای انواع پرندگان خانگی حتی کاسکو مناسبه، اما برای پرنده‌های خیلی بزرگ مثل آرا و کاکادو انتخاب مناسبی نیست.\n\n \n\nویژگی‌های قفس 1032 مسافرتی\nجنس فلزی مقاوم و سبک\nهم دوام بالایی داره هم موقع حمل دستتو خسته نمی‌کنه\nطراحی کاملاً مسافرتی و دسته‌دار\nجابه‌جایی راحت و بدون دردسر برای صاحب پرنده\nباز و بسته شدن سریع\nمناسب مواقع ضروری، سفر یا مراجعه به دامپزشکی\nابعاد استاندارد و کاربردی\nطول: 36 سانتی‌متر\nعرض: 42 سانتی‌متر\nارتفاع: 55 سانتی‌متر\nاندازه‌ای مناسب که به‌راحتی داخل ماشین جا می‌گیره\nدارای درب جلو و قفل دار\nرنگ پودری ضد زنگ\n تمیز کردن آسان با سینی کف جداشونده\n \n\nمزایای استفاده از قفس ۱۰۳۲ مسافرتی\n✅ مناسب بیشتر پرندگان خانگی\n✅ کاهش استرس پرنده هنگام جابه‌جایی\n✅ بدون نیاز به خرید لوازم جانبی اضافی\n✅ حمل آسان برای سفر و استفاده روزمره\n✅ انتخابی اقتصادی و کاربردی\n\nاگه دنبال یه قفس سبک، مقاوم، خوش‌ابعاد و آماده استفاده برای پرنده‌ات هستی،\nقفس ۱۰۳۲ مسافرتی پرندگان همراه با لوازم دقیقاً همون چیزیه که کارت رو راه میندازه.\nهم خیال خودت راحته، هم پرنده‌ات مسیر آروم‌تری رو تجربه می‌کنه\n\n \n\nقفس 1032 مسافرتی پرندگان مناسب برای چه طوطی‌سانانی؟\nقفس 1032 برای پرندگان کوچک و متوسط طراحی شده و انتخابی ایده‌آل برای:\n\nمرغ عشق\n\nطوطی سنگال\nعروس هلندی\n\nکوتوله برزیلی\n\nطوطی راهب\n\nطوطی گرینچیک\n\nفنچ و قناری\n\nطوطی ملنگو\nهمچنین برای حمل موقت پرندگانی مثل کاسکو نیز مناسب است، البته با مدت زمان کوتاه‌تر.\n\nتوجه داشته باشید، هزینه ارسال کالا در مقصد و توسط گیرنده پرداخت می‌شود. یعنی پس از تحویل کالا به آدرس مورد نظر، مبلغ ارسال توسط پستچی یا شرکت حمل‌ونقل دریافت می‌شود.	2000000.00	10	2026-07-05 15:37:41.380539	2026-07-05 15:37:41.42514	\N	\N	BP140504140005	\N	0	pending	parrot-cage	\N	\N	\N	\N	\N	\N	medium	metal	f	f	f	f	t	t	{/uploads/a1290e76-6ea8-4cdb-98fd-945f5f06ae01.webp,/uploads/31b8cf9e-857a-40c2-bbe9-51b583c10f76.webp,/uploads/d86a48f8-5b39-4440-8b7e-ae66f8eb4de7.webp}	\N	f	f	\N	f	\N	\N	\N	pahlevan	{}
80703f9d-8292-477f-9af7-7e3b32b77fb7	قفس 1033 پلاس ریز بافت	اگر به دنبال قفسی سبک، مقاوم و ایمن برای جابه‌جایی پرنده خود هستید، قفس مسافرتی مدل 1033 پلاس انتخابی کاربردی و مطمئن است. این قفس با بدنه استیل ریزبافت و مقاوم طراحی شده که علاوه بر استحکام بالا، ایمنی بیشتری برای پرنده فراهم می‌کند و مانع از آسیب دیدن یا گیر کردن پا و منقار پرنده می‌شود. طراحی تاشو و دسته حمل، این قفس را به گزینه‌ای ایده‌آل برای سفر، مراجعه به دامپزشک یا جابه‌جایی کوتاه‌مدت تبدیل کرده است.\n\n \n\nویژگی‌های اصلی قفس مسافرتی پرندگان مدل 1033 پلاس\nبدنه فلزی از استیل ریزبافت و مقاوم با دوام بالا\nطراحی تاشو برای حمل و نگهداری آسان\nدارای دستگیره حمل برای جابه‌جایی راحت در سفر\nدرب کشویی برای دسترسی سریع و ایمن به پرنده\nتهویه مناسب برای حفظ جریان هوا و کاهش استرس پرنده\nسینی کف جداشونده برای تمیزکاری آسان\nسبک و کم‌جا، مناسب برای قرارگیری در خودرو\n \n\nقفس 1033 پلاس مناسب چه پرندگانی است؟\nاین قفس برای پرندگان کوچک تا متوسط طراحی شده و گزینه‌ای مناسب برای:\n\nمرغ عشق\nعروس هلندی\nکوتوله برزیلی (لاوبرد)\nطوطی راهب\nطوطی گرینچیک\nفنچ و قناری\nطوطی ملنگو\nهمچنین برای حمل موقت پرندگانی مانند کاسکو نیز قابل استفاده است، البته برای مدت زمان کوتاه.\n\nتوجه داشته باشید هزینه ارسال کالا در مقصد و توسط گیرنده پرداخت می‌شود؛ یعنی پس از تحویل کالا به آدرس مورد نظر، مبلغ ارسال توسط پستچی یا شرکت حمل‌ونقل دریافت خواهد شد.	2900000.00	10	2026-07-05 15:23:08.681181	2026-07-05 15:23:08.740313	\N	\N	BP140504140002	\N	0	pending	parrot-cage	\N	\N	\N	\N	\N	\N	medium	metal	f	f	f	f	t	t	{/uploads/53a59cbe-168d-4f45-9b17-8b5644d88be1.webp,/uploads/05d8a8be-4c1f-4fd5-8b76-a1ef110be4ca.webp,/uploads/815f7fed-8972-44ac-8dbd-a5777ec9e721.webp}	\N	f	f	\N	f	\N	\N	\N	pahlevan	{}
9d77b566-7785-4e9c-8fb0-9b0ac2c13950	قفس کاسکو مدل آرایی	هر کسی که یه طوطی بزرگ‌جثه مثل کاسکو، کاکادو، آمازون یا حتی ملنگوی پرجنب‌وجوش داره، اولین دغدغه‌اش امنیت و آرامشه.\n\nو قفس کاسکو دقیقاً برای همین ساخته شده؛ یه خونه واقعی، نه فقط یک قفس!\n\nقفس کاسکو از اون مدل قفس‌هایی‌یه که وقتی پرنده‌ت واردش میشه، انگار با خودش میگه: «اوه! بالاخره یکیه که فهمیده من شاهزاد‌ه‌ام!»\n\n \n\nچرا قفس آرایی اینقدر محبوب شده؟\nبدنه و میله‌ها از آهن محکم با رنگ کوره‌ای ساخته شدن؛ هم ضد خش، هم مقاوم، هم شیک.\nسایز مناسب و جمع‌وجور: 45×45×70 سانتی‌متر؛ نه خیلی بزرگ، نه خیلی کوچیک.\nرنگ مشکی مات، ظاهر قفس رو کاملاً مدرن و مرتب نشون میده.\nمخصوص طوطی‌سانان بزرگ ساخته شده، اما اگه سایزهای کوچیک‌ترش رو گرفتی، برای پرنده‌های متوسط هم عالیه.\n \n\nامکانات جذاب قفس آرایی\nیه نگاه ساده به عکس نشون میده این قفس فقط یه چهاردیواری نیست؛ کاملاً برای رفتارشناسی طوطی‌ها طراحی شده:\n\nسقف بازشو برای وقتایی که می‌خوای پرنده بال بزنه اما از محدوده خودش خارج نشه.\nدو عدد ظرف استیل خارجی (بهداشتی، مقاوم، ضد زنگ).\nکشوی فلزی تمیزکاری که به راحتی بیرون میاد و شست‌وشوش فوق‌العاده راحته.\nچهار چرخ ژله‌ای برای جابه‌جایی روان؛ بدون سروصدا و بدون خط انداختن روی کف.\nدرب‌های متنوع برای کنترل راحت‌تر پرنده، سرویس دادن به ظرف‌ها و جلوگیری از فرارهای قهرمانانه!\nتحمل وزن تا ۳۰ کیلو؛ یعنی واقعاً محکم‌تر از چیزی که ظاهرش نشون میده.\nباعث افزایش حس امنیت و آرامش طوطی می‌شود و رفتارهایی مثل جیغ‌زدن و استرس را کاهش می‌دهد.\n \n\nقفس کاسکو مدل آرایی مناسب برای کجاست؟\nعالی برای داخل منزل\nقابل استفاده در تراس و فضای نیمه‌باز (در زمان‌های کوتاه)\nچرخ‌دار و قابل جابه‌جایی\nظاهر شیک و مناسب دکوراسیون خانه\n \n\nقفس آرا مناسب چه کسانی است؟\nکسانی که فضای بزرگی دارن\nافرادی که به دکوراسیون اهمیت می‌دن\nصاحبان طوطی‌های حساس و استرسی\nکسانی که قفس متفاوت و خاص می‌خوان\nآپارتمان‌نشین‌ها\n \n\n زمان تحویل\n۱۰ تا ۲۰ روز کاری\n(به دلیل تولید دست‌ساز و سفارشی)\n\n \n\nخدمات بیات پروت\nارسال به سراسر کشور\nمونتاژش خیلی راحته؛ هر وقت محصول رسید، پیام بده و ویدئوی کامل راهنمای مونتاژ رو برات می‌فرستیم.	18000000.00	10	2026-07-05 15:32:42.813597	2026-07-05 15:32:42.860325	\N	\N	BP140504140003	\N	0	pending	parrot-cage	\N	\N	\N	\N	\N	\N	large	metal	f	f	f	t	t	t	{/uploads/740c3461-6398-43fc-af16-25bf1293df0a.webp,/uploads/9b7af9a2-afb4-490f-916f-72d589736d10.webp,/uploads/0fa51bd7-d22d-4b75-b361-946d6668d721.webp}	\N	f	f	\N	f	\N	\N	\N	pahlevan	{}
b98d0d4c-01a7-4636-acde-20ea6a8402a5	قفس طوطی پایه دار اریک مناسب تمامی طوطی سانان	قفس اریک یک قفس معمولی نیست؛ طراحیش به شکلی انجام شده که هم می‌تونی به‌صورت بدون پایه ازش استفاده کنی، هم با اتصال پایه تبدیلش کنی به یک قفس پایه‌دار ایستاده و شیک.\n\nاین یعنی هم برای خانه‌های کوچک مناسبه، هم برای افرادی که یک قفس بزرگ و ثابت می‌خوان. قفس اریک با ساختار فلزی محکم و ظاهری فوق‌العاده مدرن، خیلی سریع تبدیل میشه به بخشی از دکور خونتون.\n\n \n\n✨ ویژگی‌های مهم قفس اریک \n🔸 ۱. استفاده دوحالته: هم پایه‌دار، هم بدون پایه\n\nبسته به نیازت:\n\nاگر فضای کمی داری: بدون پایه روی هر سطحی قرار می‌گیره\nاگر قفس ایستاده می‌خوای: با پایه تبدیل میشه به قفس طوطی پایه‌دار حرفه‌ای\nاین انعطاف دقیقاً چیزیه که خیلی از خریداران قفس دنبالشن.\n\n🔸 ۲. طراحی مدرن با پنل‌های طرح‌دار\n\nکناره‌های طرح‌دار علاوه بر زیبایی:\n\nدید پرنده رو کنترل می‌کنن\nمحیط رو آروم‌تر می‌کنن\nاز پاشیدن غذا به محیط جلوگیری می‌کنن\nاین یعنی نور کافی + امنیت ذهنی بالا برای پرنده‌ت.\n\n🔸 ۳. میله‌های افقی استاندارد برای بالا رفتن راحت\n\nطوطی‌ها عاشق بالا رفتنن. میله‌های افقی این قفس:\n\nتحرک پرنده رو زیاد می‌کنن\nعضلات پا رو تقویت می‌کنن\nباعث سرگرمی بیشتر می‌شن\n🔸 4. مناسب برای طوطی‌های متوسط تا بزرگ جثه\n\nبر اساس ابعاد و ظاهر، اریک مناسب این پرنده‌هاست:\n\nکاسکو\nاکلکتوس\nکاکادو\nملنگو\nگرینچیک\nراهب\nعروس هلندی\nبرزیلی\nمرغ مینا\nطوطی خورشیدی\nعروس هلندی\nیک انتخاب عالی برای کسی که قفس برای انواع طوطی کوچک و متوسط می‌خواهد.\n\n🔸 ۶. کف جمع‌آوری فضولات + نظافت راحت\n\nکشو زیر قفس باعث میشه:\n\nتمیز کردن خیلی سریع انجام بشه\nلازم نباشه کل قفس جابه‌جا بشه\nبوی محیط کاهش پیدا کنه\nبرای آپارتمان‌نشین‌ها فوق‌العاده کاربردیه.\n\nقفس لاکچری اریک\n\n🧡 این قفس برای چه کسانی ایده‌آل است؟\nکسانی که فضای کمی دارن\nکسانی که هم قفس رومیزی می‌خوان، هم گزینه ایستاده\nافرادی که دنبال قفس شیک و دکوراتیو هستن\nصاحبان طوطی‌های حساس مثل ملنگو و گرینچیک\nکسانی که می‌خوان پرندشون کمتر بترسه\nخانواده‌هایی که دنبال کیفیت و دوام بالا هستن\n🆚 مقایسه قفس اریک با قفس ملورین (دو مدل پرفروش بیات‌پروت)\nویژگی\tقفس اریک\tقفس ملورین\nپایه‌دار و بدون پایه\t✔ هردو\t✔ فقط پایه‌دار\nظاهر\tمدرن، مینیمال\tکلاسیک–لوکس\nمناسب برای\tطوطی کوچک تا متوسط\tمتوسط تا بزرگ\nحمل‌ونقل\tآسان\tنیمه‌سنگین\nمیزان دید\tزیاد\tکنترل‌شده\nقیمت\tاقتصادی‌تر\tگران‌تر\n🛍 قفس اریک جایگزین چه نوع قفسی می‌تونه بشه؟\nقفس طوطی پایه بلند\nقفس طوطی پایه‌دار\nقفس طوطی بدون پایه\nقفس طوطی ایستاده\nقفس طوطی گنبدی ساده\nقفس 1044\nقفس1033 مسافرتی\nانواع قفس های فلزی سنگین و سبک\n💡 افزودن لامپ UVB (3500000 تومان اضافه)\nاگر بخوای لامپ مخصوص رشد پر، تقویت رنگ و افزایش آرامش به قفس اضافه میشه.\n\n🚚 تحویل 10 تا 20 روز کاری\nچون قفس دست‌سازه و سفارشی، با زمان استاندارد تولید ارسال میشه.	13000000.00	10	2026-07-05 15:45:46.212478	2026-07-05 15:45:46.295666	\N	\N	BP140504140008	\N	0	pending	parrot-cage	\N	\N	\N	\N	\N	\N	small	metal	f	f	t	t	t	t	{/uploads/fcd990b5-1871-4a03-b173-863044d63477.webp,/uploads/e96d9ed4-67ed-494c-b0fa-be5aaec2a508.webp,/uploads/3650ebde-32d6-4d66-bc13-ab2d945b5a76.webp,/uploads/26b88fea-49ea-4c2c-9786-7c35b1864d67.webp,/uploads/e499b288-db5c-4a5c-807d-012b2897154f.webp}	\N	f	f	\N	f	\N	\N	\N	pahlevan	{}
e91a0488-cedf-4dfa-a22f-63901c674c17	قفس طوطی پایه بلند آرنا مناسب تمامی طوطی سانان	قفس آرنا فقط یک قفس پرنده‌ نیست؛ یک المان دکوراتیوه که هم‌زمان زیبایی فضا و آرامش پرنده رو تأمین می‌کنه. طراحی خاص قفس آرنا به‌گونه‌ایه که می‌تونه هم بدون پایه استفاده بشه و هم با اتصال پایه‌های چوبی، تبدیل بشه به یک قفس ایستاده شیک و خاص؛ انتخابی عالی برای فضاهای کوچیک و مینیمال.\n\n \n\n \n\n✨ ویژگی‌های اصلی قفس آرنا\n🔸 ۱. طراحی دوحالته یعنی با پایه و بدون پایه\n\nبدون پایه: مناسب قرار گرفتن روی میز، کنسول یا شلف\nبا پایه: تبدیل به قفس ایستاده با ظاهر دکوراتیو\nیک قفس برای چند نوع استفاده، بدون اشغال فضای اضافی.\n\n🔸 ۲. طراحی نیمه‌پوشیده با پنل‌های فلزی طرح‌دار\n\nپنل پشتی و جانبی با برش‌های منظم:\n\nکاهش دید مستقیم پرنده به محیط\nایجاد حس امنیت و آرامش\nجلوگیری از پاشیدن غذا و پر به اطراف\nعبور نور کافی بدون ایجاد استرس\nاین طراحی برای طوطی‌های حساس فوق‌العاده کاربردیه.\n\n🔸 ۳. بدنه فلزی مستحکم با رنگ کوره‌ای\n\nساخته‌شده از فلز مقاوم\nپوشش رنگ کوره‌ای با دوام بالا\nمقاوم در برابر رطوبت، شست‌وشو و ضربه\nمناسب استفاده طولانی‌مدت داخل منزل\n🔸 ۴. میله‌های افقی استاندارد\n\nمیله‌های افقی کمک می‌کنن:\n\nطوطی راحت‌تر بالا بره\nتحرک و فعالیت داخل قفس بیشتر بشه\nعضلات پا و پنجه تقویت بشن\nپرنده کمتر کسل و بی‌تحرک باشه\n🔸 5. کف کشویی برای نظافت آسان\n\nدارای سینی جمع‌آوری فضولات\nتمیزکاری سریع بدون باز کردن کل قفس\nکاهش بو و آلودگی محیط\nکاملاً مناسب زندگی آپارتمانی\n🔸 6. طراحی دکوراتیو با پایه‌های چوبی\n\nپایه‌های چوبی:\n\nظاهر گرم و مدرن به قفس می‌دن\nقفس رو به بخشی از دکور خانه تبدیل می‌کنن\nمناسب فضاهای مینیمال و مدرن\n \n\n🐦 قفس آرنا مناسب برای چه پرنده‌هایی است؟\nقفس آرنا برای طوطی‌های کوچک تا متوسط مناسبه، مثل:\n\nعروس هلندی\n کاکادو\nکاسکو\nگالارز\nگرینچیک\nبرزیلی\nراهب\nملنگو\nشاه طوطی\nمرغ مینا\nطوطی خورشیدی\n \n\n🧡 قفس آرنا مناسب چه کسانی است؟\nکسانی که فضای محدودی دارن\nافرادی که به دکوراسیون اهمیت می‌دن\nصاحبان طوطی‌های حساس و استرسی\nکسانی که قفس متفاوت و خاص می‌خوان\nآپارتمان‌نشین‌ها\n \n\n💡 امکان افزودن لامپ UVB (هزینه جداگانه)\nدر صورت تمایل، امکان نصب:\n\nلامپ UVB مخصوص پرندگان\nکمک به رشد پر\nافزایش شادابی رنگ\nبهبود آرامش و سلامت پرنده\n \n\n🚚 زمان تحویل\n۱۰ تا ۲۰ روز کاری\n(به دلیل تولید دست‌ساز و سفارشی)	24000000.00	10	2026-07-05 15:35:56.427851	2026-07-05 15:35:56.492706	\N	\N	BP140504140004	\N	0	pending	parrot-cage	\N	\N	\N	\N	\N	\N	medium	metal	f	f	t	t	t	t	{/uploads/b2cf8be6-67e4-4b42-bb07-6f1a2da07d89.webp,/uploads/bf5c9c4c-f2f8-4d8c-a819-52dfa0b67323.webp,/uploads/c897c003-80b5-4977-818b-fdaebb92969e.webp}	\N	f	f	\N	f	\N	\N	\N	pahlevan	{}
46be265d-ff92-4512-aba0-58b5455acb50	لانه مناسب طوطی های بزرگ جثه	مشخصات فنی لانه طوطی\nجنس بدنه: چوب MDF با ضخامت مناسب، مقاوم در برابر ضربه و مناسب برای پرندگان خانگی\n\nرنگ: رنگ طبیعی MDF (قهوه‌ای روشن)، بدون رنگ یا پوشش اضافی\n\nنوع درب: درب لولایی از جلو با قفل فلزی برای باز و بسته کردن آسان\n\nتهویه: فاقد دریچه تهویه در ظاهر، اما می‌توان به راحتی افزود\n\nامکان بازرسی داخلی: درب جلو بازشونده برای نظارت، نظافت یا جمع‌آوری تخم‌ها\n\nدارای نردبان فلزی: جهت سهولت و راحتی مولدها\n ویژگی‌های کاربردی لانه طوطی\nمناسب برای:\nپرندگان بزرگ جثه مانند: طوطی کاسکو، شاه طوطی، طوطی کاکادو، طوطی گالارز\n\nسهولت نصب:\nطراحی مکعبی و سطح صاف باعث می‌شود بتوان آن را به راحتی روی قفس یا دیوار نصب کرد	6000000.00	10	2026-07-05 15:41:00.806519	2026-07-05 15:52:59.89393	\N	\N	BP140504140006	\N	25	pending	parrot-cage	\N	\N	\N	\N	\N	\N	\N	wooden	f	f	f	f	t	t	{/uploads/e2d41b5f-4f7e-4abb-b4af-a5548bcec557.webp,/uploads/1a90dd18-541e-4189-b731-b25fb862761e.webp,/uploads/5d51873e-bb87-4ca9-83e5-38a30dc0a09d.webp,/uploads/43be545b-10e1-4f05-ae7c-6ea90efeb6b2.webp,/uploads/a759405c-3031-4c52-9e04-20ea7f37111c.webp,/uploads/df7fbfb4-91b8-493f-916c-5a09a89ede50.webp,/uploads/c064f3d6-5429-4ee3-b2e9-b078109e72b2.webp}	\N	f	f	\N	t	4500000.00	2026-07-14 23:59:00+03:30	\N	pahlevan	{}
7cd1c3d0-481d-4790-961b-9a7ee3d09fa7	قفس بزرگ مدل ملورین مناسب تمامی پرندگان زینتی	قفس ملورین — بهترین انتخاب برای طوطی‌های کوچک و بزرگ \nاگر دنبال یک قفس ساده نیستی و واقعاً می‌خوای خانه‌ای امن، استاندارد، ضد استرس و زیبا و شیک برای طوطی‌ات فراهم کنی، قفس ملورین بهترین گزینه‌هست.\nاین قفس طوری طراحی شده که مناسب عروس هلندی، ملنگو، گرینچیک، راهب، اکلکتوس، کاکادو و حتی مدل‌های بزرگ‌تر مثل ماکائو باشه.\n\nدر واقع یک قفس چندمنظوره‌ست که جایگزین خیلی از مدل‌ها میشه مثل:\n\nقفس طوطی پایه بلند\nقفس طوطی پایه‌دار\nقفس طوطی ایستاده\nقفس 1044\nقفس گنبدی\nحتی قفس های بزرگ فلزی، سنگین و بزرگ\nبه همین دلیل بین خریداران قفس طوطی، جزو پرفروش‌ترین‌هاست.\n\n \n\nویژگی های قفس شیک و مدرن ملورین \n🔸 طراحی ویژه برای کاهش استرس و جیغ طوطی\n\nجنس ورق‌ها و میزان دید کنترل‌شده باعث میشه پرنده کمتر بترسه و به‌طور محسوسی جیغ‌های استرسی کاهش پیدا کنه.\nاین موضوع مخصوصاً برای قفس طوطی راهب، ملنگو، کاکادو و گرینچیک که پرنده‌های حساس‌تری هستن خیلی مهمه.\n\n🔸 فاصله میله‌ها کاملاً استاندارد\n\nبرای انواع طوطی‌ها از سایز کوچک تا متوسط عالیه: عروس هلندی، ملنگو، گرینچیک، راهب، اکلکتوس، کاکادو و حتی ماکائوی جوان.\n\nدیگه لازم نیست دنبال قفس طوطی‌های مختلف باشی؛ این یکی همه رو پوشش میده.\n\n🔸 رنگ کوره‌ای فوق‌مقاوم\n\nنه پوسته میشه، نه زنگ می‌زنه، نه با گاز گرفتن طوطی خراب میشه.\n\n🔸 تاشو و کم‌جا\n\nقفس ملورین برخلاف خیلی از قفس‌های پایه‌دار و ایستاده، کاملاً تاشوئه و برای آپارتمان و جابجایی ایده‌آله.\n\n🔸 چرخ ژله‌ای بی‌صدا\n\n۴ چرخ روان و بدون صدا → جابه‌جایی راحت بدون خط‌ انداختن روی سرامیک.\n\n🔸 دو کاسه استیل وارداتی\n\nجداشونده و کاملاً استاندارد برای انواع طوطی‌سانان.\n\n🔸 سقف شیشه‌ای با نوردهی عالی\n\nاین طراحی باعث میشه پرنده شادتر، فعال‌تر و کم‌استرس‌تر باشه. طوطی سانان به خصوص ملنگو، راهب و کاسکو که عاشق نور طبیعی هستن ایده‌آله.\n\n🔸داشتن فضای کافی برای لانه گذاری\n\nبرای فصل تخم‌گذاری، مخصوصاً عروس هلندی، کاسکو و طوطی آرا عالیه.\n\nقفس ملورین مناسب طوطی اکلکتوس\n\n🦜 قفس ملورین مناسب چه طوطی‌هایی است؟\nاین قفس یکی از معدود مدل‌هایی است که می‌تونه جایگزین چند مدل مختلف بشه:\n\n✔ قفس طوطی ملنگو\n\nسایز، رنگ، فاصله میله و نشیمن کاملاً مناسب ملنگوست.\n\n✔ قفس طوطی گرینچیک\n\nچون گرینچیک پرنده‌ای حساسه، این قفس به‌خاطر طراحی ضد استرس براش عالیه.\n\n✔ قفس طوطی راهب\n\nراهب‌ها گاهی جیغ‌زن هستن و قفس ملورین دقیقاً برای کاهش این رفتار ساخته شده.\n\n✔ قفس طوطی عروس هلندی\n\nابعاد، جای لانه، نشیمن و نور عالیه.\n\n✔ قفس طوطی اکلکتوس\n\nاکلکتوس به آرامش و نور مناسب نیاز داره: سقف شیشه‌ای عالیه.\n\n✔ قفس طوطی ماکائو / آرا\n\nبرای ماکائوی بالغ قفس بزرگ‌ نیاز هست و برای ماکائوی جوان و آرا عالیه.\n\n✔ قفس طوطی کاکادو\n\nکاکادوها حساسن و این قفس باعث میشه کمتر عصبی بشن.\n\n \n\n🛒 چرا این قفس ارزش خرید دارد؟\nترکیب زیبایی و استحکام\nضد استرس واقعی، نه فقط ادعا\nمناسب ده‌ها گونه طوطی\nتاشو و کم‌جا\nاستاندارد کامل برای امنیت پرنده\nظاهر شیک و دکوراتیو\nقابل استفاده به‌عنوان قفس ایستاده، قفس پایه‌دار و قفس گنبدی\nرتبه اول رضایت مشتری در قفس‌های سفارشی\nقابلیت نگهداری چندین طوطی در یک قفس\nقفس طوطی کاکادو و سایر پرندگان بزرگ جثه\n\n💸 امکان خرید قسطی قفس ملورین\nاگر پرداخت کامل الان برات راحت نیست، بیات‌پروت امکان خرید قسطی با شرایط آسان فراهم کرده.\n\n💡 افزودن لامپ UVB (۳ میلیون تومان اضافه)\nاگر بخوای لامپ مخصوص رشد پر، تقویت رنگ و افزایش آرامش به قفس اضافه میشه.\n\n🚚 تحویل 10 تا 20 روز کاری\nچون قفس دست‌سازه و سفارشی، با زمان استاندارد تولید ارسال میشه.	30000000.00	10	2026-07-05 15:42:52.275099	2026-07-05 15:42:52.374889	\N	\N	BP140504140007	\N	0	pending	parrot-cage	\N	\N	\N	\N	\N	\N	large	metal	f	f	t	t	t	t	{/uploads/7fb25926-ce46-46c5-9a42-20e4d484be89.webp,/uploads/02e748b6-3d2c-48c1-ad9f-e5cfc4f7054f.webp,/uploads/47848158-a7d2-4c3f-b013-70922eee5f05.webp,/uploads/9a3a8c77-393d-426d-aeee-eadc3cd5c2bf.webp,/uploads/f1b483b3-ff1b-40f8-ab4b-d6ddae0a1c80.webp,/uploads/dfd3047c-29ad-473c-9e2a-186ee593867a.webp,/uploads/be647a14-7fa2-40be-94fc-a5a5c04d49b8.webp}	\N	f	f	\N	f	\N	\N	\N	pahlevan	{}
d00bd994-cd78-485e-a670-c14c64a8f72d	لانه مناسب طوطی های متوسط جثه	مشخصات فنی لانه طوطی\nجنس بدنه: چوب MDF با ضخامت مناسب، مقاوم در برابر ضربه و مناسب برای پرندگان خانگی\n\nرنگ: رنگ طبیعی MDF (قهوه‌ای روشن)، بدون رنگ یا پوشش اضافی\n\nابعاد تخمینی:\nحدوداً 30-35 سانتی‌متر ارتفاع، 20-25 سانتی‌متر عرض و 25-30 سانتی‌متر عمق (با توجه به تصویر، تخمینی است)\n\nنوع درب: درب لولایی از جلو با قفل فلزی برای باز و بسته کردن آسان\n\nتهویه: فاقد دریچه تهویه در ظاهر، اما می‌توان به راحتی افزود\n\nامکان بازرسی داخلی: درب جلو بازشونده برای نظارت، نظافت یا جمع‌آوری تخم‌ها\n\nدارای نردبان فلزی: جهت سهولت و راحتی مولدها\n🐦 ویژگی‌های کاربردی لانه طوطی\nمناسب برای:\nپرندگان متوسط مانند طوطی راهب، گرینچیک، لوری، سنگال، ملنگو و عروس هلندی\n\nسهولت نصب:\nطراحی مکعبی و سطح صاف باعث می‌شود بتوان آن را به راحتی روی قفس یا دیوار نصب کرد	2500000.00	10	2026-07-05 15:48:43.081474	2026-07-05 15:48:43.135508	\N	\N	BP140504140009	\N	0	pending	parrot-cage	\N	\N	\N	\N	\N	\N	small	wooden	f	f	f	f	t	t	{/uploads/6ea8950a-a940-43e6-8762-0f907bb03f4c.webp,/uploads/1b588cc9-b5f3-4148-9b59-c0125e45bbac.webp,/uploads/fb2aa34e-30d9-481e-940d-a76bb97118d4.webp,/uploads/f0e6226b-0fe5-4d55-ba27-5c003323bfc6.webp}	\N	f	f	\N	f	\N	\N	\N	pahlevan	{}
31f84167-aefc-4053-bc6f-d42623ae82e2	قفس 1033 مسافرتی پرندگان همراه با لوازم	اگر به دنبال قفسی سبک، ایمن و جمع‌و‌جور برای سفر با پرنده‌تان هستید، قفس مدل 1033 بهترین انتخاب شماست. این قفس با طراحی مهندسی‌شده، هم حمل و نقل پرنده را راحت می‌کند، هم خیال شما را از امنیت و آرامش او در مسیر آسوده نگه می‌دارد.\n\nویژگی‌های اصلی قفس 1033 مسافرتی پرندگان\n بدنه‌ی فلزی مقاوم با رنگ پودری ضد زنگ\n وزن سبک و طراحی تاشو برای جابه‌جایی آسان\n دارای یک درب بزرگ برای دسترسی راحت\nمجهز به دسته حمل بالا برای راحتی در سفر\nجریان هوای مناسب برای جلوگیری از استرس در پرنده\nتمیز کردن آسان با سینی کف جداشونده\n ابعاد مناسب برای قرارگیری در خودرو یا محیط‌های محدود\nلوازم همراه: ظرف آب، ظرف غذا\nقفس 1033 مسافرتی پرندگان مناسب برای چه طوطی‌سانانی؟\nقفس 1033 برای پرندگان کوچک و متوسط طراحی شده و انتخابی ایده‌آل برای:\n\nمرغ عشق\n\nعروس هلندی\n\nکوتوله برزیلی\n\nطوطی راهب\n\nطوطی گرینچیک\n\nفنچ و قناری\n\nطوطی ملنگو\nهمچنین برای حمل موقت پرندگانی مثل کاسکو نیز مناسب است، البته با مدت زمان کوتاه‌تر.\n\nتوجه داشته باشید، هزینه ارسال کالا در مقصد و توسط گیرنده پرداخت می‌شود. یعنی پس از تحویل کالا به آدرس مورد نظر، مبلغ ارسال توسط پستچی یا شرکت حمل‌ونقل دریافت می‌شود.	2000000.00	10	2026-07-05 15:52:31.737098	2026-07-05 15:52:31.760627	\N	\N	BP140504140010	\N	0	pending	parrot-cage	\N	\N	\N	\N	\N	\N	medium	metal	f	f	f	f	t	t	{/uploads/c4743726-1797-452b-9b69-0f6ae1689245.webp}	\N	f	f	\N	f	\N	\N	\N	pahlevan	{}
\.


--
-- Data for Name: users; Type: TABLE DATA; Schema: public; Owner: postgres
--

COPY public.users (id, email, role, "createdAt", "updatedAt", phone, "firstName", "lastName", "profileCompleted", "loyaltyPoints") FROM stdin;
c92c29d4-9dd7-403a-a1db-768d5a8d7a82	\N	admin	2026-06-27 13:52:39.860623	2026-06-27 13:53:53.4127	09121234567	امیر	توحیدی	t	0
53c09186-f520-43d0-bc18-060e6396a28b	\N	customer	2026-06-29 12:09:53.329708	2026-06-29 12:09:53.329708	09121234656	\N	\N	f	0
ededd281-d6ee-4b00-9b92-27c2591423a4	\N	customer	2026-06-27 17:08:39.5132	2026-06-29 16:25:07.939101	09178096289	امیر	توحیدی	t	0
\.


--
-- Name: order_items PK_005269d8574e6fac0493715c308; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.order_items
    ADD CONSTRAINT "PK_005269d8574e6fac0493715c308" PRIMARY KEY (id);


--
-- Name: products PK_0806c755e0aca124e67c0cf6d7d; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.products
    ADD CONSTRAINT "PK_0806c755e0aca124e67c0cf6d7d" PRIMARY KEY (id);


--
-- Name: categories PK_24dbc6126a28ff948da33e97d3b; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.categories
    ADD CONSTRAINT "PK_24dbc6126a28ff948da33e97d3b" PRIMARY KEY (id);


--
-- Name: orders PK_710e2d4957aa5878dfe94e4ac2f; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.orders
    ADD CONSTRAINT "PK_710e2d4957aa5878dfe94e4ac2f" PRIMARY KEY (id);


--
-- Name: otps PK_91fef5ed60605b854a2115d2410; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.otps
    ADD CONSTRAINT "PK_91fef5ed60605b854a2115d2410" PRIMARY KEY (id);


--
-- Name: users PK_a3ffb1c0c8416b9fc6f907b7433; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.users
    ADD CONSTRAINT "PK_a3ffb1c0c8416b9fc6f907b7433" PRIMARY KEY (id);


--
-- Name: orders UQ_59b0c3b34ea0fa5562342f24143; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.orders
    ADD CONSTRAINT "UQ_59b0c3b34ea0fa5562342f24143" UNIQUE ("orderNumber");


--
-- Name: categories UQ_8b0be371d28245da6e4f4b61878; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.categories
    ADD CONSTRAINT "UQ_8b0be371d28245da6e4f4b61878" UNIQUE (name);


--
-- Name: users UQ_97672ac88f789774dd47f7c8be3; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.users
    ADD CONSTRAINT "UQ_97672ac88f789774dd47f7c8be3" UNIQUE (email);


--
-- Name: users UQ_a000cca60bcf04454e727699490; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.users
    ADD CONSTRAINT "UQ_a000cca60bcf04454e727699490" UNIQUE (phone);


--
-- Name: products UQ_c44ac33a05b144dd0d9ddcf9327; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.products
    ADD CONSTRAINT "UQ_c44ac33a05b144dd0d9ddcf9327" UNIQUE (sku);


--
-- Name: orders FK_151b79a83ba240b0cb31b2302d1; Type: FK CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.orders
    ADD CONSTRAINT "FK_151b79a83ba240b0cb31b2302d1" FOREIGN KEY ("userId") REFERENCES public.users(id);


--
-- Name: order_items FK_cdb99c05982d5191ac8465ac010; Type: FK CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.order_items
    ADD CONSTRAINT "FK_cdb99c05982d5191ac8465ac010" FOREIGN KEY ("productId") REFERENCES public.products(id);


--
-- Name: order_items FK_f1d359a55923bb45b057fbdab0d; Type: FK CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.order_items
    ADD CONSTRAINT "FK_f1d359a55923bb45b057fbdab0d" FOREIGN KEY ("orderId") REFERENCES public.orders(id) ON DELETE CASCADE;


--
-- PostgreSQL database dump complete
--

