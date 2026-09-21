-- In MySQL terminal
-- Hostinger creates the database for you (e.g. u598097533_dentall_db); select it in phpMyAdmin instead.





CREATE TABLE IF NOT EXISTS orders (
   id                    INT AUTO_INCREMENT PRIMARY KEY,
   razorpay_order_id     VARCHAR(64)  NOT NULL,
   razorpay_payment_id   VARCHAR(64)  NOT NULL,
   customer_name         VARCHAR(255) NOT NULL,
   customer_email        VARCHAR(100) NOT NULL,
   customer_phone        VARCHAR(20)  NOT NULL,
   customer_address      TEXT,
    customer_city         VARCHAR(100),
   customer_state        VARCHAR(100),
    customer_pincode      VARCHAR(6),
    items_json            TEXT,
   subtotal              DECIMAL(10,2),
   shipping_charge       DECIMAL(10,2) DEFAULT 0,
   coupon_code           VARCHAR(30),
   discount_amount       DECIMAL(10,2) DEFAULT 0,
    total                 DECIMAL(10,2),
   status                VARCHAR(50)  DEFAULT 'pending',
   awb_number            VARCHAR(100),
   shiprocket_order_id   VARCHAR(100),
  created_at            DATETIME,
   UNIQUE KEY uniq_payment (razorpay_payment_id),  -- replay attack prevention
   INDEX idx_order_id    (razorpay_order_id),
   INDEX idx_email       (customer_email),
   INDEX idx_status      (status),
   INDEX idx_created     (created_at)
 );

 CREATE TABLE IF NOT EXISTS leads (
   id         INT AUTO_INCREMENT PRIMARY KEY,
   name       VARCHAR(255),
  email      VARCHAR(100) NOT NULL,
  phone      VARCHAR(20),
    created_at DATETIME,
   UNIQUE KEY uniq_email (email)
 );

  CREATE TABLE IF NOT EXISTS reviews (
  id           INT AUTO_INCREMENT PRIMARY KEY,
  customer_name VARCHAR(255) NOT NULL,
  email        VARCHAR(255) NOT NULL,
  rating       TINYINT NOT NULL CHECK (rating >= 1 AND rating <= 5),
  review_text  TEXT NOT NULL,
  approved     BOOLEAN DEFAULT FALSE,
  created_at   TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  INDEX idx_email (email),
  INDEX idx_approved (approved),
  INDEX idx_created (created_at)
);

CREATE TABLE IF NOT EXISTS pricing (
  product_id VARCHAR(50) PRIMARY KEY,
  price      DECIMAL(10,2) NOT NULL,
  mrp        DECIMAL(10,2) NULL,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS coupons (
  code             VARCHAR(30) PRIMARY KEY,
  discount_percent DECIMAL(5,2) NOT NULL,
  active           BOOLEAN DEFAULT TRUE,
  created_at       TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at       TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS wholesale_enquiries (
  id             INT AUTO_INCREMENT PRIMARY KEY,
  full_name      VARCHAR(150) NOT NULL,
  business_name  VARCHAR(180) NOT NULL,
  email          VARCHAR(150) NOT NULL,
  phone          VARCHAR(20)  NOT NULL,
  city           VARCHAR(100) NOT NULL,
  state          VARCHAR(100) NOT NULL,
  quantity_range VARCHAR(30)  NOT NULL,
  business_type  VARCHAR(60),
  message        TEXT,
  status         VARCHAR(40) DEFAULT 'new',
  created_at     TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  INDEX idx_email   (email),
  INDEX idx_status  (status),
  INDEX idx_created (created_at)
);

-- Retail dealer enquiries (submitted from the "Dealers" form on the site)
CREATE TABLE IF NOT EXISTS dealer_enquiries (
  id            INT AUTO_INCREMENT PRIMARY KEY,
  contact_name  VARCHAR(150) NOT NULL,
  shop_name     VARCHAR(180) NOT NULL,
  gstin         VARCHAR(15)  NOT NULL,
  email         VARCHAR(150) NOT NULL,
  phone         VARCHAR(20)  NOT NULL,
  address       TEXT         NOT NULL,
  city          VARCHAR(100) NOT NULL,
  state         VARCHAR(100) NOT NULL,
  pincode       VARCHAR(6)   NOT NULL,
  quantity      INT          NOT NULL,
  message       TEXT,
  status        VARCHAR(30)  DEFAULT 'new',   -- new | quoted | closed
  created_at    TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  INDEX idx_dealer_email   (email),
  INDEX idx_dealer_status  (status),
  INDEX idx_dealer_created (created_at)
);

-- Custom-priced quotes created by the admin; each has a private, unguessable link token
CREATE TABLE IF NOT EXISTS dealer_quotes (
  id              INT AUTO_INCREMENT PRIMARY KEY,
  enquiry_id      INT           NOT NULL,
  token           CHAR(64)      NOT NULL,
  quantity        INT           NOT NULL,
  goods_total     DECIMAL(12,2) NOT NULL,
  gst_percent     DECIMAL(5,2)  NOT NULL DEFAULT 0,
  freight         DECIMAL(10,2) NOT NULL DEFAULT 0,
  advance_percent DECIMAL(5,2)  NOT NULL DEFAULT 0,   -- 0 = full cash on delivery
  notes           TEXT,
  valid_until     DATE          NOT NULL,
  status          VARCHAR(20)   NOT NULL DEFAULT 'sent',  -- sent | cancelled (| accepted, later phase)
  created_at      TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY uniq_quote_token (token),
  INDEX idx_quote_enquiry (enquiry_id)
);
