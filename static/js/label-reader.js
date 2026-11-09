(() => {
  let workerPromise;
  let recognitionQueue = Promise.resolve();

  function normalizeText(value) {
    return value.normalize("NFD").replace(/[\u0300-\u036f]/g, "").trim();
  }

  function parsePrice(value) {
    const text = value.replace(/\s/g, "");
    const separator = Math.max(text.lastIndexOf("."), text.lastIndexOf(","));
    const decimals = separator >= 0 ? text.length - separator - 1 : 0;
    const hasDecimals = decimals > 0 && decimals <= 2;
    const integer = hasDecimals
      ? text.slice(0, separator).replace(/[.,]/g, "")
      : text.replace(/[.,]/g, "");
    const fraction = hasDecimals ? text.slice(separator + 1) : "";
    const amount = Number(fraction ? `${integer}.${fraction}` : integer);
    return Number.isFinite(amount) && amount <= 999999 ? amount.toFixed(2) : "";
  }

  function extractLabelFields(text) {
    const lines = text.split(/\r?\n/).map(line => normalizeText(line)).filter(Boolean);
    const normalized = lines.map(line => line.toUpperCase());
    const fields = { name: "", reference: "", price: "", size: "" };

    for (const line of normalized) {
      const name = line.match(/^(?:NOME|PRODUTO|PECA)\s*[:\-]\s*(.{2,120})$/);
      if (name) {
        fields.name = name[1].trim();
        break;
      }
    }
    if (!fields.name) {
      const ignoredLine = /^(?:TAM(?:ANHO)?|SIZE|REF(?:ERENCIA)?|COD(?:IGO)?|SKU|PRECO|VALOR|MARCA|COR|COMPOSICAO)\b/;
      const candidate = normalized.find(line =>
        line.length >= 3 &&
        line.length <= 120 &&
        !ignoredLine.test(line) &&
        /[A-Z]{3,}/.test(line) &&
        !/^(?:R?\$?\s*)?[\d.,\s]+$/.test(line)
      );
      if (candidate) fields.name = candidate;
    }

    for (const line of normalized) {
      const reference = line.match(/^(?:REF(?:ERENCIA)?|COD(?:IGO)?|SKU)\s*[.:#\-]*\s*([A-Z0-9][A-Z0-9._/-]{0,49})$/);
      if (reference) {
        fields.reference = reference[1];
        break;
      }
    }

    const priceMatch = normalized.join("\n").match(
      /(?:R\$\s*|(?:PRECO|VALOR)\s*[:\-]\s*)((?:\d{1,3}(?:[.,]\d{3})+|\d+)(?:[.,]\d{1,2})?)/,
    );
    if (priceMatch) fields.price = parsePrice(priceMatch[1]);

    const sizesByLabel = { P: "P", M: "M", G: "G", GG: "GG", UNICO: "Único" };
    for (const line of normalized) {
      const match = line.match(/^(?:TAM(?:ANHO)?|SIZE)\s*[:\-]?\s*(UNICO|GG|G|M|P)\b/)
        || line.match(/^(UNICO|GG|G|M|P)$/);
      if (match) {
        fields.size = sizesByLabel[match[1]];
        break;
      }
    }
    return fields;
  }

  async function getWorker() {
    if (!window.Tesseract) {
      throw new Error("O leitor de etiquetas não carregou. Verifique a conexão e atualize a página.");
    }
    if (!workerPromise) workerPromise = window.Tesseract.createWorker("por");
    try {
      return await workerPromise;
    } catch (error) {
      workerPromise = undefined;
      throw error;
    }
  }

  async function recognize(file) {
    const task = recognitionQueue.then(async () => {
      const worker = await getWorker();
      const result = await worker.recognize(file);
      return extractLabelFields(result.data.text);
    });
    recognitionQueue = task.then(() => undefined, () => undefined);
    return task;
  }

  const root = typeof window === "undefined" ? globalThis : window;
  root.ProductLabelReader = { extractLabelFields, recognize };
  if (typeof module !== "undefined" && module.exports) {
    module.exports = { extractLabelFields };
  }
})();
