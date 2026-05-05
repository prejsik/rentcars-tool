#!/usr/bin/env node

const path = require("path");
const { loadConfig, printHelp } = require("./config");
const { printSummary, writeCsvReport } = require("./report");

async function main() {
  try {
    const config = loadConfig(process.argv.slice(2));
    if (config.help) {
      printHelp();
      return;
    }

    console.log("RentCars.pl scraper started");
    console.log(`Locations: ${config.locations.join(", ")}`);
    console.log(`Pickup options: ${config.pickupDateOptions.join(", ")} ${config.pickupTime}`);
    console.log(`Drop-off time: ${config.dropoffTime}`);
    console.log(`Durations (days): ${config.durationDays.join(", ")}`);
    console.log(`Sort orders: ${config.sortOrders.join(", ")}`);
    console.log("");

    const { RentCarsScraper } = require("./scraper");
    const allResults = [];
    const allFailures = [];

    for (const pickupDate of config.pickupDateOptions) {
      for (const durationDays of config.durationDays) {
        const scenarioDropoffDate = addDaysToIsoDate(pickupDate, durationDays);
        const scenarioConfig = {
          ...config,
          pickupDate,
          dropoffDate: scenarioDropoffDate,
          artifactsDir: path.join(config.artifactsDir, `start-${pickupDate}`, `days-${durationDays}`)
        };

        console.log(
          `Duration ${durationDays} day${durationDays === 1 ? "" : "s"}: `
          + `${scenarioConfig.pickupDate} ${scenarioConfig.pickupTime} -> `
          + `${scenarioConfig.dropoffDate} ${scenarioConfig.dropoffTime}`
        );

        const scraper = new RentCarsScraper(scenarioConfig);
        const { results, failures } = await scraper.run();

        allResults.push(
          ...results.map((item) => ({
            ...item,
            durationDays,
            pickupDate: scenarioConfig.pickupDate,
            dropoffDate: scenarioConfig.dropoffDate
          }))
        );

        allFailures.push(
          ...failures.map((item) => ({
            ...item,
            durationDays,
            pickupDate: scenarioConfig.pickupDate,
            dropoffDate: scenarioConfig.dropoffDate
          }))
        );

        console.log("");
      }
    }

    console.log("");
    printSummary(allResults, allFailures);

    const csvPath = writeCsvReport(config.outputCsv, allResults);
    console.log("");
    console.log(`CSV saved to: ${csvPath}`);

    if (!allResults.length) {
      process.exitCode = 1;
    }
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}

function addDaysToIsoDate(dateString, daysToAdd) {
  const baseDate = new Date(`${dateString}T00:00:00Z`);
  baseDate.setUTCDate(baseDate.getUTCDate() + daysToAdd);
  return baseDate.toISOString().slice(0, 10);
}

main();
