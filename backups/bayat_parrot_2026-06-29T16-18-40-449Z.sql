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
    price numeric(10,2) NOT NULL,
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
    weight integer,
    "productType" character varying,
    size character varying,
    material character varying,
    "tagPair" boolean DEFAULT false NOT NULL,
    "tagHandTame" boolean DEFAULT false NOT NULL,
    "tagCustom" boolean DEFAULT false NOT NULL,
    "tagLuxury" boolean DEFAULT false NOT NULL,
    "tagHealthGuarantee" boolean DEFAULT false NOT NULL,
    "tagFastShipping" boolean DEFAULT false NOT NULL,
    images text[]
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
9191709c-a3ee-4b06-b711-198a1251173a	c92c29d4-9dd7-403a-a1db-768d5a8d7a82	pending	5000000.00	2026-06-28 16:49:41.204253	2026-06-28 16:49:41.204253	??? ????	BP-14050407-0003	1234567890	pending	\N
b838cbd3-d1f5-4ddf-95f0-9a4f75d727fa	c92c29d4-9dd7-403a-a1db-768d5a8d7a82	shipped	5000000.00	2026-06-28 17:11:43.699522	2026-06-29 16:14:02.325952	test	BP-140504070004	123	pending	\N
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

COPY public.products (id, name, description, price, stock, "createdAt", "updatedAt", species, gender, sku, "shortDescription", "discountPercent", status, "categorySlug", "subCategory", subspecies, "ageStage", colors, brand, weight, "productType", size, material, "tagPair", "tagHandTame", "tagCustom", "tagLuxury", "tagHealthGuarantee", "tagFastShipping", images) FROM stdin;
0e673407-d637-49c3-9e02-96b4df951631	Cockatiel	\N	120.00	5	2026-06-27 13:54:09.076635	2026-06-27 13:54:09.076635	cockatiel	male	\N	\N	\N	draft	\N	\N	\N	\N	\N	\N	\N	\N	\N	\N	f	f	f	f	f	f	\N
f3fe201b-68b0-4c16-a243-43980583a15b	African Grey Parrot	\N	5000000.00	0	2026-06-28 12:04:42.367324	2026-06-28 15:33:12.777363	african-grey	male	BP30171000	\N	\N	published	buy-parrot	\N	\N	molid	{grey,red}	\N	\N	\N	\N	\N	f	f	f	f	t	f	{/uploads/b10dab0b-c2df-4d01-9303-8b72afbef3ab.png}
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

