const csrf = document.querySelector('meta[name="csrf-token"]').content;
const formatMoney = cents => new Intl.NumberFormat("pt-BR", { style: "currency", currency: "BRL" }).format(cents / 100);
let products = [];
let orders = [];
let lowStockThreshold = 2;
let toastTimeout;
const sizes = ["P", "M", "G", "GG", "Único"];
let bulkRowCount = 0;
const minimumBulkRows = 5;
const maximumBulkRows = 40;

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, char => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char]);
}

async function api(url, options = {}) {
  let response;
  try {
    response = await fetch(url, {
      ...options,
      headers: { "X-CSRF-Token": csrf, ...(options.headers || {}) },
    });
  } catch (error) {
    if (error instanceof TypeError) {
      throw new Error("Não foi possível conectar ao servidor da loja. No terminal do projeto, execute `py app.py` e tente novamente.");
    }
    throw error;
  }
  let result = {};
  if (response.status !== 204) {
    try {
      result = await response.json();
    } catch (error) {
      if (error instanceof SyntaxError) {
        throw new Error(`O servidor não conseguiu processar a solicitação (HTTP ${response.status}). Tente novamente.`);
      }
      throw error;
    }
  }
  if (!response.ok) throw new Error(result.error || "Não foi possível concluir a operação.");
  return result;
}

function showAdminToast(message) {
  const toast = document.querySelector("#adminToast");
  toast.textContent = message;
  toast.classList.add("visible");
  clearTimeout(toastTimeout);
  toastTimeout = setTimeout(() => toast.classList.remove("visible"), 2800);
}

function renderProducts() {
  const list = document.querySelector("#adminProductList");
  const search = document.querySelector("#productSearch").value.trim().toLocaleLowerCase("pt-BR");
  const filtered = products.filter(product =>
    `${product.name} ${product.category} ${product.reference}`.toLocaleLowerCase("pt-BR").includes(search),
  );
  if (!products.length) {
    list.innerHTML = `<div class="empty-state">Ainda não há produtos cadastrados. Adicione a primeira peça da coleção.</div>`;
    return;
  }
  if (!filtered.length) {
    list.innerHTML = `<div class="empty-state">Nenhuma peça encontrada para essa busca.</div>`;
    return;
  }
  list.innerHTML = filtered.map(product => {
    const total = Object.values(product.stock).reduce((sum, quantity) => sum + Number(quantity), 0);
    return `<article class="admin-product-row"><div class="admin-product-thumb">${product.image ? `<img src="/static/uploads/${encodeURIComponent(product.image)}" alt="">` : `<span>F</span>`}</div><div class="admin-product-main"><strong>${escapeHtml(product.name)}</strong><span class="product-reference">Ref. ${escapeHtml(product.reference)}</span><span>${escapeHtml(product.category)} · ${formatMoney(product.priceCents)}</span><div class="admin-stock">${sizes.map(size => `<span>${size}: <b>${product.stock[size] || 0}</b></span>`).join("")}</div></div><span class="stock-total ${total === 0 ? "out" : ""}">${total === 0 ? "ESGOTADO" : `${total} un.`}</span><div class="row-actions"><button class="button button-outline" data-edit="${product.id}">Editar</button><button class="delete-button" data-delete="${product.id}">Remover produto</button></div></article>`;
  }).join("");
}

function renderOrders() {
  const list = document.querySelector("#ordersList");
  const pending = orders.filter(order => order.status === "pending").length;
  document.querySelector("#pendingCount").textContent = pending ? `(${pending})` : "";
  const search = document.querySelector("#orderSearch").value.trim().toLocaleLowerCase("pt-BR");
  const statusFilter = document.querySelector("#orderStatusFilter").value;
  const start = document.querySelector("#reportStart").value;
  const end = document.querySelector("#reportEnd").value;
  const filtered = orders.filter(order => {
    const date = order.createdAt.slice(0, 10);
    const searchable = `${order.id} ${order.buyerName} ${order.buyerPhone}`.toLocaleLowerCase("pt-BR");
    return (!search || searchable.includes(search)) &&
      (!statusFilter || order.status === statusFilter) &&
      (!start || date >= start) &&
      (!end || date <= end);
  });
  document.querySelector("#filteredOrderCount").textContent =
    `${filtered.length} ${filtered.length === 1 ? "pedido" : "pedidos"}`;
  if (!filtered.length) {
    list.innerHTML = `<div class="empty-state">${orders.length ? "Nenhum pedido corresponde aos filtros." : "Nenhum pedido recebido ainda."}</div>`;
    renderSalesMetrics();
    return;
  }
  list.innerHTML = filtered.map(order => {
    const buyerPhone = String(order.buyerPhone || "").replace(/\D/g, "");
    const buyerName = order.buyerName || "Pedido antigo sem identificação";
    const customer = `<div class="order-customer"><strong>${escapeHtml(buyerName)}</strong>${buyerPhone ? `<a href="https://wa.me/${buyerPhone}" target="_blank" rel="noopener noreferrer">${escapeHtml(order.buyerPhone)} · conversar ↗</a>` : `<span>WhatsApp não informado</span>`}</div>`;
    return `<article class="order-card"><div class="order-top"><div><strong>Pedido #${order.id}</strong><span>${new Date(`${order.createdAt.replace(" ", "T")}Z`).toLocaleString("pt-BR")}</span></div><span class="order-status ${order.status}">${{ pending: "Aguardando", confirmed: "Confirmado", completed: "Concluído", cancelled: "Cancelado" }[order.status] || order.status}</span></div>${customer}<div class="order-items">${order.items.map(item => `<div><span>${escapeHtml(item.name)} · ${escapeHtml(item.size)} × ${item.quantity}</span><strong>${formatMoney(item.lineTotalCents)}</strong></div>`).join("")}</div><div class="order-bottom"><span>Total do pedido</span><strong>${formatMoney(order.totalCents)}</strong></div>${order.status === "pending" ? `<div class="order-actions"><button class="button button-dark" data-confirm-order="${order.id}">Confirmar venda</button><button class="delete-button" data-cancel-order="${order.id}">Cancelar e devolver estoque</button></div>` : order.status === "confirmed" ? `<div class="order-actions"><button class="button button-outline" data-complete-order="${order.id}">Marcar como concluído</button></div>` : ""}</article>`;
  }).join("");
  renderSalesMetrics();
}

function renderSalesMetrics() {
  const start = document.querySelector("#reportStart").value;
  const end = document.querySelector("#reportEnd").value;
  const periodOrders = orders.filter(order => {
    const date = order.createdAt.slice(0, 10);
    return (!start || date >= start) && (!end || date <= end);
  });
  const confirmedOrders = periodOrders.filter(order => ["confirmed", "completed"].includes(order.status));
  const salesTotal = confirmedOrders.reduce((total, order) => total + order.totalCents, 0);
  const unitsSold = confirmedOrders.reduce(
    (total, order) => total + order.items.reduce((quantity, item) => quantity + item.quantity, 0),
    0,
  );
  document.querySelector("#metricOrderCount").textContent = periodOrders.length;
  document.querySelector("#metricPendingCount").textContent =
    periodOrders.filter(order => order.status === "pending").length;
  document.querySelector("#metricSalesTotal").textContent = formatMoney(salesTotal);
  document.querySelector("#metricUnitsSold").textContent = unitsSold;
}

function renderCustomers() {
  const list = document.querySelector("#customersList");
  const search = document.querySelector("#customerSearch").value.trim().toLocaleLowerCase("pt-BR");
  const grouped = new Map();
  for (const order of orders) {
    const phone = String(order.buyerPhone || "").replace(/\D/g, "");
    const key = phone || `legacy-${order.id}`;
    if (!grouped.has(key)) {
      grouped.set(key, {
        key,
        name: order.buyerName || "Pedido antigo sem identificação",
        phone,
        orders: [],
      });
    }
    grouped.get(key).orders.push(order);
  }
  const customers = [...grouped.values()]
    .filter(customer => `${customer.name} ${customer.phone}`.toLocaleLowerCase("pt-BR").includes(search))
    .sort((left, right) => left.name.localeCompare(right.name, "pt-BR"));
  if (!customers.length) {
    list.innerHTML = `<div class="empty-state">${orders.length ? "Nenhum cliente corresponde à busca." : "Ainda não há clientes identificados nos pedidos."}</div>`;
    return;
  }
  list.innerHTML = customers.map(customer => {
    const confirmedOrders = customer.orders.filter(order => ["confirmed", "completed"].includes(order.status));
    const confirmedTotal = confirmedOrders.reduce((total, order) => total + order.totalCents, 0);
    const lastOrder = customer.orders[0];
    return `<article class="customer-card"><div><strong>${escapeHtml(customer.name)}</strong>${customer.phone ? `<a href="https://wa.me/${customer.phone}" target="_blank" rel="noopener noreferrer">${escapeHtml(customer.phone)} · abrir WhatsApp ↗</a>` : `<span>Sem contato cadastrado</span>`}</div><dl><div><dt>Pedidos</dt><dd>${customer.orders.length}</dd></div><div><dt>Vendas confirmadas</dt><dd>${formatMoney(confirmedTotal)}</dd></div><div><dt>Último pedido</dt><dd>#${lastOrder.id}</dd></div></dl><button class="button button-outline" data-customer-history="${escapeHtml(customer.phone || customer.key)}">Ver pedidos</button></article>`;
  }).join("");
}

function renderLowStock() {
  document.querySelector("#lowStockThreshold").value = lowStockThreshold;
  const alerts = products.flatMap(product =>
    sizes.filter(size => Number(product.stock[size] || 0) <= lowStockThreshold)
      .map(size => ({ product, size, quantity: Number(product.stock[size] || 0) }))
  );
  const list = document.querySelector("#lowStockList");
  list.innerHTML = alerts.length
    ? alerts.map(({ product, size, quantity }) => `<div class="low-stock-item ${quantity === 0 ? "out" : ""}"><span>${escapeHtml(product.name)} · ${escapeHtml(size)}</span><strong>${quantity === 0 ? "Esgotado" : `${quantity} un.`}</strong></div>`).join("")
    : `<p class="low-stock-empty">Nenhum tamanho está abaixo do limite atual.</p>`;
}

function exportOrders() {
  const params = new URLSearchParams();
  const search = document.querySelector("#orderSearch").value.trim();
  const status = document.querySelector("#orderStatusFilter").value;
  const start = document.querySelector("#reportStart").value;
  const end = document.querySelector("#reportEnd").value;
  if (search) params.set("search", search);
  if (status) params.set("status", status);
  if (start) params.set("start", start);
  if (end) params.set("end", end);
  window.location.href = `/api/admin/orders.csv?${params}`;
}

function setAdminTab(name) {
  document.querySelectorAll(".admin-tab").forEach(button =>
    button.classList.toggle("active", button.dataset.tab === name)
  );
  document.querySelector("#productsPanel").hidden = name !== "products";
  document.querySelector("#ordersPanel").hidden = name !== "orders";
  document.querySelector("#customersPanel").hidden = name !== "customers";
}

function openProductForm(product = null) {
  const form = document.querySelector("#productForm");
  form.reset();
  form.elements.productId.value = product?.id || "";
  form.elements.name.value = product?.name || "";
  form.elements.reference.value = product?.reference || "";
  form.elements.description.value = product?.description || "";
  form.elements.price.value = product ? (product.priceCents / 100).toFixed(2) : "";
  form.elements.category.value = product?.category || "Vestidos";
  sizes.forEach(size => { form.elements[`stock-${size}`].value = product?.stock?.[size] || 0; });
  document.querySelector("#productFormTitle").textContent = product ? `Editar peça · ${product.reference}` : "Nova peça";
  document.querySelector("#productFormError").hidden = true;
  document.querySelector("#productDialog").showModal();
}

function updateBulkRows() {
  const rows = [...document.querySelectorAll(".bulk-product-row")];
  document.querySelector("#bulkProductCount").textContent = `(${rows.length})`;
  document.querySelector("#addBulkRowButton").disabled = rows.length >= maximumBulkRows;
  rows.forEach((row, index) => {
    row.querySelector("[data-row-number]").textContent = index + 1;
    row.querySelector("[data-remove-row]").disabled = rows.length <= minimumBulkRows;
  });
}

function addBulkRow() {
  if (bulkRowCount >= maximumBulkRows) return;
  const template = document.querySelector("#bulkProductTemplate");
  document.querySelector("#bulkProductRows").append(template.content.cloneNode(true));
  bulkRowCount += 1;
  updateBulkRows();
}

function openBulkProductsForm() {
  const rows = document.querySelector("#bulkProductRows");
  rows.replaceChildren();
  bulkRowCount = 0;
  for (let index = 0; index < minimumBulkRows; index += 1) addBulkRow();
  document.querySelector("#bulkFormError").hidden = true;
  document.querySelector("#bulkProductsDialog").showModal();
}

function applyLabelFields(scope, fields) {
  const updates = [];
  const setIfBlank = (selector, value, label) => {
    const input = scope.querySelector(selector);
    if (value && input && !input.value.trim()) {
      input.value = value;
      updates.push(label);
    }
  };
  setIfBlank('[name="name"], [data-field="name"]', fields.name, "nome");
  setIfBlank('[name="reference"], [data-field="reference"]', fields.reference, "referência");
  setIfBlank('[name="price"], [data-field="price"]', fields.price, "preço");

  if (fields.size) {
    const stockInput = [...scope.querySelectorAll("[name], [data-size]")].find(input =>
      input.name === `stock-${fields.size}` || input.dataset.size === fields.size
    );
    if (stockInput) {
      if (Number(stockInput.value) === 0) {
        stockInput.value = "1";
        updates.push(`tamanho ${fields.size} (1 unidade para revisar)`);
      } else {
        updates.push(`tamanho ${fields.size} reconhecido; estoque existente preservado`);
      }
    }
  }
  return updates;
}

async function readLabelForForm(form, button) {
  const status = form.querySelector("[data-label-status]");
  const image = form.querySelector("[data-label-image]").files[0];
  if (!image) {
    status.textContent = "Selecione primeiro a foto da etiqueta.";
    return;
  }
  if (image.size > 5 * 1024 * 1024) {
    status.textContent = "A foto da etiqueta deve ter no máximo 5 MB.";
    return;
  }
  button.disabled = true;
  button.textContent = "Lendo etiqueta…";
  status.textContent = "Preparando a leitura em português. Na primeira vez, o idioma pode demorar para carregar.";
  try {
    const fields = await window.ProductLabelReader.recognize(image);
    const updates = applyLabelFields(form, fields);
    if (!updates.length) {
      status.textContent = "Não identifiquei campos novos. Tente uma foto nítida, reta e bem iluminada; os dados digitados foram preservados.";
    } else {
      status.textContent = `Preenchido: ${updates.join(", ")}. Confira os dados antes de salvar.`;
    }
  } catch (error) {
    status.textContent = error.message || "Não foi possível ler a etiqueta. Tente novamente.";
  } finally {
    button.disabled = false;
    button.textContent = "Ler etiqueta e preencher";
  }
}

async function loadData() {
  const [productResult, orderResult, settingsResult] = await Promise.allSettled([
    api("/api/products"),
    api("/api/admin/orders"),
    api("/api/admin/settings"),
  ]);
  const errors = [];
  if (productResult.status === "fulfilled") {
    products = productResult.value;
    renderProducts();
    renderLowStock();
  } else {
    errors.push(`Produtos: ${productResult.reason.message}`);
    if (!products.length) {
      document.querySelector("#adminProductList").innerHTML =
        `<div class="empty-state error-state">${escapeHtml(productResult.reason.message)}</div>`;
    }
  }
  if (orderResult.status === "fulfilled") {
    orders = orderResult.value;
    renderOrders();
    renderCustomers();
  } else {
    errors.push(`Pedidos: ${orderResult.reason.message}`);
    if (!orders.length) {
      document.querySelector("#ordersList").innerHTML =
        `<div class="empty-state error-state">${escapeHtml(orderResult.reason.message)}</div>`;
    }
  }
  if (settingsResult.status === "fulfilled") {
    lowStockThreshold = settingsResult.value.lowStockThreshold;
    renderLowStock();
  } else {
    errors.push(`Configurações: ${settingsResult.reason.message}`);
  }
  if (errors.length) throw new Error(errors.join(" · "));
}

async function refreshAfterMutation() {
  try {
    await loadData();
  } catch (error) {
    showAdminToast(`Alteração salva, mas a lista não atualizou: ${error.message}`);
  }
}

document.querySelector("#adminDate").textContent = new Intl.DateTimeFormat("pt-BR", { dateStyle: "long" }).format(new Date());
document.querySelector("#newProductButton").addEventListener("click", () => openProductForm());
document.querySelector("#newBulkProductsButton").addEventListener("click", openBulkProductsForm);
document.querySelector("#refreshAdminButton").addEventListener("click", async event => {
  const button = event.currentTarget;
  button.disabled = true;
  try {
    await loadData();
    showAdminToast("Informações atualizadas.");
  } catch (error) {
    showAdminToast(error.message);
  } finally {
    button.disabled = false;
  }
});
document.querySelector("#orderSearch").addEventListener("input", renderOrders);
document.querySelector("#orderStatusFilter").addEventListener("change", renderOrders);
document.querySelector("#reportStart").addEventListener("change", () => {
  renderOrders();
  renderSalesMetrics();
});
document.querySelector("#reportEnd").addEventListener("change", () => {
  renderOrders();
  renderSalesMetrics();
});
document.querySelector("#clearReportDates").addEventListener("click", () => {
  document.querySelector("#reportStart").value = "";
  document.querySelector("#reportEnd").value = "";
  renderOrders();
  renderSalesMetrics();
});
document.querySelector("#exportOrdersButton").addEventListener("click", exportOrders);
document.querySelector("#customerSearch").addEventListener("input", renderCustomers);
document.querySelector("#lowStockThreshold").addEventListener("change", async event => {
  const input = event.currentTarget;
  const threshold = Number(input.value);
  if (!Number.isInteger(threshold) || threshold < 0 || threshold > 100) {
    input.value = lowStockThreshold;
    showAdminToast("O limite deve ficar entre 0 e 100 unidades.");
    return;
  }
  input.disabled = true;
  try {
    const result = await api("/api/admin/settings", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ lowStockThreshold: threshold }),
    });
    lowStockThreshold = result.lowStockThreshold;
    renderLowStock();
    showAdminToast("Limite de alerta de estoque atualizado.");
  } catch (error) {
    input.value = lowStockThreshold;
    showAdminToast(error.message);
  } finally {
    input.disabled = false;
  }
});
document.querySelector("#formClose").addEventListener("click", () => document.querySelector("#productDialog").close());
document.querySelector("#bulkFormClose").addEventListener("click", () => document.querySelector("#bulkProductsDialog").close());
document.querySelector("#addBulkRowButton").addEventListener("click", addBulkRow);
document.querySelector("#productDialog").addEventListener("click", event => {
  if (event.target === event.currentTarget) event.currentTarget.close();
});
document.querySelector("#bulkProductsDialog").addEventListener("click", event => {
  if (event.target === event.currentTarget) event.currentTarget.close();
});
document.querySelector("#bulkProductRows").addEventListener("click", event => {
  const readButton = event.target.closest("[data-read-label]");
  if (readButton) {
    readLabelForForm(readButton.closest(".bulk-product-row"), readButton);
    return;
  }
  if (!event.target.closest("[data-remove-row]") || bulkRowCount <= minimumBulkRows) return;
  event.target.closest(".bulk-product-row").remove();
  bulkRowCount -= 1;
  updateBulkRows();
});
document.querySelector("#productForm").addEventListener("submit", async event => {
  event.preventDefault();
  const form = event.currentTarget;
  const id = form.elements.productId.value;
  const data = new FormData();
  data.set("name", form.elements.name.value);
  data.set("reference", form.elements.reference.value);
  data.set("description", form.elements.description.value);
  data.set("price", form.elements.price.value);
  data.set("category", form.elements.category.value);
  const stock = Object.fromEntries(sizes.map(size => [size, form.elements[`stock-${size}`].value]));
  data.set("stock", JSON.stringify(stock));
  if (form.elements.image.files[0]) data.set("image", form.elements.image.files[0]);
  if (form.elements["tryon-image"].files[0]) data.set("tryon-image", form.elements["tryon-image"].files[0]);
  const submitButton = form.querySelector('button[type="submit"]');
  submitButton.disabled = true;
  submitButton.textContent = "Salvando…";
  try {
    await api(id ? `/api/products/${id}` : "/api/products", { method: id ? "PUT" : "POST", body: data });
    document.querySelector("#productDialog").close();
    showAdminToast(id ? "Produto atualizado." : "Produto cadastrado.");
    await refreshAfterMutation();
  } catch (error) {
    const errorBox = document.querySelector("#productFormError");
    errorBox.textContent = error.message;
    errorBox.hidden = false;
  } finally {
    submitButton.disabled = false;
    submitButton.innerHTML = "Salvar peça <span>↗</span>";
  }
});
document.querySelector("#productForm").addEventListener("click", event => {
  const button = event.target.closest("[data-read-label]");
  if (button) readLabelForForm(event.currentTarget, button);
});
document.querySelector("#bulkProductsForm").addEventListener("submit", async event => {
  event.preventDefault();
  const form = event.currentTarget;
  const rows = [...form.querySelectorAll(".bulk-product-row")];
  const submitButton = form.querySelector('button[type="submit"]');
  const errorBox = document.querySelector("#bulkFormError");
  errorBox.hidden = true;
  if (rows.length < minimumBulkRows || rows.length > maximumBulkRows) {
    errorBox.textContent = `Cadastre entre ${minimumBulkRows} e ${maximumBulkRows} peças por lote.`;
    errorBox.hidden = false;
    return;
  }
  const data = new FormData();
  const submittedProducts = rows.map((row, index) => {
    const stock = Object.fromEntries([...row.querySelectorAll("[data-size]")].map(input => [input.dataset.size, input.value]));
    const image = row.querySelector("[data-image]").files[0];
    const tryOnImage = row.querySelector("[data-tryon-image]").files[0];
    if (image) data.set(`image-${index}`, image);
    if (tryOnImage) data.set(`tryon-image-${index}`, tryOnImage);
    return {
      name: row.querySelector('[data-field="name"]').value,
      reference: row.querySelector('[data-field="reference"]').value,
      description: row.querySelector('[data-field="description"]').value,
      price: row.querySelector('[data-field="price"]').value,
      category: row.querySelector('[data-field="category"]').value,
      stock,
    };
  });
  data.set("products", JSON.stringify(submittedProducts));
  submitButton.disabled = true;
  submitButton.textContent = "Enviando peças…";
  try {
    const result = await api("/api/products/bulk", { method: "POST", body: data });
    document.querySelector("#bulkProductsDialog").close();
    showAdminToast(`${result.ids.length} peças cadastradas e publicadas na loja.`);
    await refreshAfterMutation();
  } catch (error) {
    errorBox.textContent = error.message;
    errorBox.hidden = false;
  } finally {
    submitButton.disabled = false;
    submitButton.innerHTML = "Cadastrar todas as peças <span>↗</span>";
  }
});
document.querySelector("#adminProductList").addEventListener("click", async event => {
  const editButton = event.target.closest("[data-edit]");
  const deleteButton = event.target.closest("[data-delete]");
  if (editButton) return openProductForm(products.find(product => product.id === Number(editButton.dataset.edit)));
  if (deleteButton) {
    const product = products.find(item => item.id === Number(deleteButton.dataset.delete));
    if (!window.confirm(`Remover "${product.name}" permanentemente do catálogo?`)) return;
    try {
      await api(`/api/products/${product.id}`, { method: "DELETE" });
      showAdminToast("Produto removido do catálogo.");
      await refreshAfterMutation();
    } catch (error) {
      showAdminToast(error.message);
    }
  }
});
document.querySelector("#productSearch").addEventListener("input", renderProducts);
document.querySelector("#adminProductList").addEventListener("error", event => {
  const image = event.target;
  if (!(image instanceof HTMLImageElement) || !image.closest(".admin-product-thumb")) return;
  const placeholder = document.createElement("span");
  placeholder.textContent = "F";
  image.replaceWith(placeholder);
}, true);
document.querySelector(".admin-tabs").addEventListener("click", event => {
  const tab = event.target.closest("[data-tab]");
  if (!tab) return;
  setAdminTab(tab.dataset.tab);
});
document.querySelector("#customersList").addEventListener("click", event => {
  const button = event.target.closest("[data-customer-history]");
  if (!button) return;
  const phone = button.dataset.customerHistory;
  if (phone.startsWith("legacy-")) return;
  document.querySelector("#orderSearch").value = phone;
  document.querySelector("#orderStatusFilter").value = "";
  setAdminTab("orders");
  renderOrders();
});
document.querySelector("#ordersList").addEventListener("click", async event => {
  const confirmButton = event.target.closest("[data-confirm-order]");
  const cancelButton = event.target.closest("[data-cancel-order]");
  const completeButton = event.target.closest("[data-complete-order]");
  const button = confirmButton || cancelButton || completeButton;
  if (!button) return;
  const status = confirmButton ? "confirmed" : cancelButton ? "cancelled" : "completed";
  const orderId = confirmButton?.dataset.confirmOrder || cancelButton?.dataset.cancelOrder || completeButton?.dataset.completeOrder;
  if (confirmButton && !window.confirm("Confirmar a venda? O estoque já foi reservado quando o pedido foi enviado.")) return;
  button.disabled = true;
  try {
    await api(`/api/admin/orders/${orderId}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ status }),
    });
    showAdminToast(status === "confirmed" ? "Pedido confirmado e estoque atualizado." : status === "cancelled" ? "Pedido cancelado." : "Pedido marcado como concluído.");
    await refreshAfterMutation();
  } catch (error) {
    showAdminToast(error.message);
  } finally {
    button.disabled = false;
  }
});

loadData().catch(error => showAdminToast(error.message));
