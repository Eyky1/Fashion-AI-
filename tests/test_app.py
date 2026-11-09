import io
import csv
import json
import os
import sqlite3
import sys
import tempfile
import unittest
from pathlib import Path


PROJECT_ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(PROJECT_ROOT))
_import_temp_dir = tempfile.TemporaryDirectory()
os.environ["FABIA_DATABASE"] = str(Path(_import_temp_dir.name) / "import.sqlite3")

import app as store_app


PNG_BYTES = b"\x89PNG\r\n\x1a\n" + b"\x00" * 24
JPEG_BYTES = b"\xff\xd8\xff" + b"\x00" * 24


class StoreApiTests(unittest.TestCase):
    def setUp(self):
        self.temp_dir = tempfile.TemporaryDirectory()
        root = Path(self.temp_dir.name)
        store_app.DATABASE = root / "test.sqlite3"
        store_app.UPLOAD_DIR = root / "uploads"
        store_app.UPLOAD_DIR.mkdir()
        store_app.initialize_database()
        store_app.app.config.update(TESTING=True, ADMIN_ENABLED=True)
        self.client = store_app.app.test_client()
        self.reference_counter = 0
        with self.client.session_transaction() as session:
            session["admin_authenticated"] = True
            session["csrf_token"] = "test-csrf-token"
        self.headers = {"X-CSRF-Token": "test-csrf-token"}

    def tearDown(self):
        self.temp_dir.cleanup()

    def product_data(self, name="Blusa", stock=None, price="19.99", reference=None):
        self.reference_counter += 1
        return {
            "name": name,
            "reference": reference if reference is not None else f"TEST-{self.reference_counter:04d}",
            "description": "Peça de teste",
            "price": price,
            "category": "Blusas",
            "stock": json.dumps(stock or {"P": 2, "M": 3, "G": 0, "GG": 0, "Único": 0}),
        }

    def add_product(self, name="Blusa", stock=None, image=None, try_on_image=None):
        data = self.product_data(name, stock)
        if image:
            data["image"] = (io.BytesIO(image), "foto.png", "image/png")
        if try_on_image:
            data["tryon-image"] = (io.BytesIO(try_on_image), "recorte.png", "image/png")
        response = self.client.post("/api/products", data=data, headers=self.headers)
        self.assertEqual(response.status_code, 201, response.get_json())
        return response.get_json()["id"]

    def create_order(self, product_id, quantity=1, size="P"):
        return self.client.post(
            "/api/orders",
            json={
                "items": [{"productId": product_id, "quantity": quantity, "size": size}],
                "buyerName": "Maria da Silva",
                "buyerPhone": "(83) 99999-1234",
            },
            headers=self.headers,
        )

    def set_order_status(self, order_id, status):
        return self.client.patch(
            f"/api/admin/orders/{order_id}",
            json={"status": status},
            headers=self.headers,
        )

    def get_product(self, product_id):
        return next(
            product for product in self.client.get("/api/products").get_json()
            if product["id"] == product_id
        )

    def test_admin_page_includes_label_reader_for_single_and_bulk_products(self):
        response = self.client.get("/admin")
        self.assertEqual(response.status_code, 200)
        html = response.get_data(as_text=True)
        self.assertIn("label-reader.js", html)
        self.assertIn("até 40 peças por lote", html)
        self.assertEqual(html.count("data-label-image"), 2)

    def test_product_price_stock_and_uploaded_image_are_validated(self):
        response = self.client.post(
            "/api/products",
            data=self.product_data(price="19.999"),
            headers=self.headers,
        )
        self.assertEqual(response.status_code, 400)

        invalid_stock = self.product_data(stock={"P": 1.5})
        response = self.client.post("/api/products", data=invalid_stock, headers=self.headers)
        self.assertEqual(response.status_code, 400)

        response = self.client.post(
            "/api/products",
            data={
                **self.product_data(),
                "image": (io.BytesIO(b"<html>not an image</html>"), "fake.png", "image/png"),
            },
            headers=self.headers,
        )
        self.assertEqual(response.status_code, 400)
        self.assertEqual(list(store_app.UPLOAD_DIR.iterdir()), [])

        product_id = self.add_product(image=PNG_BYTES)
        product = self.get_product(product_id)
        self.assertEqual(product["priceCents"], 1999)
        self.assertEqual(product["stock"]["P"], 2)
        self.assertTrue((store_app.UPLOAD_DIR / product["image"]).is_file())

    def test_tryon_image_is_available_and_cleaned_with_product(self):
        product_id = self.add_product(image=PNG_BYTES, try_on_image=PNG_BYTES)
        product = self.get_product(product_id)
        self.assertTrue(product["tryOnImage"])
        self.assertTrue((store_app.UPLOAD_DIR / product["tryOnImage"]).is_file())

        response = self.client.delete(f"/api/products/{product_id}", headers=self.headers)
        self.assertEqual(response.status_code, 200)
        self.assertFalse((store_app.UPLOAD_DIR / product["image"]).exists())
        self.assertFalse((store_app.UPLOAD_DIR / product["tryOnImage"]).exists())

    def test_product_reference_is_required_unique_and_editable(self):
        product_id = self.add_product()
        product = self.get_product(product_id)
        original_reference = product["reference"]
        self.assertTrue(original_reference.startswith("TEST-"))

        duplicate = self.client.post(
            "/api/products",
            data=self.product_data(reference=original_reference.lower()),
            headers=self.headers,
        )
        self.assertEqual(duplicate.status_code, 400)
        self.assertIn("cadastrada", duplicate.get_json()["error"])

        with self.client.session_transaction() as session:
            session["admin_authenticated"] = False
        public_product = self.client.get("/api/products").get_json()[0]
        self.assertNotIn("reference", public_product)
        with self.client.session_transaction() as session:
            session["admin_authenticated"] = True

        updated = self.client.put(
            f"/api/products/{product_id}",
            data=self.product_data(reference="BL-024"),
            headers=self.headers,
        )
        self.assertEqual(updated.status_code, 200)
        self.assertEqual(self.get_product(product_id)["reference"], "BL-024")

        missing_reference = self.product_data(reference="")
        response = self.client.post("/api/products", data=missing_reference, headers=self.headers)
        self.assertEqual(response.status_code, 400)

    def test_bulk_product_references_must_be_unique(self):
        products = [self.product_data(name=f"Produto {index}") for index in range(5)]
        products[1]["reference"] = products[0]["reference"].lower()
        data = {"products": json.dumps(products)}
        for index in range(5):
            data[f"image-{index}"] = (io.BytesIO(PNG_BYTES), f"{index}.png", "image/png")

        response = self.client.post("/api/products/bulk", data=data, headers=self.headers)
        self.assertEqual(response.status_code, 400)
        self.assertIn("repetida neste lote", response.get_json()["error"])
        self.assertEqual(self.client.get("/api/products").get_json(), [])
        self.assertEqual(list(store_app.UPLOAD_DIR.iterdir()), [])

    def test_replacing_and_deleting_product_removes_unused_images(self):
        product_id = self.add_product(image=PNG_BYTES)
        original_image = self.get_product(product_id)["image"]
        response = self.client.put(
            f"/api/products/{product_id}",
            data={
                **self.product_data(name="Blusa editada"),
                "image": (io.BytesIO(JPEG_BYTES), "nova.jpg", "image/jpeg"),
            },
            headers=self.headers,
        )
        self.assertEqual(response.status_code, 200, response.get_json())
        updated_image = self.get_product(product_id)["image"]
        self.assertNotEqual(original_image, updated_image)
        self.assertFalse((store_app.UPLOAD_DIR / original_image).exists())
        self.assertTrue((store_app.UPLOAD_DIR / updated_image).exists())

        response = self.client.delete(f"/api/products/{product_id}", headers=self.headers)
        self.assertEqual(response.status_code, 200)
        self.assertFalse((store_app.UPLOAD_DIR / updated_image).exists())

    def test_order_payload_validation_and_status_transitions_are_consistent(self):
        product_id = self.add_product(stock={"P": 2, "M": 0, "G": 0, "GG": 0, "Único": 0})

        self.assertEqual(self.client.post("/api/orders", json=[], headers=self.headers).status_code, 400)
        self.assertEqual(
            self.client.post(
                "/api/orders",
                json={"items": [{"productId": product_id, "quantity": 1.5, "size": "P"}]},
                headers=self.headers,
            ).status_code,
            400,
        )

        created = self.create_order(product_id, quantity=2)
        self.assertEqual(created.status_code, 201, created.get_json())
        order_id = created.get_json()["orderId"]
        self.assertEqual(self.get_product(product_id)["stock"]["P"], 0)

        self.assertEqual(self.set_order_status(order_id, "completed").status_code, 409)
        self.assertEqual(self.set_order_status(order_id, "confirmed").status_code, 200)
        self.assertEqual(self.get_product(product_id)["stock"]["P"], 0)
        self.assertEqual(self.set_order_status(order_id, "confirmed").status_code, 409)
        self.assertEqual(self.set_order_status(order_id, "cancelled").status_code, 409)
        self.assertEqual(self.set_order_status(order_id, "completed").status_code, 200)

    def test_cancelling_order_returns_reserved_stock(self):
        product_id = self.add_product(stock={"P": 2, "M": 0, "G": 0, "GG": 0, "Único": 0})
        created = self.create_order(product_id)
        order_id = created.get_json()["orderId"]
        self.assertEqual(self.get_product(product_id)["stock"]["P"], 1)

        self.assertEqual(self.set_order_status(order_id, "cancelled").status_code, 200)
        self.assertEqual(self.get_product(product_id)["stock"]["P"], 2)

    def test_pending_order_prevents_product_removal_until_resolved(self):
        product_id = self.add_product(stock={"P": 1, "M": 0, "G": 0, "GG": 0, "Único": 0})
        order_id = self.create_order(product_id).get_json()["orderId"]

        removal = self.client.delete(f"/api/products/{product_id}", headers=self.headers)
        self.assertEqual(removal.status_code, 409)
        self.assertEqual(self.set_order_status(order_id, "cancelled").status_code, 200)
        removal = self.client.delete(f"/api/products/{product_id}", headers=self.headers)
        self.assertEqual(removal.status_code, 200)

    def test_orders_require_and_store_buyer_identity(self):
        product_id = self.add_product()
        invalid = self.client.post(
            "/api/orders",
            json={"items": [{"productId": product_id, "quantity": 1, "size": "P"}]},
            headers=self.headers,
        )
        self.assertEqual(invalid.status_code, 400)

        response = self.create_order(product_id)
        self.assertEqual(response.status_code, 201)
        orders = self.client.get("/api/admin/orders").get_json()
        self.assertEqual(orders[0]["buyerName"], "Maria da Silva")
        self.assertEqual(orders[0]["buyerPhone"], "5583999991234")

    def test_admin_settings_persist_low_stock_limit(self):
        settings = self.client.get("/api/admin/settings")
        self.assertEqual(settings.status_code, 200)
        self.assertEqual(settings.get_json()["lowStockThreshold"], 2)

        updated = self.client.put(
            "/api/admin/settings",
            json={"lowStockThreshold": 7},
            headers=self.headers,
        )
        self.assertEqual(updated.status_code, 200)
        self.assertEqual(self.client.get("/api/admin/settings").get_json()["lowStockThreshold"], 7)
        invalid = self.client.put(
            "/api/admin/settings",
            json={"lowStockThreshold": 101},
            headers=self.headers,
        )
        self.assertEqual(invalid.status_code, 400)

    def test_public_mode_disables_admin_and_product_mutations(self):
        store_app.app.config["ADMIN_ENABLED"] = False
        try:
            for path in (
                "/admin",
                "/admin/login",
                "/admin/setup",
                "/api/admin/orders",
                "/api/admin/settings",
                "/api/admin/orders.csv",
            ):
                with self.subTest(path=path):
                    self.assertEqual(self.client.get(path).status_code, 404)

            for path, method in (
                ("/admin/login", "post"),
                ("/admin/setup", "post"),
                ("/api/products", "post"),
                ("/api/products/bulk", "post"),
                ("/api/products/1", "put"),
                ("/api/products/1", "delete"),
                ("/api/admin/settings", "put"),
                ("/api/admin/orders/1", "patch"),
            ):
                with self.subTest(path=path, method=method):
                    response = getattr(self.client, method)(path, headers=self.headers)
                    self.assertEqual(response.status_code, 404)

            self.assertEqual(self.client.get("/").status_code, 200)
            self.assertEqual(self.client.get("/api/products").status_code, 200)
            order_response = self.client.post(
                "/api/orders",
                json={"buyerName": "Teste", "buyerPhone": "83999991234", "items": []},
                headers=self.headers,
            )
            self.assertEqual(order_response.status_code, 400)
            self.assertIn("carrinho", order_response.get_json()["error"].lower())
        finally:
            store_app.app.config["ADMIN_ENABLED"] = True

    def test_orders_csv_is_filterable_and_safe_for_spreadsheet_formulas(self):
        product_id = self.add_product()
        self.client.post(
            "/api/orders",
            json={
                "items": [{"productId": product_id, "quantity": 1, "size": "P"}],
                "buyerName": "=FORMULA",
                "buyerPhone": "83999991234",
            },
            headers=self.headers,
        )

        response = self.client.get("/api/admin/orders.csv?search=5583999991234")
        self.assertEqual(response.status_code, 200)
        self.assertIn("text/csv", response.content_type)
        rows = list(csv.reader(io.StringIO(response.get_data(as_text=True).lstrip("\ufeff"))))
        self.assertEqual(len(rows), 2)
        self.assertEqual(rows[1][1], "'=FORMULA")
        self.assertEqual(rows[1][2], "5583999991234")
        self.assertIn("19.99", rows[1][5])

    def test_database_migration_preserves_existing_products_and_orders(self):
        legacy_database = Path(self.temp_dir.name) / "legacy.sqlite3"
        connection = sqlite3.connect(legacy_database)
        try:
            connection.executescript(
                """
                CREATE TABLE products (
                    id INTEGER PRIMARY KEY,
                    name TEXT NOT NULL,
                    description TEXT NOT NULL DEFAULT '',
                    price_cents INTEGER NOT NULL,
                    category TEXT NOT NULL,
                    image TEXT,
                    stock TEXT NOT NULL DEFAULT '{}',
                    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
                );
                CREATE TABLE orders (
                    id INTEGER PRIMARY KEY,
                    items TEXT NOT NULL,
                    total_cents INTEGER NOT NULL,
                    status TEXT NOT NULL DEFAULT 'pending',
                    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
                );
                INSERT INTO products (id, name, price_cents, category, stock)
                VALUES (1, 'Produto existente', 1234, 'Blusas', '{}');
                INSERT INTO orders (id, items, total_cents)
                VALUES (1, '[]', 0);
                """
            )
        finally:
            connection.close()
        store_app.DATABASE = legacy_database
        store_app.initialize_database()

        connection = sqlite3.connect(legacy_database)
        try:
            product_columns = {row[1] for row in connection.execute("PRAGMA table_info(products)")}
            order_columns = {row[1] for row in connection.execute("PRAGMA table_info(orders)")}
            existing_product = connection.execute(
                "SELECT name, reference FROM products WHERE id = 1"
            ).fetchone()
            existing_order = connection.execute(
                "SELECT buyer_name, buyer_phone FROM orders WHERE id = 1"
            ).fetchone()
        finally:
            connection.close()
        self.assertIn("tryon_image", product_columns)
        self.assertTrue({"buyer_name", "buyer_phone", "stock_reserved"} <= order_columns)
        self.assertEqual(existing_product, ("Produto existente", "AUTO-000001"))
        self.assertEqual(existing_order, ("", ""))
        connection = sqlite3.connect(legacy_database)
        try:
            reserved_stock = connection.execute(
                "SELECT stock_reserved FROM orders WHERE id = 1"
            ).fetchone()[0]
        finally:
            connection.close()
        self.assertEqual(reserved_stock, 0)

    def test_order_cannot_reserve_more_stock_than_available(self):
        product_id = self.add_product(stock={"P": 1, "M": 0, "G": 0, "GG": 0, "Único": 0})
        response = self.client.post(
            "/api/orders",
            json={
                "items": [{"productId": product_id, "quantity": 2, "size": "P"}],
                "buyerName": "Maria da Silva",
                "buyerPhone": "83999991234",
            },
            headers=self.headers,
        )
        self.assertEqual(response.status_code, 409)
        self.assertEqual(self.get_product(product_id)["stock"]["P"], 1)
        self.assertEqual(self.client.get("/api/admin/orders").get_json(), [])

    def test_bulk_validation_failure_rolls_back_products_and_images(self):
        products = [self.product_data(name=f"Produto {index}") for index in range(5)]
        products[-1]["category"] = "Categoria inválida"
        data = {"products": json.dumps(products)}
        for index in range(5):
            data[f"image-{index}"] = (io.BytesIO(PNG_BYTES), f"{index}.png", "image/png")

        response = self.client.post("/api/products/bulk", data=data, headers=self.headers)
        self.assertEqual(response.status_code, 400)
        self.assertEqual(self.client.get("/api/products").get_json(), [])
        self.assertEqual(list(store_app.UPLOAD_DIR.iterdir()), [])

    def test_bulk_creation_publishes_all_products(self):
        products = [self.product_data(name=f"Produto {index}") for index in range(5)]
        data = {"products": json.dumps(products)}
        for index in range(5):
            data[f"image-{index}"] = (io.BytesIO(PNG_BYTES), f"{index}.png", "image/png")

        response = self.client.post("/api/products/bulk", data=data, headers=self.headers)
        self.assertEqual(response.status_code, 201, response.get_json())
        self.assertEqual(len(response.get_json()["ids"]), 5)
        self.assertEqual(len(self.client.get("/api/products").get_json()), 5)
        self.assertEqual(len(list(store_app.UPLOAD_DIR.iterdir())), 5)

    def test_bulk_creation_accepts_forty_products(self):
        products = [self.product_data(name=f"Produto {index}") for index in range(40)]
        data = {"products": json.dumps(products)}
        for index in range(40):
            data[f"image-{index}"] = (io.BytesIO(PNG_BYTES), f"{index}.png", "image/png")

        response = self.client.post("/api/products/bulk", data=data, headers=self.headers)
        self.assertEqual(response.status_code, 201, response.get_json())
        self.assertEqual(len(response.get_json()["ids"]), 40)
        self.assertEqual(len(self.client.get("/api/products").get_json()), 40)


if __name__ == "__main__":
    unittest.main()
