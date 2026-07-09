const locationCatalog = require("./locations.json");

function defaultLocationCities() {
  return locationCatalog.map((entry) => entry.city);
}

function normalizeLocationKey(value) {
  return String(value || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

function catalogEntryForLocation(value) {
  const key = normalizeLocationKey(value);
  return locationCatalog.find((entry) => normalizeLocationKey(entry.city) === key) || null;
}

function expectedAirportCount(locations) {
  return (Array.isArray(locations) ? locations : []).reduce((count, location) => {
    if (String(location || "").includes(",")) {
      return count + 1;
    }
    const entry = catalogEntryForLocation(location);
    return count + Math.max(1, entry?.airports?.length || 0);
  }, 0);
}

module.exports = {
  catalogEntryForLocation,
  defaultLocationCities,
  expectedAirportCount,
  locationCatalog,
  normalizeLocationKey
};
