const money = cents => new Intl.NumberFormat("pt-BR", { style: "currency", currency: "BRL" }).format(cents / 100);
const csrfToken = document.querySelector('meta[name="csrf-token"]').content;
const categoryNames = ["Todas", "Vestidos", "Blusas", "Calças", "Conjuntos", "Acessórios"];
const cartKey = "fabia-cart-v1";
const cartSizes = ["P", "M", "G", "GG", "Único"];
let products = [];
let cart = readCart();
let selectedCategory = "Todas";
let productsLoaded = false;
let catalogRefreshWarningShown = false;
let cartStorageWarningShown = false;
const lookSizes = {};
const failedTryOnImages = new Set();
let lookMounted = false;
let toastTimer;

function readCart() {
  try {
    const value = JSON.parse(localStorage.getItem(cartKey) || "[]");
    if (!Array.isArray(value)) return [];
    const items = new Map();
    for (const item of value) {
      if (!item || !Number.isInteger(item.productId) || item.productId < 1 ||
          !cartSizes.includes(item.size) || !Number.isInteger(item.quantity) || item.quantity < 1) continue;
      const key = `${item.productId}:${item.size}`;
      const existing = items.get(key);
      items.set(key, {
        productId: item.productId,
        size: item.size,
        quantity: Math.min(10000, (existing?.quantity || 0) + item.quantity),
      });
    }
    return [...items.values()].slice(0, 50);
  } catch {
    return [];
  }
}

function saveCart() {
  renderCart();
}

function persistCart() {
  try {
    localStorage.setItem(cartKey, JSON.stringify(cart));
    cartStorageWarningShown = false;
  } catch (error) {
    console.error("Não foi possível salvar a sacola neste navegador.", error);
    if (!cartStorageWarningShown) {
      cartStorageWarningShown = true;
      showToast("Não foi possível salvar a sacola neste navegador.");
    }
  }
}

function stockFor(product, size) {
  return Number(product.stock?.[size] || 0);
}

function availableSizes(product) {
  return Object.keys(product.stock || {}).filter(size => stockFor(product, size) > 0);
}

function productImage(product, className = "") {
  if (product.image) return `<img class="${className}" data-product-image alt="${escapeHtml(product.name)}" src="/static/uploads/${encodeURIComponent(product.image)}" loading="lazy">`;
  return `<div class="product-placeholder ${className}" aria-label="Foto de ${escapeHtml(product.name)}"><span>F</span></div>`;
}

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, char => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char]);
}

function renderCategories() {
  document.querySelector("#categoryFilters").innerHTML = categoryNames.map(category =>
    `<button class="filter-chip ${category === selectedCategory ? "active" : ""}" data-category="${category}">${category}</button>`
  ).join("");
}

function renderProducts() {
  const search = document.querySelector("#searchInput").value.trim().toLocaleLowerCase("pt-BR");
  const size = document.querySelector("#sizeFilter").value;
  const shown = products.filter(product =>
    (selectedCategory === "Todas" || product.category === selectedCategory) &&
    (!size || stockFor(product, size) > 0) &&
    (!search || `${product.name} ${product.description} ${product.category}`.toLocaleLowerCase("pt-BR").includes(search))
  );
  document.querySelector("#productCount").textContent = `${shown.length} ${shown.length === 1 ? "peça" : "peças"}`;
  const grid = document.querySelector("#productGrid");
  if (!shown.length) {
    grid.innerHTML = `<div class="empty-state">${products.length ? "Nenhuma peça encontrada com esses filtros." : "Nossa coleção está sendo preparada. Em breve, novidades por aqui."}</div>`;
    return;
  }
  grid.innerHTML = shown.map(product => {
    const sizes = availableSizes(product);
    const totalStock = Object.values(product.stock || {}).reduce((total, count) => total + Number(count), 0);
    const stockMessage = totalStock === 0 ? "ESGOTADO" : totalStock <= 3 ? `Últimas ${totalStock} unidades` : "";
    return `<article class="product-card" data-product="${product.id}">
      <button class="product-photo" data-action="quick" aria-label="Ver ${escapeHtml(product.name)}">${productImage(product)}<span class="category-tag">${escapeHtml(product.category)}</span>${stockMessage ? `<span class="stock-badge ${totalStock === 0 ? "sold-out" : ""}">${stockMessage}</span>` : ""}</button>
      <div class="product-info"><button class="product-name" data-action="quick">${escapeHtml(product.name)}</button><span class="product-price">${money(product.priceCents)}</span></div>
      <div class="product-bottom"><div class="size-chips">${sizes.length ? sizes.map(item => `<span>${escapeHtml(item)}</span>`).join("") : `<span class="muted">ESGOTADO</span>`}</div><button class="add-button" data-action="quick" ${sizes.length ? "" : "disabled"} aria-label="Escolher tamanho de ${escapeHtml(product.name)}">+</button></div>
    </article>`;
  }).join("");
}

function productCardClick(event) {
  const action = event.target.closest("[data-action]")?.dataset.action;
  if (!action) return;
  const product = products.find(item => item.id === Number(event.target.closest("[data-product]")?.dataset.product));
  if (!product) return;
  if (action === "quick") openQuickView(product);
}

function addToCart(product, size) {
  if (!size || stockFor(product, size) <= 0) return;
  const existing = cart.find(item => item.productId === product.id && item.size === size);
  if (existing) {
    if (existing.quantity >= stockFor(product, size)) return showToast("Você já adicionou todo o estoque disponível.");
    existing.quantity += 1;
  } else {
    if (cart.length >= 50) return showToast("A sacola pode conter até 50 combinações de peças e tamanhos.");
    cart.push({ productId: product.id, size, quantity: 1 });
  }
  saveCart();
  showToast(`${product.name} adicionado à sacola.`);
}

function openQuickView(product) {
  const sizes = availableSizes(product);
  document.querySelector("#quickContent").innerHTML = `<div class="quick-image">${productImage(product)}</div><div class="quick-copy"><p class="eyebrow">${escapeHtml(product.category)}</p><h2>${escapeHtml(product.name)}</h2><strong class="quick-price">${money(product.priceCents)}</strong><p>${escapeHtml(product.description || "Uma escolha especial da nossa coleção.")}</p>${sizes.length ? `<label class="select-label">Escolha o tamanho<select id="quickSize">${sizes.map(size => `<option value="${escapeHtml(size)}">${escapeHtml(size)} · ${stockFor(product, size)} disponível(is)</option>`).join("")}</select></label><button class="button button-dark" id="quickAdd">Adicionar à sacola <span>↗</span></button>` : `<p class="muted"><strong>ESGOTADO</strong> · Este produto está indisponível no momento.</p>`}</div>`;
  document.querySelector("#quickAdd")?.addEventListener("click", () => {
    addToCart(product, document.querySelector("#quickSize").value);
    document.querySelector("#quickView").close();
  });
  document.querySelector("#quickView").showModal();
}

function cartLine(product, item) {
  return `<article class="cart-line"><div class="cart-line-image">${productImage(product)}</div><div class="cart-line-details"><strong>${escapeHtml(product.name)}</strong><span>Tamanho ${escapeHtml(item.size)} · ${money(product.priceCents)}</span><div class="quantity-control"><button data-cart-action="decrease" data-id="${product.id}" data-size="${escapeHtml(item.size)}" aria-label="Diminuir">−</button><span>${item.quantity}</span><button data-cart-action="increase" data-id="${product.id}" data-size="${escapeHtml(item.size)}" aria-label="Aumentar">+</button><button class="remove-item" data-cart-action="remove" data-id="${product.id}" data-size="${escapeHtml(item.size)}">Remover</button></div></div></article>`;
}

function renderCart() {
  cart = cart.filter(item => products.some(product => product.id === item.productId && stockFor(product, item.size) > 0))
    .map(item => {
      const product = products.find(entry => entry.id === item.productId);
      return { ...item, quantity: Math.min(item.quantity, stockFor(product, item.size)) };
    }).filter(item => item.quantity > 0);
  const itemCount = cart.reduce((sum, item) => sum + item.quantity, 0);
  document.querySelector("#cartCount").textContent = itemCount;
  document.querySelector("#drawerCount").textContent = `(${itemCount})`;
  document.querySelector("#cartItems").innerHTML = cart.length ? cart.map(item => {
    const product = products.find(entry => entry.id === item.productId);
    return cartLine(product, item);
  }).join("") : `<div class="cart-empty"><span>♡</span><p>Sua sacola está esperando<br>por algo especial.</p><a href="#colecao" class="text-link" id="continueShopping">Ver a coleção ↗</a></div>`;
  const total = cart.reduce((sum, item) => sum + products.find(product => product.id === item.productId).priceCents * item.quantity, 0);
  document.querySelector("#cartTotal").textContent = money(total);
  document.querySelector("#checkoutButton").disabled = cart.length === 0;
  persistCart();
}

function updateCart(event) {
  const button = event.target.closest("[data-cart-action]");
  if (!button) return;
  const item = cart.find(entry => entry.productId === Number(button.dataset.id) && entry.size === button.dataset.size);
  const product = products.find(entry => entry.id === Number(button.dataset.id));
  if (!item || !product) return;
  if (button.dataset.cartAction === "remove") cart = cart.filter(entry => entry !== item);
  if (button.dataset.cartAction === "decrease") item.quantity -= 1;
  if (button.dataset.cartAction === "increase") {
    if (item.quantity >= stockFor(product, item.size)) return showToast("Você já adicionou todo o estoque disponível.");
    item.quantity += 1;
  }
  cart = cart.filter(entry => entry.quantity > 0);
  saveCart();
}

function setDrawer(open) {
  const drawer = document.querySelector("#cartDrawer");
  drawer.classList.toggle("open", open);
  drawer.setAttribute("aria-hidden", String(!open));
  document.querySelector("#drawerBackdrop").hidden = !open;
  document.body.classList.toggle("drawer-open", open);
}

function checkout() {
  if (!cart.length) return;
  document.querySelector("#buyerFormError").hidden = true;
  document.querySelector("#buyerDialog").showModal();
  document.querySelector('#buyerForm [name="buyerName"]').focus();
}

async function submitCheckout(event) {
  event.preventDefault();
  const button = document.querySelector("#checkoutButton");
  const hint = document.querySelector("#checkoutHint");
  const form = event.currentTarget;
  const buyerName = form.elements.buyerName.value.trim();
  const buyerPhone = form.elements.buyerPhone.value.trim();
  const errorBox = document.querySelector("#buyerFormError");
  const number = document.body.dataset.whatsapp.replace(/\D/g, "");
  if (!/^\d{10,15}$/.test(number)) {
    errorBox.textContent = "O WhatsApp da loja ainda não está configurado corretamente.";
    errorBox.hidden = false;
    return;
  }
  if (!cart.length || button.disabled) return;
  let buyerDigits = buyerPhone.replace(/\D/g, "");
  if ([10, 11].includes(buyerDigits.length)) buyerDigits = `55${buyerDigits}`;
  if (buyerName.length < 2 || buyerName.length > 80 || buyerDigits.length < 12 || buyerDigits.length > 15) {
    errorBox.textContent = "Confira seu nome e informe um WhatsApp válido com DDD.";
    errorBox.hidden = false;
    return;
  }
  const lines = cart.map(item => {
    const product = products.find(entry => entry.id === item.productId);
    return `• ${product.name} | Tam. ${item.size} | Qtd. ${item.quantity} | ${money(product.priceCents)} un.`;
  });
  const total = cart.reduce((sum, item) => sum + products.find(product => product.id === item.productId).priceCents * item.quantity, 0);
  const message = `Olá, Fábia! Sou ${buyerName} (${buyerDigits}) e quero fazer este pedido:\n\n${lines.join("\n")}\n\nTotal: ${money(total)}\n\nPode me ajudar com pagamento e entrega?`;
  const whatsappUrl = `https://wa.me/${number}?text=${encodeURIComponent(message)}`;
  const popup = window.open("about:blank", "_blank");
  button.disabled = true;
  document.querySelector("#buyerSubmit").disabled = true;
  errorBox.hidden = true;
  hint.textContent = "Registrando seu pedido…";
  try {
    const response = await fetch("/api/orders", {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-CSRF-Token": csrfToken },
      body: JSON.stringify({ items: cart, buyerName, buyerPhone: buyerDigits }),
    });
    let result;
    try {
      result = await response.json();
    } catch (error) {
      if (error instanceof SyntaxError) {
        throw new Error("A loja retornou uma resposta inválida. Sua sacola foi mantida; tente novamente.");
      }
      throw error;
    }
    if (!response.ok) throw new Error(result.error || "Não foi possível registrar o pedido.");
    hint.textContent = `Pedido #${result.orderId} enviado para combinar pelo WhatsApp.`;
    document.querySelector("#buyerDialog").close();
    form.reset();
    cart = [];
    saveCart();
    if (popup) {
      popup.opener = null;
      popup.location.href = whatsappUrl;
    } else {
      window.location.href = whatsappUrl;
    }
  } catch (error) {
    popup?.close();
    errorBox.textContent = error instanceof TypeError
      ? "Não foi possível conectar à loja. Sua sacola continua salva; tente novamente."
      : error.message;
    errorBox.hidden = false;
  } finally {
    button.disabled = cart.length === 0;
    document.querySelector("#buyerSubmit").disabled = false;
  }
}

function showToast(message) {
  const toast = document.querySelector("#toast");
  toast.textContent = message;
  toast.classList.add("visible");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toast.classList.remove("visible"), 2600);
}

function renderHotspots() {
  document.querySelectorAll(".hotspot").forEach(button => {
    const product = products[Number(button.dataset.productSlot)];
    button.hidden = !product;
    button.onclick = () => product && openQuickView(product);
  });
}

function selectedLookPieces() {
  return [...document.querySelectorAll("[data-look-slot]")].flatMap(select => {
    const product = products.find(item => item.id === Number(select.value));
    if (!product) return [];
    return [{ slot: select.dataset.lookSlot, product, size: lookSizes[select.dataset.lookSlot] || availableSizes(product)[0] }];
  });
}

function renderLookControls() {
  const slots = {
    dress: { category: "Vestidos", empty: "Escolha um vestido" },
    set: { category: "Conjuntos", empty: "Escolha um conjunto" },
    top: { category: "Blusas", empty: "Escolha uma blusa" },
    bottom: { category: "Calças", empty: "Escolha uma calça" },
    accessory: { category: "Acessórios", empty: "Escolha um acessório" },
  };
  for (const [slot, config] of Object.entries(slots)) {
    const select = document.querySelector(`[data-look-slot="${slot}"]`);
    const previousValue = select.value;
    const options = products.filter(product => product.category === config.category && availableSizes(product).length);
    select.innerHTML = `<option value="">${config.empty}</option>${options.map(product =>
      `<option value="${product.id}">${escapeHtml(product.name)} · ${money(product.priceCents)}</option>`
    ).join("")}`;
    if (options.some(product => String(product.id) === previousValue)) {
      select.value = previousValue;
      const currentProduct = options.find(product => product.id === Number(previousValue));
      if (!availableSizes(currentProduct).includes(lookSizes[slot])) {
        lookSizes[slot] = availableSizes(currentProduct)[0];
      }
    } else {
      delete lookSizes[slot];
    }
  }
  lookMounted = false;
  renderLookPreview();
  renderLookSummary();
}

function renderLookPreview() {
  const pieces = selectedLookPieces();
  const preview = document.querySelector("#lookPreview");
  const count = document.querySelector("#lookPreviewCount");
  const caption = document.querySelector("#lookPreviewCaption");
  const mountButton = document.querySelector("#mountLookButton");
  count.textContent = `${pieces.length} ${pieces.length === 1 ? "peça" : "peças"}`;
  mountButton.disabled = pieces.length === 0;
  mountButton.innerHTML = `${lookMounted ? "ATUALIZAR LOOK" : "MONTAR LOOK"} <span>✧</span>`;
  if (!pieces.length) {
    preview.innerHTML = `<div class="look-preview-empty"><span aria-hidden="true">✧</span><p>Seu look começa com uma escolha.</p><small>Escolha as peças e toque em “Montar look” para ver a composição.</small></div>`;
    caption.textContent = "Monte sua combinação sobre o manequim fantasma.";
    return;
  }
  if (!lookMounted) {
    preview.innerHTML = `<div class="look-preview-empty"><span aria-hidden="true">✧</span><p>${pieces.length} ${pieces.length === 1 ? "peça selecionada" : "peças selecionadas"}</p><small>Toque em “Montar look” para ver a composição no manequim fantasma.</small></div>`;
    caption.textContent = "Escolha suas peças e monte a composição.";
    return;
  }
  const layerClasses = {
    dress: "ghost-dress",
    set: "ghost-set",
    top: "ghost-top",
    bottom: "ghost-bottom",
    accessory: "ghost-accessory",
  };
  const garmentPieces = pieces.filter(({ product }) =>
    product.tryOnImage && !failedTryOnImages.has(`/static/uploads/${encodeURIComponent(product.tryOnImage)}`)
  );
  const missingPieces = pieces.filter(({ product }) => !garmentPieces.some(piece => piece.product.id === product.id));
  const layers = garmentPieces.map(({ slot, product }) =>
    `<img class="ghost-garment ${layerClasses[slot]}" src="/static/uploads/${encodeURIComponent(product.tryOnImage)}" alt="${escapeHtml(product.name)}" title="${escapeHtml(product.name)}" loading="eager">`
  ).join("");
  const missingMessage = missingPieces.length
    ? `<div class="ghost-missing" role="status">${missingPieces.length === 1
      ? `Falta o recorte transparente de ${escapeHtml(missingPieces[0].product.name)}.`
      : `Faltam recortes transparentes para ${missingPieces.map(({ product }) => escapeHtml(product.name)).join(", ")}.`}</div>`
    : "";
  preview.innerHTML = `<div class="ghost-stage"><img class="ghost-base" src="/static/media/ghost-mannequin.svg" alt="" aria-hidden="true"><div class="ghost-garments">${layers}</div>${missingMessage}</div>`;
  caption.textContent = garmentPieces.length
    ? `${garmentPieces.length} de ${pieces.length} peça(s) aplicada(s) · prévia ilustrativa.`
    : "Envie recortes PNG/WebP transparentes no cadastro para compor o manequim.";
}

function renderLookSummary() {
  const pieces = selectedLookPieces();
  const summary = document.querySelector("#lookSummary");
  const button = document.querySelector("#addLookButton");
  button.disabled = pieces.length === 0 || !lookMounted;
  if (!pieces.length) {
    summary.innerHTML = `<p>Suas peças escolhidas aparecerão aqui.</p>`;
    return;
  }
  summary.innerHTML = `${pieces.map(({ slot, product, size }) =>
    `<article class="look-piece"><div class="look-piece-image">${productImage(product)}</div><div class="look-piece-info"><strong>${escapeHtml(product.name)}</strong><span>${money(product.priceCents)}</span></div><label class="look-size-label">Tam.<select data-look-size="${slot}" aria-label="Tamanho para ${escapeHtml(product.name)}">${availableSizes(product).map(availableSize =>
      `<option value="${escapeHtml(availableSize)}" ${availableSize === size ? "selected" : ""}>${escapeHtml(availableSize)}</option>`
    ).join("")}</select></label></article>`
  ).join("")}<div class="look-subtotal"><span>${pieces.length} ${pieces.length === 1 ? "peça selecionada" : "peças selecionadas"}</span><strong>${money(pieces.reduce((total, piece) => total + piece.product.priceCents, 0))}</strong></div>`;
}

function addLookToCart() {
  const pieces = selectedLookPieces();
  if (!pieces.length) return;
  const requested = new Map();
  for (const { product, size } of pieces) {
    const key = `${product.id}:${size}`;
    requested.set(key, { product, size, quantity: (requested.get(key)?.quantity || 0) + 1 });
  }
  for (const { product, size, quantity } of requested.values()) {
    const inCart = cart.find(item => item.productId === product.id && item.size === size)?.quantity || 0;
    if (inCart + quantity > stockFor(product, size)) {
      showToast(`Estoque insuficiente para ${product.name} no tamanho ${size}.`);
      return;
    }
    const newCombinations = [...requested.values()].filter(({ product, size }) =>
      !cart.some(item => item.productId === product.id && item.size === size)
    ).length;
    if (cart.length + newCombinations > 50) {
      showToast("A sacola pode conter até 50 combinações de peças e tamanhos.");
      return;
    }
  }
  for (const { product, size, quantity } of requested.values()) {
    const existing = cart.find(item => item.productId === product.id && item.size === size);
    if (existing) existing.quantity += quantity;
    else cart.push({ productId: product.id, size, quantity });
  }
  saveCart();
  showToast(`${pieces.length} ${pieces.length === 1 ? "peça adicionada" : "peças adicionadas"} à sacola.`);
}

async function loadProducts() {
  let response;
  try {
    response = await fetch("/api/products", { cache: "no-store" });
  } catch (error) {
    if (error instanceof TypeError) {
      throw new Error("Não foi possível conectar à loja. Verifique a conexão e tente novamente.");
    }
    throw error;
  }
  if (!response.ok) throw new Error("Não foi possível carregar a coleção. Atualize a página para tentar novamente.");
  let updatedProducts;
  try {
    updatedProducts = await response.json();
  } catch (error) {
    if (error instanceof SyntaxError) {
      throw new Error("A loja retornou dados inválidos. Atualize a página para tentar novamente.");
    }
    throw error;
  }
  const changed = JSON.stringify(updatedProducts) !== JSON.stringify(products);
  products = updatedProducts;
  if (changed || !productsLoaded) {
    renderCategories();
    renderProducts();
    renderHotspots();
    renderLookControls();
  }
  productsLoaded = true;
  catalogRefreshWarningShown = false;
  renderCart();
}

document.addEventListener("error", event => {
  const image = event.target;
  if (!(image instanceof HTMLImageElement)) return;
  if (image.classList.contains("ghost-garment")) {
    failedTryOnImages.add(new URL(image.src).pathname);
    if (lookMounted) renderLookPreview();
    return;
  }
  if (!image.matches("[data-product-image]")) return;
  const placeholder = document.createElement("div");
  placeholder.className = `product-placeholder${image.classList.contains("look-preview-image") ? " look-preview-image" : ""}`;
  placeholder.setAttribute("role", "img");
  placeholder.setAttribute("aria-label", `Foto indisponível: ${image.alt}`);
  placeholder.innerHTML = "<span>F</span>";
  image.replaceWith(placeholder);
}, true);

function refreshCatalogInBackground() {
  loadProducts().catch(error => {
    console.error("Falha ao atualizar o catálogo público.", error);
    if (catalogRefreshWarningShown || !productsLoaded) return;
    catalogRefreshWarningShown = true;
    showToast("Não foi possível atualizar o catálogo. Verifique a conexão com a loja.");
  });
}

document.querySelector("#year").textContent = new Date().getFullYear();
document.querySelector("#productGrid").addEventListener("click", productCardClick);
document.querySelector("#categoryFilters").addEventListener("click", event => {
  const button = event.target.closest("[data-category]");
  if (!button) return;
  selectedCategory = button.dataset.category;
  renderCategories();
  renderProducts();
});
document.querySelector("#searchInput").addEventListener("input", renderProducts);
document.querySelector("#sizeFilter").addEventListener("change", renderProducts);
document.querySelector("#cartItems").addEventListener("click", event => {
  if (event.target.closest("#continueShopping")) setDrawer(false);
  updateCart(event);
});
document.querySelector("#cartOpen").addEventListener("click", () => setDrawer(true));
document.querySelector("#cartClose").addEventListener("click", () => setDrawer(false));
document.querySelector("#drawerBackdrop").addEventListener("click", () => setDrawer(false));
document.querySelector("#checkoutButton").addEventListener("click", checkout);
document.querySelector("#buyerForm").addEventListener("submit", submitCheckout);
document.querySelector("#buyerClose").addEventListener("click", () => document.querySelector("#buyerDialog").close());
document.querySelector("#buyerDialog").addEventListener("click", event => {
  if (event.target === event.currentTarget) event.currentTarget.close();
});
document.querySelector("#quickClose").addEventListener("click", () => document.querySelector("#quickView").close());
document.querySelector("#quickView").addEventListener("click", event => {
  if (event.target === event.currentTarget) event.currentTarget.close();
});
document.querySelectorAll("[data-look-slot]").forEach(select => {
  select.addEventListener("change", event => {
    const slot = event.currentTarget.dataset.lookSlot;
    const product = products.find(item => item.id === Number(event.currentTarget.value));
    if (product) {
      lookSizes[slot] = availableSizes(product)[0];
      const exclusiveSlots = {
        dress: ["set", "top", "bottom"],
        set: ["dress", "top", "bottom"],
        top: ["dress", "set"],
        bottom: ["dress", "set"],
        accessory: [],
      };
      for (const otherSlot of exclusiveSlots[slot]) {
        const otherSelect = document.querySelector(`[data-look-slot="${otherSlot}"]`);
        otherSelect.value = "";
        delete lookSizes[otherSlot];
      }
    }
    else delete lookSizes[slot];
    lookMounted = false;
    renderLookPreview();
    renderLookSummary();
  });
});
document.querySelector("#lookSummary").addEventListener("change", event => {
  const slot = event.target.dataset.lookSize;
  if (slot) lookSizes[slot] = event.target.value;
  renderLookSummary();
});
document.querySelector("#mountLookButton").addEventListener("click", () => {
  if (!selectedLookPieces().length) return;
  lookMounted = true;
  renderLookPreview();
  renderLookSummary();
});
document.querySelector("#addLookButton").addEventListener("click", addLookToCart);
loadProducts().catch(error => {
  document.querySelector("#productGrid").innerHTML = `<div class="empty-state error-state">${escapeHtml(error.message)}</div>`;
});
window.setInterval(() => {
  if (!document.hidden) refreshCatalogInBackground();
}, 15000);
document.addEventListener("visibilitychange", () => {
  if (!document.hidden) refreshCatalogInBackground();
});
window.addEventListener("focus", refreshCatalogInBackground);
