/**
 * Inventory-Only 2-Way Sync: Marianatek <-> Webflow
 * Handles delta updates & manual restocks
 * With throttling, safe state, and robust retries
 */
const axios = require("axios");
const fs = require("fs");
require("dotenv").config();

const WEBFLOW_API_KEY = process.env.WEBFLOW_API_KEY;
const MARIANATEK_API_KEY = process.env.MARIANATEK_API_KEY;
const WEBFLOW_SKU_COLLECTION = process.env.WEBFLOW_SKU_COLLECTION;
const MAPPING_FILE = "./variant_mapping.json";
const SYNC_LOG = "./sync.log";
const STATE_FILE = "./lastSynced.json"; // persistent state
const BUFFER_MINUTES = 3;
const DEFAULT_LOCATION_ID = "48717"; // Winnipeg
const MAX_CONCURRENT = 3; // limit concurrent API calls

let lastSyncTimestamps = {};
let lastSynced = fs.existsSync(STATE_FILE)
  ? JSON.parse(fs.readFileSync(STATE_FILE))
  : {};

const sleep = (ms) => new Promise((res) => setTimeout(res, ms));
function saveState() {
  fs.writeFileSync(STATE_FILE, JSON.stringify(lastSynced, null, 2));
}
function logSync(direction, variantId, status, message) {
  const logEntry = `${new Date().toISOString()} | ${direction} | Variant: ${variantId} | ${status} | ${message}\n`;
  fs.appendFileSync(SYNC_LOG, logEntry);
  console.log(logEntry.trim());
}
function loadMapping() {
  return JSON.parse(fs.readFileSync(MAPPING_FILE, "utf8"));
}
function canSync(variantKey) {
  const now = Date.now();
  if (!lastSyncTimestamps[variantKey]) return true;
  const diffMinutes = (now - lastSyncTimestamps[variantKey]) / 60000;
  return diffMinutes > BUFFER_MINUTES;
}
function updateSyncTimestamp(variantKey) {
  lastSyncTimestamps[variantKey] = Date.now();
}
function getStateKey(webflowId, marianatekId) {
  return `${webflowId || ""}|${marianatekId || ""}`;
}

// Extract quantity from Marianatek safely
function getMarianatekQty(attrs, variantId) {
  let marianatekQty = null;
  if (Array.isArray(attrs.region_overrides)) {
    for (const region of attrs.region_overrides) {
      if (Array.isArray(region.location_overrides)) {
        for (const loc of region.location_overrides) {
          if (typeof loc.present_quantity === "number") {
            marianatekQty = loc.present_quantity;
            break;
          }
        }
      }
      if (marianatekQty !== null) break;
    }
  }
  if (marianatekQty === null && typeof attrs.inventory_quantity === "number") {
    marianatekQty = attrs.inventory_quantity;
    logSync("INFO", variantId, "WARNING", "Using fallback inventory_quantity");
  }
  return marianatekQty ?? 0;
}

// API wrapper with backoff
async function apiCall(fn, retries = 5, variantId = "GLOBAL") {
  try {
    return await fn();
  } catch (err) {
    const status = err.response?.status;
    if ((status === 429 || status === 500) && retries > 0) {
      const retryAfter = parseInt(err.response?.headers?.["retry-after"] || "1", 10) * 1000;
      logSync("API", variantId, "RETRY", `Retrying after ${retryAfter}ms due to ${status}`);
      await sleep(retryAfter);
      return apiCall(fn, retries - 1, variantId);
    }
    throw err;
  }
}

// Fetch Marianatek variants with retry
async function fetchAllMarianatekVariants() {
  let page = 1;
  let allVariants = [];
  let hasMore = true;
  while (hasMore) {
    const res = await apiCall(() => axios.get(
      `https://vaultcycleclub.marianatek.com/api/product_variants/?page=${page}`,
      { headers: { Authorization: `Bearer ${MARIANATEK_API_KEY}` }, timeout: 10000 }
    ), 3, `PAGE-${page}`);

    const { data, meta } = res.data || {};
    if (!data || !meta?.pagination) throw new Error("Invalid Marianatek response structure");

    allVariants = allVariants.concat(data);
    hasMore = page < meta.pagination.pages;
    page++;
    await sleep(300);
  }
  return allVariants;
}

// Fetch Webflow SKUs with pagination
async function fetchWebflowSkus() {
  let offset = 0;
  const limit = 100;
  let allSkus = [];
  let hasMore = true;
  while (hasMore) {
    const res = await apiCall(() => axios.get(
      `https://api.webflow.com/v2/collections/${WEBFLOW_SKU_COLLECTION}/items?limit=${limit}&offset=${offset}`,
      { headers: { Authorization: `Bearer ${WEBFLOW_API_KEY}` } }
    ), 3, `OFFSET-${offset}`);

    const { items, pagination } = res.data || {};
    if (!items || !pagination) throw new Error("Invalid Webflow response structure");

    allSkus = allSkus.concat(items);
    offset += limit;
    hasMore = offset < pagination.total;
    await sleep(300);
  }
  return allSkus;
}

// Fetch Webflow inventory
async function fetchWebflowInventory(itemId) {
  const res = await apiCall(() => axios.get(
    `https://api.webflow.com/v2/collections/${WEBFLOW_SKU_COLLECTION}/items/${itemId}/inventory`,
    { headers: { Authorization: `Bearer ${WEBFLOW_API_KEY}` } }
  ), 3, itemId);
  return res.data.quantity ?? 0;
}

// Update Webflow inventory
async function updateWebflowInventory(itemId, inventoryQty) {
  await apiCall(() => axios.patch(
    `https://api.webflow.com/v2/collections/${WEBFLOW_SKU_COLLECTION}/items/${itemId}/inventory`,
    { inventoryType: "finite", quantity: inventoryQty },
    { headers: { Authorization: `Bearer ${WEBFLOW_API_KEY}`, "Content-Type": "application/json" } }
  ), 3, itemId);
}

// Adjust Marianatek inventory
async function adjustMarianatekInventory(variantId, deltaQty, locationId = DEFAULT_LOCATION_ID) {
  await apiCall(() => axios.post(
    `https://vaultcycleclub.marianatek.com/api/product_variants/adjust_inventory`,
    { data: [{ variant_id: variantId, adjustments: [{ change_in_quantity: deltaQty, location_id: locationId }] }] },
    { headers: { Authorization: `Bearer ${MARIANATEK_API_KEY}`, "Content-Type": "application/vnd.api+json" } }
  ), 3, variantId);
}

// Marianatek → Webflow (restocks)
async function syncMarianatekToWebflow() {
  const mapping = loadMapping();
  const marianatekVariants = await fetchAllMarianatekVariants();
  console.log(`Fetched ${marianatekVariants.length} Marianatek variants`);

  for (const variant of marianatekVariants) {
    const attrs = variant.attributes;
    const marianatekQty = getMarianatekQty(attrs, variant.id);
    const mapEntry = mapping.find((m) => m.marianatek_variant_id === variant.id);
    if (!mapEntry) continue;

    const stateKey = getStateKey(mapEntry.webflow_variant_id, variant.id);
    if (!canSync(stateKey)) continue;

    try {
      const webflowQty = await fetchWebflowInventory(mapEntry.webflow_variant_id);
      const prev = lastSynced[stateKey] || { webflow: webflowQty, marianatek: marianatekQty };

   if (marianatekQty !== prev.marianatek) {
  await updateWebflowInventory(mapEntry.webflow_variant_id, marianatekQty);
  logSync(
    "Marianatek→Webflow",
    variant.id,
    "SUCCESS",
    `Updated Webflow to ${marianatekQty} (was ${prev.marianatek})`
  );
}


      lastSynced[stateKey] = { webflow: webflowQty, marianatek: marianatekQty };
      updateSyncTimestamp(stateKey);
      await sleep(300);
    } catch (err) {
      logSync("Marianatek→Webflow", variant.id, "ERROR", err.message);
    }
  }
}

// Webflow → Marianatek (sales)
async function syncWebflowToMarianatek() {
  const mapping = loadMapping();
  const webflowSkus = await fetchWebflowSkus();
  console.log(`Fetched ${webflowSkus.length} Webflow SKUs`);

  for (const sku of webflowSkus) {
    const mapEntry = mapping.find((m) => m.webflow_variant_id === sku.id);
    if (!mapEntry) continue;

    const stateKey = getStateKey(sku.id, mapEntry.marianatek_variant_id);
    if (!canSync(stateKey)) continue;

    try {
      const webflowQty = await fetchWebflowInventory(sku.id);
      const res = await apiCall(() => axios.get(
        `https://vaultcycleclub.marianatek.com/api/product_variants/${mapEntry.marianatek_variant_id}`,
        { headers: { Authorization: `Bearer ${MARIANATEK_API_KEY}` } }
      ), 3, mapEntry.marianatek_variant_id);
      const marianatekQty = getMarianatekQty(res.data.data.attributes, mapEntry.marianatek_variant_id);
      const prev = lastSynced[stateKey] || { webflow: webflowQty, marianatek: marianatekQty };

   const changeInWebflow = webflowQty - prev.webflow; // difference since last sync
    if (changeInWebflow !== 0) {
      await adjustMarianatekInventory(
        mapEntry.marianatek_variant_id,
        changeInWebflow,
        mapEntry.location_id || DEFAULT_LOCATION_ID
      );
      logSync(
        "Webflow→Marianatek",
        sku.id,
        "SUCCESS",
        `Adjusted Marianatek by ${changeInWebflow} (new Webflow qty: ${webflowQty})`
      );
    }

      lastSynced[stateKey] = { webflow: webflowQty, marianatek: marianatekQty };
      updateSyncTimestamp(stateKey);
      await sleep(300);
    } catch (err) {
      logSync("Webflow→Marianatek", sku.id, "ERROR", err.message);
    }
  }
}

// Scheduler
(async function runSync() {
  console.log("Starting inventory sync with throttling and safe state...");
  try {
    await syncMarianatekToWebflow();
    await syncWebflowToMarianatek();
    saveState();
  } catch (err) {
    logSync("SYSTEM", "GLOBAL", "ERROR", err.message);
  }
  setInterval(async () => {
    try {
      await syncMarianatekToWebflow();
      await syncWebflowToMarianatek();
      saveState();
    } catch (err) {
      logSync("SYSTEM", "GLOBAL", "ERROR", err.message);
    }
  }, 60000);
})();

