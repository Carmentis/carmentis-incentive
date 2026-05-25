import { RewardProcessor} from "./RewardProcessor";
import { Config } from "./types";
import { readFileSync } from "fs";
import * as toml from "@iarna/toml";

const tomlConfig = readFileSync("config.toml", "utf-8");
const parsedConfig = toml.parse(tomlConfig) as Record<string, any>;

const config: Config = {
    nodeUrl: parsedConfig.network.node_url || "",
    indexerUrl: parsedConfig.network.indexer_url || "",
    privateKey: parsedConfig.payment.private_key || "",
    publicReference: parsedConfig.payment.public_reference || "",
};

const processor = new RewardProcessor(config);
const INTERVAL = 2 * 60 * 1000;

(async function() {
    await processor.loadPayer();
    await scheduler();
})();

async function scheduler() {
    try {
        await processor.tick();
    }
    catch (error) {
        console.error(error);
    }
    finally {
        setTimeout(scheduler, INTERVAL);
    }
}
