import { RewardProcessor} from "./RewardProcessor";
import { Config } from "./types";
import { readFileSync } from "fs";
import * as toml from "@iarna/toml";

const tomlConfig = readFileSync("config.toml", "utf-8");
const parsedConfig = toml.parse(tomlConfig) as Record<string, any>;

const config: Config = {
    nodeUrl: parsedConfig?.network?.node_url ?? "",
    indexerUrl: parsedConfig?.network?.indexer_url ?? "",
    privateKey: parsedConfig?.payment?.private_key ?? "",
    publicReference: parsedConfig?.payment?.public_reference ?? "",
    startDate: parsedConfig?.payment?.start_date ?? "",
    periodInSeconds: parsedConfig?.payment?.period_in_seconds ?? 120,
    dryRun: parsedConfig?.payment?.dry_run ?? false,
    excludedNodes: (parsedConfig?.node_pool?.excluded_nodes ?? []).map((s: string) =>
        s.toUpperCase()
    ),
};

if (config.nodeUrl === "") {
    throw new Error(`network.node_url is empty`);
}
if (config.indexerUrl === "") {
    throw new Error(`network.indexer_url is empty`);
}
if (config.privateKey === "") {
    throw new Error(`payment.private_key is empty`);
}
if (!/<NODE_ID>/.test(config.publicReference)) {
    throw new Error(`payment.public_reference is empty or does not contain <NODE_ID>`);
}
if (config.startDate === "") {
    throw new Error(`payment.start_date is empty`);
}

const processor = new RewardProcessor(config);

(async function() {
    await processor.loadPayer();
    await tick();
})();

async function tick() {
    try {
        await processor.tick();
    }
    catch (error) {
        console.error(error);
    }
    finally {
        setTimeout(tick, config.periodInSeconds * 1000);
    }
}
