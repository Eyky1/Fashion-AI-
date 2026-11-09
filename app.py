import csv
from datetime import date
import hmac
import io
import json
import os
import re
import secrets
import sqlite3
import time
import uuid
from contextlib import contextmanager
from decimal import Decimal, InvalidOperation
from functools import wraps
from pathlib import Path

from flask import Flask, abort, jsonify, make_response, redirect, render_template, request, session, url_for
from werkzeug.security import check_password_hash, generate_password_hash


BASE_DIR = Path(__file__).resolve().parent
DATABASE = Path(os.environ.get("FABIA_DATABASE", BASE_DIR / "instance" / "fabia.sqlite3"))
UPLOAD_DIR = BASE_DIR / "static" / "uploads"
SIZES = ("P", "M", "G", "GG", "Único")
CATEGORIES = ("Vestidos", "Blusas", "Calças", "Conjuntos", "Acessórios")
MIN_BULK_PRODUCTS = 5
MAX_BULK_PRODUCTS = 40

app = Flask(__name__)
app.config.update(
    SECRET_KEY=os.environ.get("FLASK_SECRET_KEY") or secrets.token_hex(32),
    MAX_CONTENT_LENGTH=MAX_BULK_PRODUCTS * 2 * 5 * 1024 * 1024 + 1024 * 1024,
    SESSION_COOKIE_HTTPONLY=True,
    SESSION_COOKIE_SAMESITE="Lax",
    SESSION_COOKIE_SECURE=os.environ.get("COOKIE_SECURE", "0") == "1",
    ADMIN_ENABLED=os.environ.get("ADMIN_ENABLED", "0") == "1",
)
UPLOAD_DIR.mkdir(parents=True, exist_ok=True)
DATABASE.parent.mkdir(parents=True, exist_ok=True)


@contextmanager
def db_connection():
    connection = sqlite3.connect(DATABASE)
    connection.row_factory = sqlite3.Row
    connection.execute("PRAGMA foreign_keys = ON")
    try:
        with connection:
            yield connection
    finally:
        connection.close()


def initialize_database():
    with db_connection() as connection:
        connection.executescript(
            """
            CREATE TABLE IF NOT EXISTS products (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                name TEXT NOT NULL,
                reference TEXT NOT NULL DEFAULT '',
                description TEXT NOT NULL DEFAULT '',
                price_cents INTEGER NOT NULL CHECK(price_cents >= 0),
                category TEXT NOT NULL,
                image TEXT,
                tryon_image TEXT,
                stock TEXT NOT NULL DEFAULT '{}',
                created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
            );
            CREATE TABLE IF NOT EXISTS orders (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                items TEXT NOT NULL,
                total_cents INTEGER NOT NULL,
                status TEXT NOT NULL DEFAULT 'pending',
                stock_reserved INTEGER NOT NULL DEFAULT 0,
                buyer_name TEXT NOT NULL DEFAULT '',
                buyer_phone TEXT NOT NULL DEFAULT '',
                created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
            );
            CREATE TABLE IF NOT EXISTS admin_credentials (
                id INTEGER PRIMARY KEY CHECK(id = 1),
                password_hash TEXT NOT NULL,
                updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
            );
            CREATE TABLE IF NOT EXISTS admin_login_attempts (
                address TEXT PRIMARY KEY,
                failures INTEGER NOT NULL DEFAULT 0,
                locked_until INTEGER NOT NULL DEFAULT 0
            );
            CREATE TABLE IF NOT EXISTS store_settings (
                setting_key TEXT PRIMARY KEY,
                setting_value TEXT NOT NULL
            );
            """
        )
        migrations = {
            "products": {"tryon_image": "TEXT", "reference": "TEXT NOT NULL DEFAULT ''"},
            "orders": {
                "stock_reserved": "INTEGER NOT NULL DEFAULT 0",
                "buyer_name": "TEXT NOT NULL DEFAULT ''",
                "buyer_phone": "TEXT NOT NULL DEFAULT ''",
            },
        }
        for table, columns in migrations.items():
            existing_columns = {
                row["name"] for row in connection.execute(f"PRAGMA table_info({table})")
            }
            for column, definition in columns.items():
                if column not in existing_columns:
                    connection.execute(f"ALTER TABLE {table} ADD COLUMN {column} {definition}")
        legacy_products = connection.execute(
            "SELECT id FROM products WHERE trim(reference) = '' ORDER BY id"
        ).fetchall()
        for product in legacy_products:
            reference = f"AUTO-{product['id']:06d}"
            suffix = 1
            while connection.execute(
                "SELECT 1 FROM products WHERE reference = ? COLLATE NOCASE",
                (reference,),
            ).fetchone():
                reference = f"AUTO-{product['id']:06d}-{suffix}"
                suffix += 1
            connection.execute(
                "UPDATE products SET reference = ? WHERE id = ?",
                (reference, product["id"]),
            )
        connection.execute(
            "CREATE UNIQUE INDEX IF NOT EXISTS products_reference_unique ON products(reference COLLATE NOCASE)"
        )
        connection.execute(
            """INSERT OR IGNORE INTO store_settings (setting_key, setting_value)
               VALUES ('low_stock_threshold', '2')"""
        )
        legacy_password = os.environ.get("ADMIN_PASSWORD")
        if legacy_password:
            connection.execute(
                """INSERT OR IGNORE INTO admin_credentials (id, password_hash)
                   VALUES (1, ?)""",
                (generate_password_hash(legacy_password),),
            )


initialize_database()


def csrf_token():
    if "csrf_token" not in session:
        session["csrf_token"] = secrets.token_urlsafe(32)
    return session["csrf_token"]


app.jinja_env.globals["csrf_token"] = csrf_token
app.jinja_env.globals["categories"] = CATEGORIES
app.jinja_env.globals["sizes"] = SIZES


@app.context_processor
def inject_store_settings():
    return {"whatsapp_number": os.environ.get("WHATSAPP_NUMBER", "")}


def has_admin_password():
    with db_connection() as connection:
        return connection.execute(
            "SELECT 1 FROM admin_credentials WHERE id = 1"
        ).fetchone() is not None


def is_local_request():
    return request.remote_addr in {"127.0.0.1", "::1"}


@app.after_request
def add_security_headers(response):
    response.headers["X-Content-Type-Options"] = "nosniff"
    response.headers["X-Frame-Options"] = "DENY"
    response.headers["Referrer-Policy"] = "strict-origin-when-cross-origin"
    response.headers["Permissions-Policy"] = "camera=(), microphone=(), geolocation=()"
    return response


@app.before_request
def disable_admin_routes_when_not_configured():
    if app.config["ADMIN_ENABLED"]:
        return None
    path = request.path
    admin_path = (
        path == "/admin"
        or path.startswith("/admin/")
        or path.startswith("/api/admin/")
        or (
            path == "/api/products"
            or path.startswith("/api/products/")
        )
        and request.method not in {"GET", "HEAD"}
    )
    if admin_path:
        abort(404)
    return None


def require_csrf(function):
    @wraps(function)
    def wrapped(*args, **kwargs):
        supplied = request.headers.get("X-CSRF-Token") or request.form.get("csrf_token", "")
        expected = session.get("csrf_token", "")
        if not expected or not hmac.compare_digest(supplied, expected):
            return jsonify(error="Token de segurança inválido. Atualize a página e tente novamente."), 400
        return function(*args, **kwargs)

    return wrapped


def require_admin(function):
    @wraps(function)
    def wrapped(*args, **kwargs):
        if not session.get("admin_authenticated"):
            return jsonify(error="Acesso não autorizado."), 401
        return function(*args, **kwargs)

    return wrapped


def product_to_dict(row, include_reference=False):
    product = {
        "id": row["id"],
        "name": row["name"],
        "description": row["description"],
        "priceCents": row["price_cents"],
        "category": row["category"],
        "image": row["image"],
        "tryOnImage": row["tryon_image"],
        "stock": json.loads(row["stock"]),
    }
    if include_reference:
        product["reference"] = row["reference"]
    return product


def parse_quantity(value, size):
    if isinstance(value, bool):
        raise ValueError(f"Informe uma quantidade válida para o tamanho {size}.")
    if isinstance(value, int):
        quantity = value
    elif isinstance(value, str) and re.fullmatch(r"\d+", value.strip()):
        quantity = int(value.strip())
    else:
        raise ValueError(f"Informe uma quantidade válida para o tamanho {size}.")
    if quantity < 0 or quantity > 10000:
        raise ValueError(f"A quantidade para {size} deve estar entre 0 e 10.000.")
    return quantity


def normalize_phone(value):
    digits = re.sub(r"\D", "", value)
    if len(digits) in {10, 11}:
        digits = f"55{digits}"
    if not 12 <= len(digits) <= 15:
        raise ValueError("Informe um WhatsApp válido com DDD e código do país.")
    return digits


def save_uploaded_image(uploaded):
    uploaded.seek(0, os.SEEK_END)
    if uploaded.tell() > 5 * 1024 * 1024:
        raise ValueError("A imagem deve ter no máximo 5 MB.")
    uploaded.seek(0)
    signature = uploaded.stream.read(12)
    uploaded.seek(0)
    if signature.startswith(b"\xff\xd8\xff"):
        extension = ".jpg"
    elif signature.startswith(b"\x89PNG\r\n\x1a\n"):
        extension = ".png"
    elif signature.startswith(b"RIFF") and signature[8:12] == b"WEBP":
        extension = ".webp"
    else:
        raise ValueError("Envie uma imagem JPG, PNG ou WebP válida.")

    image = f"{uuid.uuid4().hex}{extension}"
    try:
        uploaded.save(UPLOAD_DIR / image)
    except OSError:
        (UPLOAD_DIR / image).unlink(missing_ok=True)
        raise
    return image


def remove_image_if_unused(image):
    if not image:
        return
    if Path(image).name != image or "/" in image or "\\" in image:
        app.logger.warning("Ignorando nome de imagem inválido durante a limpeza.")
        return
    try:
        with db_connection() as connection:
            is_referenced = connection.execute(
                "SELECT 1 FROM products WHERE image = ? OR tryon_image = ? LIMIT 1",
                (image, image),
            ).fetchone()
        if not is_referenced:
            (UPLOAD_DIR / image).unlink(missing_ok=True)
    except (OSError, sqlite3.Error):
        app.logger.exception("Não foi possível remover a imagem sem uso %s.", image)


def cleanup_uploaded_images(image_names):
    for image_name in image_names:
        try:
            (UPLOAD_DIR / image_name).unlink(missing_ok=True)
        except OSError:
            app.logger.exception("Não foi possível limpar a imagem temporária %s.", image_name)


def parse_product(
    data,
    existing_image=None,
    existing_tryon_image=None,
    image_field="image",
    tryon_image_field="tryon-image",
    existing_product_id=None,
):
    if not hasattr(data, "get"):
        raise ValueError("Os dados da peça são inválidos.")
    name = str(data.get("name", "")).strip()
    reference = str(data.get("reference", "")).strip().upper()
    description = str(data.get("description", "")).strip()
    category = str(data.get("category", ""))
    if not name or len(name) > 120:
        raise ValueError("Informe um nome com até 120 caracteres.")
    if not reference or len(reference) > 50:
        raise ValueError("Informe uma referência com até 50 caracteres.")
    with db_connection() as connection:
        duplicate = connection.execute(
            """SELECT 1 FROM products
               WHERE reference = ? COLLATE NOCASE AND id != COALESCE(?, -1)
               LIMIT 1""",
            (reference, existing_product_id),
        ).fetchone()
    if duplicate:
        raise ValueError("Essa referência já está cadastrada. Informe outra.")
    if len(description) > 2000:
        raise ValueError("A descrição deve ter até 2.000 caracteres.")
    if category not in CATEGORIES:
        raise ValueError("Selecione uma categoria válida.")
    try:
        price = Decimal(str(data.get("price", "")))
        if not price.is_finite() or price < 0 or price > 999999:
            raise InvalidOperation
        cents = price * 100
        if cents != cents.to_integral_value():
            raise InvalidOperation
        price_cents = int(cents)
    except (InvalidOperation, TypeError, ValueError):
        raise ValueError("Informe um preço válido.")

    submitted_stock = data.get("stock", {})
    if isinstance(submitted_stock, str):
        try:
            submitted_stock = json.loads(submitted_stock)
        except json.JSONDecodeError:
            raise ValueError("A grade de estoque é inválida.")
    if not isinstance(submitted_stock, dict):
        raise ValueError("A grade de estoque é inválida.")
    stock = {}
    for size in SIZES:
        stock[size] = parse_quantity(submitted_stock.get(size, 0), size)

    image = existing_image
    tryon_image = existing_tryon_image
    newly_uploaded = []
    try:
        uploaded = request.files.get(image_field)
        if uploaded and uploaded.filename:
            image = save_uploaded_image(uploaded)
            newly_uploaded.append(image)
        tryon_upload = request.files.get(tryon_image_field)
        if tryon_upload and tryon_upload.filename:
            tryon_image = save_uploaded_image(tryon_upload)
            newly_uploaded.append(tryon_image)
    except (OSError, ValueError):
        cleanup_uploaded_images(newly_uploaded)
        raise

    return (
        name,
        description,
        price_cents,
        category,
        image,
        tryon_image,
        json.dumps(stock, ensure_ascii=False),
        reference,
    )


@app.get("/")
def storefront():
    return render_template("index.html")


@app.get("/admin")
def admin_page():
    if not session.get("admin_authenticated"):
        return redirect(url_for("login_page"))
    return render_template("admin.html")


@app.get("/admin/login")
def login_page():
    if not has_admin_password():
        return redirect(url_for("setup_page"))
    if session.get("admin_authenticated"):
        return redirect(url_for("admin_page"))
    return render_template("login.html")


@app.get("/admin/setup")
def setup_page():
    if has_admin_password():
        return redirect(url_for("login_page"))
    if not is_local_request():
        abort(403)
    return render_template("setup.html")


@app.post("/admin/setup")
@require_csrf
def setup_admin():
    if not is_local_request():
        abort(403)
    if has_admin_password():
        return redirect(url_for("login_page"))

    password = request.form.get("password", "")
    confirmation = request.form.get("confirm_password", "")
    if len(password) < 12:
        return render_template(
            "setup.html",
            error="Use uma senha com pelo menos 12 caracteres.",
        ), 400
    if len(password) > 128:
        return render_template(
            "setup.html",
            error="A senha deve ter no máximo 128 caracteres.",
        ), 400
    if not hmac.compare_digest(password.encode("utf-8"), confirmation.encode("utf-8")):
        return render_template("setup.html", error="As senhas não coincidem."), 400

    with db_connection() as connection:
        connection.execute("BEGIN IMMEDIATE")
        if connection.execute(
            "SELECT 1 FROM admin_credentials WHERE id = 1"
        ).fetchone():
            return redirect(url_for("login_page"))
        connection.execute(
            """INSERT INTO admin_credentials (id, password_hash)
               VALUES (1, ?)""",
            (generate_password_hash(password),),
        )
    return redirect(url_for("login_page"))


@app.post("/admin/login")
@require_csrf
def login():
    if not has_admin_password():
        return redirect(url_for("setup_page"))
    address = request.remote_addr or "unknown"
    now = int(time.time())
    with db_connection() as connection:
        attempt = connection.execute(
            "SELECT failures, locked_until FROM admin_login_attempts WHERE address = ?",
            (address,),
        ).fetchone()
        if attempt and attempt["locked_until"] > now:
            wait_minutes = max(1, (attempt["locked_until"] - now + 59) // 60)
            return render_template(
                "login.html",
                error=f"Muitas tentativas. Aguarde {wait_minutes} minuto(s) e tente novamente.",
            ), 429

    password = request.form.get("password", "")
    with db_connection() as connection:
        credential = connection.execute(
            "SELECT password_hash FROM admin_credentials WHERE id = 1"
        ).fetchone()
    if not credential or not check_password_hash(credential["password_hash"], password):
        failures = attempt["failures"] + 1 if attempt else 1
        locked_until = now + 15 * 60 if failures >= 5 else 0
        with db_connection() as connection:
            connection.execute(
                """INSERT INTO admin_login_attempts (address, failures, locked_until)
                   VALUES (?, ?, ?)
                   ON CONFLICT(address) DO UPDATE SET
                       failures = excluded.failures,
                       locked_until = excluded.locked_until""",
                (address, failures, locked_until),
            )
        return render_template("login.html", error="Senha incorreta. Tente novamente."), 401
    with db_connection() as connection:
        connection.execute("DELETE FROM admin_login_attempts WHERE address = ?", (address,))
    session.clear()
    session["admin_authenticated"] = True
    csrf_token()
    return redirect(url_for("admin_page"))


@app.post("/admin/logout")
@require_csrf
def logout():
    session.clear()
    return redirect(url_for("login_page"))


@app.get("/api/products")
def list_products():
    with db_connection() as connection:
        rows = connection.execute("SELECT * FROM products ORDER BY created_at DESC, id DESC").fetchall()
    include_reference = session.get("admin_authenticated", False)
    response = jsonify([
        product_to_dict(row, include_reference=include_reference) for row in rows
    ])
    response.headers["Cache-Control"] = "no-store"
    return response


@app.post("/api/products")
@require_admin
@require_csrf
def create_product():
    images = []
    try:
        fields = parse_product(request.form)
        images = [image for image in fields[4:6] if image]
        with db_connection() as connection:
            cursor = connection.execute(
                """INSERT INTO products
                   (name, description, price_cents, category, image, tryon_image, stock, reference)
                   VALUES (?, ?, ?, ?, ?, ?, ?, ?)""",
                fields,
            )
            product_id = cursor.lastrowid
    except ValueError as error:
        return jsonify(error=str(error)), 400
    except sqlite3.IntegrityError:
        cleanup_uploaded_images(images)
        return jsonify(error="Essa referência já está cadastrada. Informe outra."), 409
    except sqlite3.Error:
        cleanup_uploaded_images(images)
        app.logger.exception("Falha ao salvar produto.")
        return jsonify(error="Não foi possível salvar o produto. Tente novamente."), 500
    except OSError:
        cleanup_uploaded_images(images)
        app.logger.exception("Falha ao salvar a imagem do produto.")
        return jsonify(error="Não foi possível salvar a foto. Verifique o espaço disponível e tente novamente."), 500
    return jsonify(id=product_id), 201


@app.post("/api/products/bulk")
@require_admin
@require_csrf
def create_products_bulk():
    try:
        submitted = json.loads(request.form.get("products", ""))
    except json.JSONDecodeError:
        return jsonify(error="Os dados das peças estão inválidos."), 400
    if not isinstance(submitted, list) or not MIN_BULK_PRODUCTS <= len(submitted) <= MAX_BULK_PRODUCTS:
        return jsonify(
            error=f"Envie entre {MIN_BULK_PRODUCTS} e {MAX_BULK_PRODUCTS} peças por cadastro em lote."
        ), 400

    image_names = []
    fields_list = []
    seen_references = set()
    try:
        for index, data in enumerate(submitted):
            if not isinstance(data, dict):
                raise ValueError(f"Os dados da peça {index + 1} são inválidos.")
            image_field = f"image-{index}"
            if not request.files.get(image_field) or not request.files[image_field].filename:
                raise ValueError(f"Selecione uma foto para a peça {index + 1}.")
            fields = parse_product(
                data,
                image_field=image_field,
                tryon_image_field=f"tryon-image-{index}",
            )
            image_names.extend(image_name for image_name in fields[4:6] if image_name)
            reference = fields[-1]
            if reference.casefold() in seen_references:
                raise ValueError(f"A referência {reference} está repetida neste lote.")
            seen_references.add(reference.casefold())
            fields_list.append(fields)

        with db_connection() as connection:
            product_ids = []
            for fields in fields_list:
                cursor = connection.execute(
                    """INSERT INTO products
                           (name, description, price_cents, category, image, tryon_image, stock, reference)
                           VALUES (?, ?, ?, ?, ?, ?, ?, ?)""",
                    fields,
                )
                product_ids.append(cursor.lastrowid)
    except ValueError as error:
        cleanup_uploaded_images(image_names)
        return jsonify(error=str(error)), 400
    except sqlite3.IntegrityError:
        cleanup_uploaded_images(image_names)
        return jsonify(error="Uma referência informada já está cadastrada. Revise as referências e tente novamente."), 409
    except sqlite3.Error:
        cleanup_uploaded_images(image_names)
        app.logger.exception("Falha ao salvar cadastro de produtos em lote.")
        return jsonify(error="Não foi possível salvar as peças. Tente novamente."), 500
    except OSError:
        cleanup_uploaded_images(image_names)
        app.logger.exception("Falha ao salvar imagens do cadastro em lote.")
        return jsonify(error="Não foi possível salvar as fotos. Verifique o espaço disponível e tente novamente."), 500
    return jsonify(ids=product_ids), 201


@app.put("/api/products/<int:product_id>")
@require_admin
@require_csrf
def update_product(product_id):
    new_images = []
    old_images = []
    try:
        with db_connection() as connection:
            current = connection.execute("SELECT * FROM products WHERE id = ?", (product_id,)).fetchone()
            if current is None:
                return jsonify(error="Produto não encontrado."), 404
            old_images = [current["image"], current["tryon_image"]]
            fields = parse_product(
                request.form,
                current["image"],
                current["tryon_image"],
                existing_product_id=product_id,
            )
            new_images = [
                new_image for new_image, old_image in zip(fields[4:6], old_images)
                if new_image and new_image != old_image
            ]
            connection.execute(
                """UPDATE products SET name = ?, description = ?, price_cents = ?, category = ?,
                   image = ?, tryon_image = ?, stock = ?, reference = ?
                   WHERE id = ?""",
                (*fields, product_id),
            )
    except ValueError as error:
        return jsonify(error=str(error)), 400
    except sqlite3.IntegrityError:
        cleanup_uploaded_images(new_images)
        return jsonify(error="Essa referência já está cadastrada. Informe outra."), 409
    except sqlite3.Error:
        cleanup_uploaded_images(new_images)
        app.logger.exception("Falha ao atualizar produto.")
        return jsonify(error="Não foi possível atualizar o produto. Tente novamente."), 500
    except OSError:
        cleanup_uploaded_images(new_images)
        app.logger.exception("Falha ao salvar a imagem do produto.")
        return jsonify(error="Não foi possível salvar a foto. Verifique o espaço disponível e tente novamente."), 500
    for old_image in old_images:
        if old_image not in fields[4:6]:
            remove_image_if_unused(old_image)
    return jsonify(success=True)


@app.delete("/api/products/<int:product_id>")
@require_admin
@require_csrf
def delete_product(product_id):
    try:
        with db_connection() as connection:
            row = connection.execute(
                "SELECT image, tryon_image FROM products WHERE id = ?", (product_id,)
            ).fetchone()
            if row is None:
                return jsonify(error="Produto não encontrado."), 404
            pending_orders = connection.execute(
                "SELECT items FROM orders WHERE status = 'pending'"
            ).fetchall()
            if any(
                any(item["productId"] == product_id for item in json.loads(order["items"]))
                for order in pending_orders
            ):
                return jsonify(
                    error="Este produto está em um pedido aguardando. Confirme ou cancele o pedido antes de removê-lo."
                ), 409
            connection.execute("DELETE FROM products WHERE id = ?", (product_id,))
    except sqlite3.Error:
        app.logger.exception("Falha ao excluir produto.")
        return jsonify(error="Não foi possível excluir o produto. Tente novamente."), 500
    remove_image_if_unused(row["image"])
    remove_image_if_unused(row["tryon_image"])
    return jsonify(success=True)


@app.post("/api/orders")
@require_csrf
def create_order():
    payload = request.get_json(silent=True) or {}
    if not isinstance(payload, dict):
        return jsonify(error="Os dados do pedido são inválidos."), 400
    buyer_name = payload.get("buyerName")
    buyer_phone = payload.get("buyerPhone")
    if not isinstance(buyer_name, str) or not 2 <= len(buyer_name.strip()) <= 80:
        return jsonify(error="Informe seu nome (de 2 a 80 caracteres)."), 400
    if not isinstance(buyer_phone, str):
        return jsonify(error="Informe um número de WhatsApp válido."), 400
    try:
        buyer_phone = normalize_phone(buyer_phone)
    except ValueError as error:
        return jsonify(error=str(error)), 400
    buyer_name = buyer_name.strip()
    submitted_items = payload.get("items")
    if not isinstance(submitted_items, list) or not submitted_items or len(submitted_items) > 50:
        return jsonify(error="O carrinho está vazio ou contém itens demais."), 400

    quantities = {}
    for item in submitted_items:
        if not isinstance(item, dict):
            return jsonify(error="Um dos itens do pedido é inválido."), 400
        try:
            raw_product_id = item.get("productId")
            raw_quantity = item.get("quantity")
            if isinstance(raw_product_id, bool) or isinstance(raw_quantity, bool):
                raise ValueError
            if not isinstance(raw_product_id, int) and not (
                isinstance(raw_product_id, str) and re.fullmatch(r"\d+", raw_product_id)
            ):
                raise ValueError
            if not isinstance(raw_quantity, int) and not (
                isinstance(raw_quantity, str) and re.fullmatch(r"\d+", raw_quantity)
            ):
                raise ValueError
            product_id = int(raw_product_id)
            quantity = int(raw_quantity)
            size = str(item.get("size", ""))
        except (TypeError, ValueError):
            return jsonify(error="Um dos itens do pedido é inválido."), 400
        if product_id < 1 or size not in SIZES or quantity < 1 or quantity > 10000:
            return jsonify(error="Tamanho ou quantidade inválida."), 400
        key = (product_id, size)
        quantities[key] = quantities.get(key, 0) + quantity
        if quantities[key] > 10000:
            return jsonify(error="A quantidade por tamanho não pode exceder 10.000."), 400

    order_items = []
    total_cents = 0
    try:
        with db_connection() as connection:
            connection.execute("BEGIN IMMEDIATE")
            products_by_id = {}
            for (product_id, size), quantity in quantities.items():
                product = products_by_id.get(product_id)
                if product is None:
                    row = connection.execute(
                        "SELECT * FROM products WHERE id = ?", (product_id,)
                    ).fetchone()
                    if row is None:
                        return jsonify(error="Um produto do carrinho não está mais disponível."), 409
                    product = {"row": row, "stock": json.loads(row["stock"])}
                    products_by_id[product_id] = product
                row = product["row"]
                stock = product["stock"]
                if stock.get(size, 0) < quantity:
                    return jsonify(error=f"Estoque insuficiente para {row['name']} ({size})."), 409
                stock[size] -= quantity
                line_total = row["price_cents"] * quantity
                total_cents += line_total
                order_items.append({
                    "productId": product_id,
                    "name": row["name"],
                    "size": size,
                    "quantity": quantity,
                    "priceCents": row["price_cents"],
                    "lineTotalCents": line_total,
                    "image": row["image"],
                })
            for product_id, product in products_by_id.items():
                connection.execute(
                    "UPDATE products SET stock = ? WHERE id = ?",
                    (json.dumps(product["stock"], ensure_ascii=False), product_id),
                )
            cursor = connection.execute(
                """INSERT INTO orders (items, total_cents, buyer_name, buyer_phone, stock_reserved)
                   VALUES (?, ?, ?, ?, 1)""",
                (json.dumps(order_items, ensure_ascii=False), total_cents, buyer_name, buyer_phone),
            )
    except sqlite3.Error:
        app.logger.exception("Falha ao registrar pedido.")
        return jsonify(error="Não foi possível registrar o pedido. A sacola foi mantida; tente novamente."), 500
    return jsonify(orderId=cursor.lastrowid, totalCents=total_cents), 201


@app.get("/api/admin/orders")
@require_admin
def list_orders():
    try:
        with db_connection() as connection:
            rows = connection.execute("SELECT * FROM orders ORDER BY created_at DESC, id DESC").fetchall()
    except sqlite3.Error:
        app.logger.exception("Falha ao carregar pedidos do painel.")
        return jsonify(error="Não foi possível carregar os pedidos. Tente novamente."), 500
    response = jsonify([
        {
            "id": row["id"],
            "items": json.loads(row["items"]),
            "totalCents": row["total_cents"],
            "status": row["status"],
            "buyerName": row["buyer_name"],
            "buyerPhone": row["buyer_phone"],
            "createdAt": row["created_at"],
        }
        for row in rows
    ])
    response.headers["Cache-Control"] = "no-store"
    return response


@app.get("/api/admin/settings")
@require_admin
def admin_settings():
    try:
        with db_connection() as connection:
            row = connection.execute(
                "SELECT setting_value FROM store_settings WHERE setting_key = 'low_stock_threshold'"
            ).fetchone()
    except sqlite3.Error:
        app.logger.exception("Falha ao carregar configurações administrativas.")
        return jsonify(error="Não foi possível carregar as configurações. Tente novamente."), 500
    response = jsonify(lowStockThreshold=int(row["setting_value"]))
    response.headers["Cache-Control"] = "no-store"
    return response


@app.put("/api/admin/settings")
@require_admin
@require_csrf
def update_admin_settings():
    payload = request.get_json(silent=True)
    if not isinstance(payload, dict):
        return jsonify(error="As configurações enviadas são inválidas."), 400
    threshold = payload.get("lowStockThreshold")
    if isinstance(threshold, bool) or not isinstance(threshold, int) or not 0 <= threshold <= 100:
        return jsonify(error="O limite de alerta deve estar entre 0 e 100 unidades."), 400
    try:
        with db_connection() as connection:
            connection.execute(
                """UPDATE store_settings SET setting_value = ?
                   WHERE setting_key = 'low_stock_threshold'""",
                (str(threshold),),
            )
    except sqlite3.Error:
        app.logger.exception("Falha ao salvar configurações administrativas.")
        return jsonify(error="Não foi possível salvar as configurações. Tente novamente."), 500
    return jsonify(lowStockThreshold=threshold)


def validated_order_date(value, label):
    if not value:
        return None
    try:
        return date.fromisoformat(value).isoformat()
    except (TypeError, ValueError):
        raise ValueError(f"A data {label} é inválida.")


@app.get("/api/admin/orders.csv")
@require_admin
def export_orders_csv():
    try:
        start_date = validated_order_date(request.args.get("start"), "inicial")
        end_date = validated_order_date(request.args.get("end"), "final")
    except ValueError as error:
        return jsonify(error=str(error)), 400
    if start_date and end_date and start_date > end_date:
        return jsonify(error="A data inicial não pode ser posterior à data final."), 400
    status_filter = request.args.get("status", "")
    if status_filter and status_filter not in {"pending", "confirmed", "completed", "cancelled"}:
        return jsonify(error="O filtro de status é inválido."), 400
    search = request.args.get("search", "").strip().casefold()
    try:
        with db_connection() as connection:
            rows = connection.execute("SELECT * FROM orders ORDER BY created_at DESC, id DESC").fetchall()
    except sqlite3.Error:
        app.logger.exception("Falha ao carregar pedidos para exportação.")
        return jsonify(error="Não foi possível exportar os pedidos. Tente novamente."), 500

    def safe_cell(value):
        value = str(value)
        if value.lstrip().startswith(("=", "+", "-", "@", "\t", "\r")):
            return "'" + value
        return value

    output = io.StringIO(newline="")
    output.write("\ufeff")
    writer = csv.writer(output)
    writer.writerow([
        "Pedido", "Cliente", "WhatsApp", "Data", "Status",
        "Total (R$)", "Produtos e tamanhos",
    ])
    for row in rows:
        order_date = row["created_at"][:10]
        if start_date and order_date < start_date:
            continue
        if end_date and order_date > end_date:
            continue
        if status_filter and row["status"] != status_filter:
            continue
        searchable = f'{row["id"]} {row["buyer_name"]} {row["buyer_phone"]}'.casefold()
        if search and search not in searchable:
            continue
        items = json.loads(row["items"])
        details = "; ".join(
            f'{item["name"]} - {item["size"]} x {item["quantity"]}'
            for item in items
        )
        writer.writerow([
            row["id"],
            safe_cell(row["buyer_name"] or "Cliente antigo sem identificação"),
            safe_cell(row["buyer_phone"]),
            row["created_at"],
            row["status"],
            f'{row["total_cents"] / 100:.2f}',
            safe_cell(details),
        ])

    response = make_response(output.getvalue())
    response.headers["Content-Type"] = "text/csv; charset=utf-8"
    response.headers["Content-Disposition"] = 'attachment; filename="pedidos-fabia.csv"'
    response.headers["Cache-Control"] = "no-store"
    return response


@app.patch("/api/admin/orders/<int:order_id>")
@require_admin
@require_csrf
def update_order_status(order_id):
    payload = request.get_json(silent=True) or {}
    if not isinstance(payload, dict):
        return jsonify(error="Os dados do pedido são inválidos."), 400
    new_status = payload.get("status")
    if not isinstance(new_status, str) or new_status not in {"confirmed", "cancelled", "completed"}:
        return jsonify(error="Status de pedido inválido."), 400
    try:
        with db_connection() as connection:
            connection.execute("BEGIN IMMEDIATE")
            order = connection.execute("SELECT * FROM orders WHERE id = ?", (order_id,)).fetchone()
            if order is None:
                return jsonify(error="Pedido não encontrado."), 404
            allowed_transitions = {
                "pending": {"confirmed", "cancelled"},
                "confirmed": {"completed"},
            }
            if new_status not in allowed_transitions.get(order["status"], set()):
                return jsonify(error="Esta mudança não é permitida para o status atual do pedido."), 409
            items = json.loads(order["items"])
            if new_status == "confirmed" and not order["stock_reserved"]:
                for item in items:
                    product = connection.execute(
                        "SELECT stock, name FROM products WHERE id = ?", (item["productId"],)
                    ).fetchone()
                    if product is None:
                        return jsonify(error=f"O produto {item['name']} não existe mais no catálogo."), 409
                    stock = json.loads(product["stock"])
                    if stock.get(item["size"], 0) < item["quantity"]:
                        return jsonify(error=f"Estoque insuficiente para {item['name']} ({item['size']})."), 409
                for item in items:
                    product = connection.execute(
                        "SELECT stock FROM products WHERE id = ?", (item["productId"],)
                    ).fetchone()
                    stock = json.loads(product["stock"])
                    stock[item["size"]] -= item["quantity"]
                    connection.execute(
                        "UPDATE products SET stock = ? WHERE id = ?",
                        (json.dumps(stock, ensure_ascii=False), item["productId"]),
                    )
            if new_status == "cancelled" and order["stock_reserved"]:
                quantities = {}
                for item in items:
                    key = (item["productId"], item["size"])
                    quantities[key] = quantities.get(key, 0) + item["quantity"]
                products = {}
                for product_id, size in quantities:
                    if product_id not in products:
                        product = connection.execute(
                            "SELECT stock FROM products WHERE id = ?", (product_id,)
                        ).fetchone()
                        if product is None:
                            return jsonify(
                                error="Um produto do pedido não existe mais no catálogo; não foi possível devolver o estoque."
                            ), 409
                        products[product_id] = json.loads(product["stock"])
                    products[product_id][size] = products[product_id].get(size, 0) + quantities[
                        (product_id, size)
                    ]
                for product_id, stock in products.items():
                    connection.execute(
                        "UPDATE products SET stock = ? WHERE id = ?",
                        (json.dumps(stock, ensure_ascii=False), product_id),
                    )
            connection.execute("UPDATE orders SET status = ? WHERE id = ?", (new_status, order_id))
    except sqlite3.Error:
        app.logger.exception("Falha ao atualizar status do pedido.")
        return jsonify(error="Não foi possível atualizar o pedido. Tente novamente."), 500
    return jsonify(success=True)


@app.errorhandler(413)
def too_large(_error):
    if request.path.startswith("/api/"):
        return jsonify(error="O envio excede o limite permitido. Reduza o tamanho das imagens (máximo de 5 MB por imagem)."), 413
    return "O envio excede o limite permitido. Reduza o tamanho das imagens (máximo de 5 MB por imagem).", 413


if __name__ == "__main__":
    app.run(host="127.0.0.1", port=int(os.environ.get("PORT", "5000")), debug=False)
